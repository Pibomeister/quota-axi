import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readCachedDroidProvider,
  writeCachedProviders,
} from "../../src/cache.js";
import { withQuotaSemantics } from "../../src/interpretation.js";
import {
  createDroidAdapter,
  DROID_LIMITS_PATH,
  DROID_POOLS,
  normalizeDroidPayload,
} from "../../src/providers/droid.js";
import { droidCacheContextId } from "../../src/providers/droid-cache-context.js";
import {
  createDroidApiKeySource,
  type DroidCredentialSource,
  type DroidLocalResolution,
} from "../../src/providers/droid-credential.js";
import type { ProviderQuota } from "../../src/types.js";

const NOW = Date.parse("2026-10-31T12:00:00.000Z");
const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };
// Synthetic. No real Factory credential, balance, or account data appears here.
const API_KEY = "synthetic-factory-api-key-901";
const SENTINELS = [
  API_KEY,
  "SENTINEL-OVERAGE-PREFERENCE",
  "sentinel-droid-user@example.invalid",
];

const CORE_MONTHLY_END = "2026-11-22T01:00:51.000Z";
const STANDARD_MONTHLY_END = "2026-11-28T14:05:12.000Z";

/** The captain's scenario: Droid Core mostly spent, every other model nearly untouched. */
function limitsBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    usesTokenRateLimitsBilling: true,
    hasActiveSubscription: true,
    limits: {
      standard: {
        fiveHour: { usedPercent: 0, windowEnd: null, secondsRemaining: null },
        weekly: { usedPercent: 0, windowEnd: null, secondsRemaining: null },
        monthly: {
          usedPercent: 1,
          windowEnd: STANDARD_MONTHLY_END,
          secondsRemaining: 2_000_000,
        },
      },
      core: {
        fiveHour: { usedPercent: 0, windowEnd: null, secondsRemaining: null },
        weekly: { usedPercent: 0, windowEnd: null, secondsRemaining: null },
        monthly: {
          usedPercent: 76,
          windowEnd: CORE_MONTHLY_END,
          secondsRemaining: 1_000_000,
        },
      },
    },
    overagePreference: "SENTINEL-OVERAGE-PREFERENCE",
    extraUsageBalanceCents: 123456,
    whoami: "sentinel-droid-user@example.invalid",
    ...overrides,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function resolvedSource(
  name: string,
  overrides: Partial<
    Extract<DroidLocalResolution, { status: "resolved" }>
  > = {},
): DroidCredentialSource {
  return {
    name,
    location: () => `~/${name}`,
    resolve: () =>
      Promise.resolve({
        status: "resolved",
        credential: API_KEY,
        kind: "session",
        identity: "user-1|org-1",
        expired: false,
        refreshable: false,
        ...overrides,
      }),
  };
}

function brokenSource(name: string): DroidCredentialSource {
  return {
    name,
    location: () => `~/${name}`,
    resolve: () =>
      Promise.resolve({
        status: "structurally_invalid",
        error: "droid_auth_undecryptable",
      }),
  };
}

const rejecting = (() =>
  Promise.resolve(
    new Response("{}", { status: 401 }),
  )) as unknown as typeof globalThis.fetch;

async function seedCache(source: DroidCredentialSource): Promise<void> {
  const reading = await adapterWith([source], (() =>
    Promise.resolve(
      jsonResponse(limitsBody()),
    )) as unknown as typeof globalThis.fetch).fetchQuota(OPTIONS);
  writeCachedProviders([reading], new Date(NOW).toISOString());
}

function adapterWith(
  sources: DroidCredentialSource[],
  fetch: typeof globalThis.fetch,
) {
  return createDroidAdapter({
    sources,
    fetch,
    now: () => NOW,
    deadlineMs: 1_000,
  });
}

let directory: string;
const originalCache = process.env.XDG_CACHE_HOME;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "quota-axi-droid-"));
  process.env.XDG_CACHE_HOME = join(directory, "cache");
});

afterEach(() => {
  if (originalCache === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalCache;
  rmSync(directory, { recursive: true, force: true });
});

describe("normalizeDroidPayload", () => {
  it("reports the two pools as separate scoped windows", () => {
    const { windows, untrustedWindowIds } = normalizeDroidPayload(
      limitsBody(),
      NOW,
    );

    expect(untrustedWindowIds).toEqual([]);
    expect(windows.map(({ id }) => id)).toEqual([
      "droid_core_5h",
      "droid_core_weekly",
      "droid_core_monthly",
      "other_models_5h",
      "other_models_weekly",
      "other_models_monthly",
    ]);
    const byId = Object.fromEntries(windows.map((w) => [w.id, w]));
    expect(byId.droid_core_monthly).toMatchObject({
      kind: "monthly",
      percentUsed: 76,
      percentRemaining: 24,
      resetsAt: CORE_MONTHLY_END,
    });
    expect(byId.other_models_monthly).toMatchObject({
      kind: "monthly",
      percentUsed: 1,
      percentRemaining: 99,
      resetsAt: STANDARD_MONTHLY_END,
    });
    // The cycle length is not reported, so the monthly window carries none.
    expect(byId.droid_core_monthly).not.toHaveProperty("windowSeconds");
    expect(byId.droid_core_5h).toMatchObject({
      kind: "session",
      windowSeconds: 18_000,
    });
    expect(byId.droid_core_weekly).toMatchObject({
      kind: "weekly",
      windowSeconds: 604_800,
    });
  });

  it("maps the vendor's core pool to Droid Core and standard to other models", () => {
    expect(
      DROID_POOLS.map(({ vendorKey, scope }) => [vendorKey, scope]),
    ).toEqual([
      ["core", "droid_core"],
      ["standard", "other_models"],
    ]);
  });

  it("omits a reset for an idle window instead of inventing one", () => {
    const { windows } = normalizeDroidPayload(limitsBody(), NOW);
    expect(windows.find(({ id }) => id === "droid_core_5h")).not.toHaveProperty(
      "resetsAt",
    );
  });

  it("reports a window whose end has passed as rolled over, not as the stale figure", () => {
    const body = limitsBody();
    (body.limits as Record<string, Record<string, unknown>>).core!.monthly = {
      usedPercent: 76,
      windowEnd: "2026-10-30T00:00:00.000Z",
      secondsRemaining: null,
    };
    const monthly = normalizeDroidPayload(body, NOW).windows.find(
      ({ id }) => id === "droid_core_monthly",
    );
    expect(monthly).toMatchObject({ percentUsed: 0, percentRemaining: 100 });
    expect(monthly).not.toHaveProperty("resetsAt");
  });

  it("clamps an over-100 percentage", () => {
    const body = limitsBody();
    (body.limits as Record<string, Record<string, unknown>>).core!.monthly = {
      usedPercent: 140,
      windowEnd: CORE_MONTHLY_END,
    };
    const monthly = normalizeDroidPayload(body, NOW).windows.find(
      ({ id }) => id === "droid_core_monthly",
    );
    expect(monthly?.percentUsed).toBe(100);
  });

  it("names a meter without a usable percentage as untrusted rather than guessing", () => {
    const body = limitsBody();
    (body.limits as Record<string, Record<string, unknown>>).standard!.weekly =
      { usedPercent: "lots", windowEnd: null };
    const result = normalizeDroidPayload(body, NOW);
    expect(result.untrustedWindowIds).toEqual(["other_models_weekly"]);
    expect(result.windows.map(({ id }) => id)).not.toContain(
      "other_models_weekly",
    );
  });

  it("publishes no Droid Core windows when the response omits the core pool", () => {
    const body = limitsBody();
    delete (body.limits as Record<string, unknown>).core;
    const ids = normalizeDroidPayload(body, NOW).windows.map(({ id }) => id);
    expect(ids.every((id) => id.startsWith("other_models_"))).toBe(true);
    expect(ids).toHaveLength(3);
  });

  it("rejects a response without the standard pool as unreadable", () => {
    const body = limitsBody();
    delete (body.limits as Record<string, unknown>).standard;
    expect(() => normalizeDroidPayload(body, NOW)).toThrow("schema_invalid");
  });

  it.each([
    ["an empty standard pool", { standard: {} }],
    [
      "renamed percentage fields in both pools",
      {
        standard: { fiveHour: { percent: 1 } },
        core: { weekly: { percent: 2 } },
      },
    ],
  ])("rejects %s as unreadable, never an empty reading", (_label, limits) => {
    expect(() => normalizeDroidPayload(limitsBody({ limits }), NOW)).toThrow(
      "schema_invalid",
    );
  });

  it("reports a legacy token-allowance account as unavailable, never as zero", () => {
    expect(() =>
      normalizeDroidPayload(
        limitsBody({ usesTokenRateLimitsBilling: false }),
        NOW,
      ),
    ).toThrow("droid_token_rate_limits_unavailable");
    expect(() => normalizeDroidPayload({}, NOW)).toThrow();
    expect(() => normalizeDroidPayload("nope", NOW)).toThrow("schema_invalid");
  });
});

describe("Droid effective availability", () => {
  function semanticsFor(body: Record<string, unknown>) {
    const { windows, untrustedWindowIds } = normalizeDroidPayload(body, NOW);
    const provider: ProviderQuota = {
      provider: "droid",
      label: "Factory Droid",
      source: "api",
      windows,
      state: {
        status: "fresh",
        stale: false,
        refreshedAt: new Date(NOW).toISOString(),
        ...(untrustedWindowIds.length > 0 ? { untrustedWindowIds } : {}),
      },
    };
    return withQuotaSemantics(provider, new Date(NOW).toISOString())
      .quotaSemantics!;
  }

  it("tracks Droid Core and other models as two scopes that can diverge", () => {
    const semantics = semanticsFor(limitsBody());
    expect(semantics.status).toBe("known");
    const scopes = Object.fromEntries(
      semantics.effectiveAvailability.map((entry) => [entry.scope, entry]),
    );
    expect(Object.keys(scopes).sort()).toEqual(["droid_core", "other_models"]);
    expect(scopes.droid_core!.boundedBy).toEqual([
      "droid_core_5h",
      "droid_core_weekly",
      "droid_core_monthly",
    ]);
    expect(scopes.other_models!.boundedBy).toEqual([
      "other_models_5h",
      "other_models_weekly",
      "other_models_monthly",
    ]);
    expect(scopes.droid_core).toMatchObject({ effectivePercentRemaining: 24 });
    expect(scopes.other_models).toMatchObject({
      effectivePercentRemaining: 99,
    });
  });

  it("never lets one pool's exhaustion bound the other pool", () => {
    const body = limitsBody();
    (body.limits as Record<string, Record<string, unknown>>).core!.monthly = {
      usedPercent: 100,
      windowEnd: CORE_MONTHLY_END,
    };
    const scopes = Object.fromEntries(
      semanticsFor(body).effectiveAvailability.map((entry) => [
        entry.scope,
        entry,
      ]),
    );
    expect(scopes.droid_core).toMatchObject({ effectivePercentRemaining: 0 });
    expect(scopes.other_models).toMatchObject({
      effectivePercentRemaining: 99,
    });
  });

  it("leaves only the affected pool unresolved when one of its windows is unparsed", () => {
    const body = limitsBody();
    (body.limits as Record<string, Record<string, unknown>>).standard!.weekly =
      { usedPercent: "lots" };
    const semantics = semanticsFor(body);
    expect(semantics.status).toBe("partial");
    expect(semantics.unresolvedWindowIds).toEqual(["other_models_weekly"]);
    const scopes = Object.fromEntries(
      semantics.effectiveAvailability.map((entry) => [entry.scope, entry]),
    );
    expect(scopes.other_models!.status).toBe("unknown");
    expect(scopes.droid_core).toMatchObject({ effectivePercentRemaining: 24 });
  });
});

describe("Factory Droid adapter", () => {
  it("fetches Factory's own limits endpoint with a bearer token and reports both pools", async () => {
    const fetch = vi.fn(() => Promise.resolve(jsonResponse(limitsBody())));
    const adapter = adapterWith(
      [createDroidApiKeySource({ FACTORY_API_KEY: API_KEY })],
      fetch as unknown as typeof globalThis.fetch,
    );

    const report = await adapter.fetchQuota(OPTIONS);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.factory.ai${DROID_LIMITS_PATH}`);
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("manual");
    expect(init.credentials).toBe("omit");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${API_KEY}`,
    );
    expect(report).toMatchObject({
      provider: "droid",
      label: "Factory Droid",
      source: "api",
      state: { status: "fresh", stale: false, authStatus: "usable" },
    });
    expect(report.windows).toHaveLength(6);
    // Fields outside the allowlist never reach the report.
    const serialized = JSON.stringify(report);
    for (const sentinel of SENTINELS)
      expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain("123456");
  });

  it("prefers the Droid CLI's own sign-in over the exported API key", async () => {
    const seen: string[] = [];
    const fetch = vi.fn((_url: string, init: RequestInit) => {
      seen.push((init.headers as Record<string, string>).Authorization!);
      return Promise.resolve(jsonResponse(limitsBody()));
    });
    const adapter = adapterWith(
      [
        resolvedSource("cli-keychain", { credential: "session-token" }),
        createDroidApiKeySource({ FACTORY_API_KEY: API_KEY }),
      ],
      fetch as unknown as typeof globalThis.fetch,
    );
    const report = await adapter.fetchQuota(OPTIONS);
    expect(seen).toEqual(["Bearer session-token"]);
    expect(report.state.status).toBe("fresh");
    expect(
      report.attempts?.map(({ source, status }) => [source, status]),
    ).toEqual([
      ["cli-keychain", "success"],
      ["env:FACTORY_API_KEY", "skipped"],
    ]);
  });

  it("reports a definitive 401 on every credential as auth_required", async () => {
    const adapter = adapterWith([resolvedSource("cli-keychain")], (() =>
      Promise.resolve(
        new Response("{}", { status: 401 }),
      )) as unknown as typeof globalThis.fetch);
    const report = await adapter.fetchQuota(OPTIONS);
    expect(report.state).toMatchObject({
      status: "auth_required",
      authStatus: "unusable",
      error: "droid_access_token_rejected",
    });
    expect(report.windows).toEqual([]);
  });

  it("does not call an expired but refreshable token a sign-out", async () => {
    const adapter = adapterWith(
      [resolvedSource("cli-keychain", { expired: true, refreshable: true })],
      (() =>
        Promise.resolve(
          new Response("{}", { status: 401 }),
        )) as unknown as typeof globalThis.fetch,
    );
    const report = await adapter.fetchQuota(OPTIONS);
    expect(report.state.status).not.toBe("auth_required");
    expect(report.state.authStatus).toBe("expired_refreshable");
  });

  it("treats a rejected unexpired token with a refresh token as revoked, and retires the cache", async () => {
    const source = resolvedSource("cli-keychain", {
      expired: false,
      refreshable: true,
    });
    await seedCache(source);

    const report = await adapterWith([source], rejecting).fetchQuota(OPTIONS);

    expect(report.state).toMatchObject({
      status: "auth_required",
      authStatus: "unusable",
      error: "droid_access_token_rejected",
    });
    expect(report.state.reason).toBeUndefined();
    expect(report.windows).toEqual([]);
    expect(
      readCachedDroidProvider(droidCacheContextId("session", "user-1|org-1")),
    ).toBeUndefined();
  });

  it("serves only the expired session's cache when a revoked sibling is also rejected", async () => {
    const revoked = resolvedSource("env:FACTORY_API_KEY", {
      kind: "api_key",
      identity: "revoked-key",
    });
    const expired = resolvedSource("cli-keychain", {
      expired: true,
      refreshable: true,
    });
    await seedCache(revoked);

    const report = await adapterWith([expired, revoked], rejecting).fetchQuota(
      OPTIONS,
    );

    expect(report.state.authStatus).toBe("expired_refreshable");
    expect(report.source).toBe("unavailable");
    expect(report.windows).toEqual([]);
  });

  it("uses a live sibling when the stored token is expired", async () => {
    const seen: string[] = [];
    const fetch = vi.fn((_url: string, init: RequestInit) => {
      const bearer = (init.headers as Record<string, string>).Authorization!;
      seen.push(bearer);
      return Promise.resolve(
        bearer === "Bearer expired-token"
          ? new Response("{}", { status: 401 })
          : jsonResponse(limitsBody()),
      );
    });
    const report = await adapterWith(
      [
        resolvedSource("cli-keychain", {
          credential: "expired-token",
          expired: true,
          refreshable: true,
        }),
        createDroidApiKeySource({ FACTORY_API_KEY: API_KEY }),
      ],
      fetch as unknown as typeof globalThis.fetch,
    ).fetchQuota(OPTIONS);

    expect(seen).toEqual([`Bearer ${API_KEY}`]);
    expect(report.state).toMatchObject({
      status: "fresh",
      authStatus: "usable",
    });
    expect(report.windows).toHaveLength(6);
  });

  it("marks a broken store superseded by a working sibling without failing the reading", async () => {
    const report = await adapterWith(
      [
        brokenSource("cli-keyfile"),
        createDroidApiKeySource({ FACTORY_API_KEY: API_KEY }),
      ],
      (() =>
        Promise.resolve(
          jsonResponse(limitsBody()),
        )) as unknown as typeof globalThis.fetch,
    ).fetchQuota(OPTIONS);

    expect(report.state.status).toBe("fresh");
    expect(report.attempts?.[0]).toMatchObject({
      source: "cli-keyfile",
      status: "failed",
      error: "droid_auth_undecryptable",
      credentialPresent: true,
    });
  });

  it("reports a broken store rather than a sign-out when a sibling is rejected, and keeps the cache", async () => {
    const sibling = resolvedSource("env:FACTORY_API_KEY", {
      kind: "api_key",
      identity: "old-key",
    });
    await seedCache(sibling);

    const report = await adapterWith(
      [brokenSource("cli-keyfile"), sibling],
      rejecting,
    ).fetchQuota(OPTIONS);

    expect(report.state).toMatchObject({
      status: "error",
      error: "droid_auth_undecryptable",
    });
    expect(report.state.authStatus).toBeUndefined();
    expect(
      readCachedDroidProvider(droidCacheContextId("api-key", "old-key")),
    ).toBeDefined();
  });

  it("stops at a transient failure instead of handing over to a sibling", async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(new Response("{}", { status: 503 })),
    );
    const report = await adapterWith(
      [
        resolvedSource("cli-keychain"),
        createDroidApiKeySource({ FACTORY_API_KEY: API_KEY }),
      ],
      fetch as unknown as typeof globalThis.fetch,
    ).fetchQuota(OPTIONS);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(report.state.error).toBe("provider_unavailable");
    expect(
      report.attempts?.map(({ source, status }) => [source, status]),
    ).toEqual([
      ["cli-keychain", "failed"],
      ["env:FACTORY_API_KEY", "skipped"],
    ]);
  });

  it("keeps the last reading when the vendor's meters stop parsing", async () => {
    const source = resolvedSource("cli-keychain");
    await seedCache(source);

    const report = await adapterWith([source], (() =>
      Promise.resolve(
        jsonResponse(limitsBody({ limits: { standard: {} } })),
      )) as unknown as typeof globalThis.fetch).fetchQuota(OPTIONS);
    writeCachedProviders([report], new Date(NOW).toISOString());

    expect(report.state).toMatchObject({
      status: "stale",
      error: "schema_invalid",
    });
    expect(report.source).toBe("cache");
    expect(
      readCachedDroidProvider(droidCacheContextId("session", "user-1|org-1"))
        ?.windows,
    ).toHaveLength(6);
  });

  it("reports a legacy account as unavailable with a usable credential", async () => {
    const adapter = adapterWith([resolvedSource("cli-keychain")], (() =>
      Promise.resolve(
        jsonResponse(limitsBody({ usesTokenRateLimitsBilling: false })),
      )) as unknown as typeof globalThis.fetch);
    const report = await adapter.fetchQuota(OPTIONS);
    expect(report.state).toMatchObject({
      status: "unavailable",
      error: "droid_token_rate_limits_unavailable",
    });
    expect(report.windows).toEqual([]);
  });

  it("maps 429 to rate_limited with a retry time", async () => {
    const adapter = adapterWith([resolvedSource("cli-keychain")], (() =>
      Promise.resolve(
        new Response("{}", { status: 429, headers: { "retry-after": "60" } }),
      )) as unknown as typeof globalThis.fetch);
    const report = await adapter.fetchQuota(OPTIONS);
    expect(report.state).toMatchObject({
      status: "rate_limited",
      error: "provider_rate_limited",
      retryAfter: "2026-10-31T12:01:00.000Z",
    });
  });

  it("rejects a redirect instead of following it with the token", async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example.invalid/" },
        }),
      ),
    );
    const adapter = adapterWith(
      [resolvedSource("cli-keychain")],
      fetch as unknown as typeof globalThis.fetch,
    );
    const report = await adapter.fetchQuota(OPTIONS);
    expect(report.state.error).toBe("redirect_rejected");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("serves the last reading from the same account as stale when Factory is unavailable", async () => {
    const source = resolvedSource("cli-keychain");
    const contextId = droidCacheContextId("session", "user-1|org-1");
    const first = await adapterWith([source], (() =>
      Promise.resolve(
        jsonResponse(limitsBody()),
      )) as unknown as typeof globalThis.fetch).fetchQuota(OPTIONS);
    writeCachedProviders([first], new Date(NOW));
    expect(readCachedDroidProvider(contextId)?.windows).toHaveLength(6);

    const report = await adapterWith([source], (() =>
      Promise.resolve(
        new Response("{}", { status: 503 }),
      )) as unknown as typeof globalThis.fetch).fetchQuota(OPTIONS);

    expect(report.state).toMatchObject({
      status: "stale",
      stale: true,
      error: "provider_unavailable",
    });
    expect(report.source).toBe("cache");
    expect(report.windows.map(({ id }) => id)).toContain("droid_core_monthly");
  });

  it("never serves another account's cached reading", async () => {
    const first = await adapterWith(
      [resolvedSource("cli-keychain", { identity: "user-1|org-1" })],
      (() =>
        Promise.resolve(
          jsonResponse(limitsBody()),
        )) as unknown as typeof globalThis.fetch,
    ).fetchQuota(OPTIONS);
    writeCachedProviders([first], new Date(NOW));

    const report = await adapterWith(
      [resolvedSource("cli-keychain", { identity: "user-2|org-2" })],
      (() =>
        Promise.resolve(
          new Response("{}", { status: 503 }),
        )) as unknown as typeof globalThis.fetch,
    ).fetchQuota(OPTIONS);

    expect(report.state.stale).toBe(false);
    expect(report.windows).toEqual([]);
  });

  it("reports no credential as auth_required without any request", async () => {
    const fetch = vi.fn();
    const adapter = adapterWith(
      [createDroidApiKeySource({})],
      fetch as unknown as typeof globalThis.fetch,
    );
    const report = await adapter.fetchQuota(OPTIONS);
    expect(report.state).toMatchObject({
      status: "auth_required",
      error: "droid_credential_unavailable",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports a present Keychain credential it may not read as blocked, not signed out", async () => {
    const adapter = adapterWith(
      [
        {
          name: "cli-keychain",
          location: () => "~/.factory/auth.v2.loginkeychain",
          resolve: () =>
            Promise.resolve({
              status: "skipped",
              error: "keychain_prompt_required",
            }),
        },
      ],
      vi.fn() as unknown as typeof globalThis.fetch,
    );
    const report = await adapter.fetchQuota(OPTIONS);
    expect(report.state.status).not.toBe("auth_required");
    expect(report.state.error).toBe("keychain_prompt_required");
    expect(report.state.reason).toBe("keychain_access_required");
  });

  it("inspects auth locally without a request and never prints the credential", async () => {
    const fetch = vi.fn();
    const adapter = adapterWith(
      [
        resolvedSource("cli-keychain", { expired: true, refreshable: true }),
        createDroidApiKeySource({ FACTORY_API_KEY: API_KEY }),
      ],
      fetch as unknown as typeof globalThis.fetch,
    );
    const report = await adapter.inspectAuth!(OPTIONS);
    expect(fetch).not.toHaveBeenCalled();
    expect(report.provider).toBe("droid");
    expect(
      report.sources.map(({ source, status }) => [source, status]),
    ).toEqual([
      ["cli-keychain", "expired"],
      ["env:FACTORY_API_KEY", "available"],
    ]);
    expect(JSON.stringify(report)).not.toContain(API_KEY);
  });
});
