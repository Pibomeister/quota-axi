import {
  deleteCachedProvider as deleteCachedProviderFromDisk,
  readCachedDroidProvider as readCachedProviderFromDisk,
} from "../cache.js";
import { providerFetch, readBoundedResponseBody } from "../lib/http.js";
import { retryAfterToIso } from "../lib/time.js";
import type {
  AuthProviderReport,
  AuthSourceReport,
  ProviderAdapter,
  ProviderAuthStatus,
  ProviderOptions,
  ProviderQuota,
  ProviderStateReason,
  ProviderStatus,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import { VERSION } from "../version.js";
import {
  servableStaleWindows,
  servableUntrustedWindowIds,
  withRemaining,
} from "./common.js";
import {
  selectCredential,
  type AttemptOutcome,
  type CandidateResult,
  type CredentialCandidate,
} from "./credential-selection.js";
import {
  clearDroidReadingContextId,
  droidCacheContextId,
  publishDroidReadingContextId,
} from "./droid-cache-context.js";
import {
  createDroidApiKeySource,
  createDroidKeychainSource,
  createDroidKeyfileSource,
  type DroidCredentialSource,
  type DroidLocalResolution,
} from "./droid-credential.js";

/**
 * Factory's own usage endpoint. The Droid CLI calls the same path for its
 * `/status` and limit prompts (`GET /api/billing/limits`), and the response
 * reports two independent token-rate-limit pools: `limits.core` (Droid Core,
 * the open-weight models such as Kimi and GLM) and `limits.standard` (every
 * other model: OpenAI, Anthropic, Google). Each pool has its own rolling
 * five-hour, weekly, and monthly windows.
 */
export const DROID_API_ORIGIN = "https://api.factory.ai";
export const DROID_LIMITS_PATH = "/api/billing/limits";

/**
 * Ownership-stability order. The Droid CLI's own sign-in store comes first
 * (Keychain, then its key file), because it is the credential the CLI itself
 * sends to this endpoint. `FACTORY_API_KEY` is the explicitly exported
 * alternative and is consulted only when the CLI's store is absent or its token
 * is rejected.
 */
const DROID_SOURCE_ORDER = [
  createDroidKeychainSource,
  createDroidKeyfileSource,
  createDroidApiKeySource,
] as const;

/**
 * The two pools, published as separate scopes. `vendorKey` is the field Factory
 * uses in its response; `scope` is what quota-axi reports. They are never summed
 * or folded: the vendor meters them independently, so one can be nearly spent
 * while the other is nearly untouched.
 */
export const DROID_POOLS = [
  {
    vendorKey: "core",
    scope: "droid_core",
    label: "Droid Core",
  },
  {
    vendorKey: "standard",
    scope: "other_models",
    label: "Other models",
  },
] as const;

const PERIODS = [
  {
    vendorKey: "fiveHour",
    suffix: "5h",
    label: "5-hour",
    kind: "session",
    windowSeconds: 18_000,
  },
  {
    vendorKey: "weekly",
    suffix: "weekly",
    label: "weekly",
    kind: "weekly",
    windowSeconds: 604_800,
  },
  // The monthly window is a billing cycle whose start the endpoint does not
  // report, so it carries a reset but no length or start.
  {
    vendorKey: "monthly",
    suffix: "monthly",
    label: "monthly",
    kind: "monthly",
    windowSeconds: undefined,
  },
] as const;

const LABEL = "Factory Droid";
const OPERATION_DEADLINE_MS = 15_000;
const USER_AGENT = `quota-axi/${VERSION}`;

/**
 * The only response keys that survive parsing. The body also carries the
 * account's extra-usage balance and overage preference; a JSON reviver drops
 * every key outside this set while it is parsed.
 */
const RESPONSE_KEYS = new Set([
  "usesTokenRateLimitsBilling",
  "limits",
  "standard",
  "core",
  "fiveHour",
  "weekly",
  "monthly",
  "usedPercent",
  "windowEnd",
]);

export type NormalizedDroidPayload = {
  windows: QuotaWindow[];
  untrustedWindowIds: string[];
};

type DroidDependencies = {
  sources: readonly DroidCredentialSource[];
  fetch: typeof globalThis.fetch;
  readCachedProvider: (contextId: string) => ProviderQuota | undefined;
  deleteCachedProvider: () => void;
  now: () => number;
  deadlineMs: number;
};

type DroidFailureOptions = {
  status?: ProviderStatus;
  staleEligible?: boolean;
  definitiveAuth?: boolean;
  authUsable?: boolean;
  retryAfter?: string;
};

type DroidCandidate = { credential: string; contextId: string | undefined };

export function createDroidAdapter(
  overrides: Partial<DroidDependencies> = {},
): ProviderAdapter {
  const dependencies: DroidDependencies = {
    sources: DROID_SOURCE_ORDER.map((create) => create()),
    fetch: providerFetch,
    readCachedProvider: readCachedProviderFromDisk,
    deleteCachedProvider: () => deleteCachedProviderFromDisk("droid"),
    now: Date.now,
    deadlineMs: OPERATION_DEADLINE_MS,
    ...overrides,
  };
  return {
    id: "droid",
    label: LABEL,
    fetchQuota: (options) => acquireDroidQuota(dependencies, options),
    inspectAuth: (options) => inspectAuth(dependencies, options),
  };
}

export const droidAdapter = createDroidAdapter();

/** Local only: `auth` never contacts Factory. */
async function inspectAuth(
  dependencies: DroidDependencies,
  options: ProviderOptions,
): Promise<AuthProviderReport> {
  const sources: AuthSourceReport[] = [];
  for (const source of dependencies.sources) {
    const resolution = await resolveSource(
      source,
      options,
      !options.allowKeychainPrompt,
    );
    const path = safeLocation(source);
    sources.push({
      source: source.name,
      ...(path ? { path } : {}),
      ...(resolution.status === "resolved"
        ? {
            status: resolution.expired
              ? ("expired" as const)
              : ("available" as const),
            credentialPresent: true,
          }
        : resolution.status === "absent"
          ? { status: "missing" as const }
          : resolution.status === "skipped"
            ? {
                status: "skipped" as const,
                error: resolution.error,
                credentialPresent: true,
              }
            : resolution.status === "read_error"
              ? {
                  status: "error" as const,
                  error: resolution.error,
                  credentialPresent: true,
                }
              : {
                  status: "invalid" as const,
                  error: resolution.error,
                  credentialPresent: true,
                }),
    });
  }
  return { provider: "droid", sources };
}

async function acquireDroidQuota(
  dependencies: DroidDependencies,
  options: ProviderOptions,
): Promise<ProviderQuota> {
  clearDroidReadingContextId();
  const localAttempts = new Map<string, SourceAttempt>();
  const candidates: CredentialCandidate<DroidCandidate>[] = [];
  let localError: string | undefined;
  let skippedCredentialError: string | undefined;

  for (const source of dependencies.sources) {
    const resolution = await resolveSource(source, options);
    if (resolution.status === "resolved") {
      candidates.push({
        source: source.name,
        localState: resolution.expired ? "expired" : "valid",
        refreshable: resolution.expired && resolution.refreshable,
        credential: {
          credential: resolution.credential,
          contextId: contextIdFor(resolution),
        },
      });
      continue;
    }
    if (resolution.status === "absent") {
      localAttempts.set(source.name, {
        source: source.name,
        status: "skipped",
      });
      continue;
    }
    if (resolution.status === "skipped") {
      // A present credential quota-axi may not read (a Keychain prompt the
      // caller has not granted) is not a broken store and never a sign-out.
      skippedCredentialError ??= resolution.error;
      localAttempts.set(source.name, {
        source: source.name,
        status: "skipped",
        error: resolution.error,
        credentialPresent: true,
      });
      continue;
    }
    localError ??= resolution.error;
    localAttempts.set(source.name, {
      source: source.name,
      status: "failed",
      error: resolution.error,
      credentialPresent: true,
    });
  }

  const failures = new Map<string, DroidFailure>();
  const contexts = new Map<string, string | undefined>();
  const selection = await selectCredential<DroidCandidate, DroidReading>(
    candidates,
    async (candidate) => {
      contexts.set(candidate.source, candidate.credential.contextId);
      const outcome = await attemptCandidate(candidate, dependencies);
      if (outcome.failure) failures.set(candidate.source, outcome.failure);
      return outcome.outcome;
    },
  );
  const attempts = orderedAttempts(
    dependencies.sources,
    localAttempts,
    selection.results,
  );
  const sourcesTried = attempts.map(({ source }) => source);

  if (selection.outcome === "quota" && selection.winner && selection.result) {
    const contextId = contexts.get(selection.winner.source);
    if (contextId) publishDroidReadingContextId(contextId);
    return freshReport(selection.result, attempts, sourcesTried);
  }

  if (selection.outcome === "transient") {
    const transient = selection.results.find(
      ({ outcome }) => outcome === "transient",
    );
    const failure =
      (transient && failures.get(transient.source)) ??
      new DroidFailure(selection.transientError ?? "provider_unavailable", {
        staleEligible: true,
      });
    const contextId = transient && contexts.get(transient.source);
    if (contextId) publishDroidReadingContextId(contextId);
    return failureReport(failure, contextId, attempts, dependencies);
  }

  if (skippedCredentialError) {
    // A present credential that may not be read without a granted prompt says
    // nothing about sign-in state; report the blocked read, never a sign-out.
    return failureReport(
      new DroidFailure(skippedCredentialError, {
        staleEligible: true,
        ...(skippedCredentialError === "keychain_prompt_required"
          ? { reason: "keychain_access_required" as const }
          : {}),
      }),
      undefined,
      attempts,
      dependencies,
    );
  }

  if (localError) {
    // A present store that could not be read or parsed is not sign-out: the
    // user may still be signed in, and the file error is the report.
    return failureReport(
      new DroidFailure(localError),
      undefined,
      attempts,
      dependencies,
    );
  }

  if (selection.outcome === "all_rejected") {
    const refreshable = selection.refreshable;
    const failure = refreshable
      ? new DroidFailure("droid_access_token_rejected", {
          status: "unavailable",
          staleEligible: true,
          reason: "credentials_expired",
        })
      : new DroidFailure("droid_access_token_rejected", {
          status: "auth_required",
          definitiveAuth: true,
        });
    if (!refreshable) retireRejectedCache(contexts, dependencies);
    const rejected = selection.results.find(
      (result) => result.outcome === "rejected" && result.refreshable,
    );
    return failureReport(
      failure,
      rejected ? contexts.get(rejected.source) : undefined,
      attempts,
      dependencies,
      { authStatus: refreshable ? "expired_refreshable" : "unusable" },
    );
  }

  return failureReport(
    new DroidFailure("droid_credential_unavailable", {
      status: "auth_required",
      definitiveAuth: true,
    }),
    undefined,
    attempts,
    dependencies,
  );
}

type DroidReading = { payload: NormalizedDroidPayload; refreshedAt: number };

function contextIdFor(
  resolution: Extract<DroidLocalResolution, { status: "resolved" }>,
): string | undefined {
  // A session token that names no user earns no identity, so its reading is
  // neither cached nor served stale rather than attributed to a guess.
  return resolution.identity
    ? droidCacheContextId(
        resolution.kind === "api_key" ? "api-key" : "session",
        resolution.identity,
      )
    : undefined;
}

async function attemptCandidate(
  candidate: CredentialCandidate<DroidCandidate>,
  dependencies: DroidDependencies,
): Promise<{ outcome: AttemptOutcome<DroidReading>; failure?: DroidFailure }> {
  try {
    const raw = await requestLimits(
      candidate.credential.credential,
      dependencies,
    );
    const refreshedAt = dependencies.now();
    const payload = normalizeDroidPayload(raw, refreshedAt);
    return {
      outcome: { kind: "quota", result: { payload, refreshedAt } },
    };
  } catch (error) {
    const failure = asDroidFailure(error);
    return failure.definitiveAuth
      ? { outcome: { kind: "rejected", error: failure.code }, failure }
      : {
          outcome: {
            kind: "transient",
            error: failure.code,
            ...(failure.retryAfter ? { retryAfter: failure.retryAfter } : {}),
          },
          failure,
        };
  }
}

function orderedAttempts(
  sources: readonly DroidCredentialSource[],
  localAttempts: Map<string, SourceAttempt>,
  results: CandidateResult[],
): SourceAttempt[] {
  const bySource = new Map(results.map((result) => [result.source, result]));
  const attempts: SourceAttempt[] = [];
  for (const source of sources) {
    const local = localAttempts.get(source.name);
    if (local) {
      attempts.push(local);
      continue;
    }
    const result = bySource.get(source.name);
    if (!result) continue;
    if (result.outcome === "quota") {
      attempts.push({ source: source.name, status: "success" });
    } else if (result.outcome === "not_tried") {
      attempts.push({
        source: source.name,
        status: "skipped",
        credentialPresent: true,
        degraded: false,
      });
    } else {
      attempts.push({
        source: source.name,
        status: "failed",
        ...(result.error ? { error: result.error } : {}),
      });
    }
  }
  return attempts;
}

function freshReport(
  reading: DroidReading,
  attempts: SourceAttempt[],
  sourcesTried: string[],
): ProviderQuota {
  const { payload } = reading;
  return {
    provider: "droid",
    label: LABEL,
    source: "api",
    windows: payload.windows,
    state: {
      status: "fresh",
      stale: false,
      authStatus: "usable",
      refreshedAt: new Date(reading.refreshedAt).toISOString(),
      ...(payload.untrustedWindowIds.length > 0
        ? { untrustedWindowIds: payload.untrustedWindowIds }
        : {}),
      sourcesTried,
    },
    attempts,
  };
}

function failureReport(
  failure: DroidFailure,
  contextId: string | undefined,
  attempts: SourceAttempt[],
  dependencies: DroidDependencies,
  overrides: { authStatus?: "expired_refreshable" | "unusable" } = {},
): ProviderQuota {
  const sourcesTried = attempts.map(({ source }) => source);
  const authStatus: ProviderAuthStatus | undefined =
    overrides.authStatus ??
    (failure.authUsable
      ? "usable"
      : failure.definitiveAuth
        ? "unusable"
        : undefined);
  if (failure.staleEligible && contextId) {
    const cached = safeReadCache(dependencies, contextId);
    const stale = cached
      ? staleDroidReport(
          cached,
          failure,
          attempts,
          dependencies.now(),
          authStatus,
        )
      : undefined;
    if (stale) return stale;
  }

  return {
    provider: "droid",
    label: LABEL,
    source: "unavailable",
    windows: [],
    state: {
      status: failure.status,
      stale: false,
      error: failure.code,
      ...(authStatus ? { authStatus } : {}),
      ...(failure.reason ? { reason: failure.reason } : {}),
      ...(failure.retryAfter ? { retryAfter: failure.retryAfter } : {}),
      sourcesTried,
    },
    attempts,
  };
}

function staleDroidReport(
  cached: ProviderQuota,
  failure: DroidFailure,
  attempts: SourceAttempt[],
  now: number,
  authStatus: ProviderAuthStatus | undefined,
): ProviderQuota | undefined {
  if (
    cached.provider !== "droid" ||
    cached.source !== "api" ||
    cached.state.status !== "fresh" ||
    !cached.state.refreshedAt ||
    !Number.isFinite(Date.parse(cached.state.refreshedAt))
  )
    return undefined;
  // Windows whose own reset has passed are dropped; a resetless window is
  // served only while younger than its own length (five hours, a week).
  const windows = servableStaleWindows(cached, now);
  if (windows.length === 0) return undefined;
  const untrustedWindowIds = servableUntrustedWindowIds(cached, windows);

  return {
    provider: "droid",
    label: LABEL,
    source: "cache",
    windows,
    state: {
      status: "stale",
      stale: true,
      refreshedAt: cached.state.refreshedAt,
      error: failure.code,
      ...(authStatus ? { authStatus } : {}),
      ...(failure.reason ? { reason: failure.reason } : {}),
      ...(failure.retryAfter ? { retryAfter: failure.retryAfter } : {}),
      ...(untrustedWindowIds ? { untrustedWindowIds } : {}),
      sourcesTried: [...attempts.map(({ source }) => source), "cache"],
    },
    attempts,
  };
}

function retireRejectedCache(
  contexts: Map<string, string | undefined>,
  dependencies: DroidDependencies,
): void {
  try {
    for (const contextId of contexts.values()) {
      if (contextId && dependencies.readCachedProvider(contextId)) {
        dependencies.deleteCachedProvider();
        return;
      }
    }
  } catch {
    // The current auth failure is still definitive even if the cache is not writable.
  }
}

async function requestLimits(
  credential: string,
  dependencies: DroidDependencies,
): Promise<unknown> {
  const controller = new AbortController();
  const signal = controller.signal;
  const timeout = new Promise<never>((_resolve, reject) => {
    signal.addEventListener(
      "abort",
      () =>
        reject(new DroidFailure("request_timeout", { staleEligible: true })),
      { once: true },
    );
  });
  timeout.catch(() => undefined);
  const deadline = setTimeout(
    () => controller.abort(),
    dependencies.deadlineMs,
  );
  try {
    return await Promise.race([
      sendLimitsRequest(credential, signal, dependencies),
      timeout,
    ]);
  } finally {
    clearTimeout(deadline);
  }
}

async function sendLimitsRequest(
  credential: string,
  signal: AbortSignal,
  dependencies: DroidDependencies,
): Promise<unknown> {
  const url = new URL(DROID_LIMITS_PATH, DROID_API_ORIGIN).href;
  let response: Response;
  try {
    response = await dependencies.fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${credential}`,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      credentials: "omit",
      redirect: "manual",
      signal,
    });
  } catch (error) {
    if (signal.aborted || isAbortError(error))
      throw new DroidFailure("request_timeout", { staleEligible: true });
    throw new DroidFailure(localTransportCode(error), { staleEligible: true });
  }

  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    rejectHttpFailure(response, dependencies.now());
  }

  let bytes: Uint8Array;
  try {
    bytes = await readBoundedResponseBody(
      response,
      signal,
      (code) => new DroidFailure(code, { staleEligible: true }),
    );
  } catch (error) {
    if (error instanceof DroidFailure) throw error;
    if (signal.aborted || isAbortError(error))
      throw new DroidFailure("request_timeout", { staleEligible: true });
    throw new DroidFailure("network_unavailable", { staleEligible: true });
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      (key, value: unknown) =>
        key === "" || RESPONSE_KEYS.has(key) ? value : undefined,
    ) as unknown;
  } catch {
    throw new DroidFailure("malformed_json", { staleEligible: true });
  }
}

function rejectHttpFailure(response: Response, receivedAt: number): never {
  const status = response.status;
  if (status >= 300 && status <= 399)
    throw new DroidFailure("redirect_rejected", { staleEligible: true });
  if (status === 401)
    throw new DroidFailure("droid_access_token_rejected", {
      status: "auth_required",
      definitiveAuth: true,
    });
  // 403 is not sign-out evidence: network policy and WAF denials use it too.
  if (status === 403)
    throw new DroidFailure("provider_request_forbidden", {
      staleEligible: true,
    });
  if (status === 408)
    throw new DroidFailure("provider_timeout", {
      authUsable: true,
      staleEligible: true,
    });
  if (status === 429)
    throw new DroidFailure("provider_rate_limited", {
      status: "rate_limited",
      authUsable: true,
      staleEligible: true,
      retryAfter: retryAfterToIso(
        response.headers.get("retry-after"),
        receivedAt,
      ),
    });
  if (status >= 500 && status <= 599)
    throw new DroidFailure("provider_unavailable", {
      authUsable: true,
      staleEligible: true,
    });
  throw new DroidFailure("provider_request_rejected", {
    authUsable: true,
    staleEligible: true,
  });
}

/**
 * The response's pools as quota windows: `limits.core` becomes the
 * `droid_core_*` windows and `limits.standard` the `other_models_*` windows,
 * each with its five-hour, weekly, and monthly meter.
 *
 * - A pool the response omits publishes no windows. `standard` is required
 *   (the Droid CLI itself treats a response without it as unreadable); `core`
 *   is optional, and a missing one is absent, never zero.
 * - A meter with no usable `usedPercent` is named in `untrustedWindowIds`
 *   instead of guessed at. A response with no usable meter at all is unreadable,
 *   never an empty reading.
 * - `windowEnd` is the reset. A meter with a null `windowEnd` has no window in
 *   flight (a rolling window starts at first use) and reports its used
 *   percentage with no reset. A `windowEnd` that has already passed is a window
 *   that rolled over: the Droid CLI and Factory's web app both treat it as
 *   empty, so it reports zero used with no reset rather than the stale figure.
 * - `usesTokenRateLimitsBilling: false` is a legacy token-allowance account
 *   that this endpoint does not meter; that is reported as unavailable, never
 *   as an empty or zero reading.
 */
export function normalizeDroidPayload(
  payload: unknown,
  now: number,
): NormalizedDroidPayload {
  const root = objectValue(payload);
  if (!root) throw new DroidFailure("schema_invalid", { staleEligible: true });
  const limits = objectValue(root.limits);
  if (root.usesTokenRateLimitsBilling === false || !limits)
    throw new DroidFailure("droid_token_rate_limits_unavailable", {
      status: "unavailable",
      authUsable: true,
    });
  if (!objectValue(limits.standard))
    throw new DroidFailure("schema_invalid", { staleEligible: true });

  const result: NormalizedDroidPayload = {
    windows: [],
    untrustedWindowIds: [],
  };
  for (const pool of DROID_POOLS) {
    const entry = objectValue(limits[pool.vendorKey]);
    if (!entry) continue;
    for (const period of PERIODS) {
      const id = `${pool.scope}_${period.suffix}`;
      const meter = objectValue(entry[period.vendorKey]);
      const used = finiteNonNegative(meter?.usedPercent);
      if (!meter || used === undefined) {
        result.untrustedWindowIds.push(id);
        continue;
      }
      const reset = resetFor(meter, now);
      const percentUsed =
        reset.status === "rolled_over"
          ? 0
          : Math.min(100, Number(used.toFixed(10)));
      result.windows.push(
        withRemaining({
          id,
          label: `${pool.label} ${period.label}`,
          kind: period.kind,
          percentUsed,
          ...(period.windowSeconds
            ? { windowSeconds: period.windowSeconds }
            : {}),
          ...(reset.status === "live" ? { resetsAt: reset.resetsAt } : {}),
        }),
      );
    }
  }
  if (result.windows.length === 0)
    throw new DroidFailure("schema_invalid", { staleEligible: true });
  return result;
}

type ResetReading =
  | { status: "live"; resetsAt: string }
  | { status: "rolled_over" }
  | { status: "none" };

function resetFor(meter: Record<string, unknown>, now: number): ResetReading {
  const end =
    typeof meter.windowEnd === "string" ? Date.parse(meter.windowEnd) : NaN;
  if (Number.isFinite(end))
    return end > now
      ? { status: "live", resetsAt: new Date(end).toISOString() }
      : { status: "rolled_over" };
  return { status: "none" };
}

async function resolveSource(
  source: DroidCredentialSource,
  options: Pick<ProviderOptions, "allowKeychainPrompt">,
  presenceOnly = false,
): Promise<DroidLocalResolution> {
  try {
    return await source.resolve(options, presenceOnly);
  } catch {
    return { status: "read_error", error: "credential_resolution_failed" };
  }
}

function safeLocation(source: DroidCredentialSource): string | undefined {
  try {
    return source.location();
  } catch {
    return undefined;
  }
}

function safeReadCache(
  dependencies: DroidDependencies,
  contextId: string,
): ProviderQuota | undefined {
  try {
    return dependencies.readCachedProvider(contextId);
  } catch {
    return undefined;
  }
}

function asDroidFailure(error: unknown): DroidFailure {
  return error instanceof DroidFailure
    ? error
    : new DroidFailure("provider_unavailable", { staleEligible: true });
}

function localTransportCode(
  error: unknown,
): "tls_failed" | "network_unavailable" {
  const cause = objectValue(objectValue(error)?.cause);
  const code = typeof cause?.code === "string" ? cause.code : undefined;
  return code && /(?:TLS|SSL|CERT|UNABLE_TO_VERIFY)/i.test(code)
    ? "tls_failed"
    : "network_unavailable";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

class DroidFailure extends Error {
  readonly code: string;
  readonly status: ProviderStatus;
  readonly staleEligible: boolean;
  readonly definitiveAuth: boolean;
  readonly authUsable: boolean;
  readonly retryAfter?: string;
  readonly reason?: ProviderStateReason;

  constructor(
    code: string,
    options: DroidFailureOptions & { reason?: ProviderStateReason } = {},
  ) {
    super(code);
    this.name = "DroidFailure";
    this.code = code;
    this.status = options.status ?? "error";
    this.staleEligible = options.staleEligible === true;
    this.definitiveAuth = options.definitiveAuth === true;
    this.authUsable = options.authUsable === true;
    this.retryAfter = options.retryAfter;
    this.reason = options.reason;
  }
}
