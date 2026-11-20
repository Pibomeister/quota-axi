import type { ProviderId, ProviderQuota, QuotaAxiResponse } from "./types.js";

/**
 * Coding-allowance dashboard data for a consumer such as Grokmate.
 *
 * Each machine runs `quota-axi allowance` and writes one JSON file holding
 * that machine's own rows, a per-pool summary, and alerts. Rows are built from
 * quota-axi's normalized provider readings, never from screen scraping, and
 * never carry an account email, a credential, or any token: the account is
 * the opaque local `accountKey` lane identity. Pools stay separate: rows and
 * summary counts are per harness and are never summed across harnesses.
 */
export const ALLOWANCE_PROVIDERS: readonly ProviderId[] = [
  "claude",
  "codex",
  "kimi",
  "muse",
  "grok",
  "agy",
  "cursor",
];

export type AllowanceRow = {
  machine: string;
  harness: ProviderId;
  /** Opaque local lane identity (`accountKey`); never an email or credential. */
  account: string;
  /** The provider's own window id, so pools of the same kind stay distinct. */
  window: string;
  kind: ProviderQuota["windows"][number]["kind"];
  used_pct: number | null;
  left_pct: number | null;
  resets_at: string | null;
  read_at: string;
  stale: boolean;
  source: string;
  error: string | null;
  resets_cst: string | null;
  credits?: { balance: number; unlimited?: boolean };
};

export type AllowanceMachine = {
  rows: number;
  usable: number;
  errors: number;
  no_usable_streak: number;
  reason: string | null;
};

export type AllowanceSummary = {
  rows: number;
  usable: number;
  errors: number;
  byHarness: Record<string, { rows: number; usable: number; errors: number }>;
};

export type AllowanceReport = {
  generated_at: string;
  machine?: string;
  rows: AllowanceRow[];
  machines: Record<string, AllowanceMachine>;
  summary: AllowanceSummary;
  alerts: string[];
  codexCredits: {
    now: number | null;
    prev: number | null;
    drop: number | null;
    rows: {
      machine: string;
      account: string;
      balance: number;
      prev: number | null;
    }[];
  };
};

/** Non-secret prior-run state: usable-row streaks and credit balances only. */
export type AllowancePriorState = {
  noUsableStreak: Record<string, number>;
  codexCredits: Record<string, number>;
};

export const EMPTY_PRIOR_STATE: AllowancePriorState = {
  noUsableStreak: {},
  codexCredits: {},
};

const CENTRAL_TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZoneName: "longOffset",
});

/** ISO 8601 in America/Chicago local time with its DST-aware offset. */
export function toCentralTime(iso: string | null): string | null {
  if (iso === null) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const part: Record<string, string> = {};
  for (const { type, value } of CENTRAL_TIME.formatToParts(date)) {
    part[type] = value;
  }
  const offset = (part.timeZoneName ?? "").replace("GMT", "") || "+00:00";
  return `${part.year}-${part.month}-${part.day}T${part.hour}:${part.minute}:${part.second}${offset}`;
}

function isUsable(row: AllowanceRow): boolean {
  return (
    row.error === null &&
    (row.used_pct !== null ||
      row.left_pct !== null ||
      row.credits?.balance !== undefined)
  );
}

function rowsForProvider(
  machine: string,
  generatedAt: string,
  provider: ProviderQuota,
): AllowanceRow[] {
  const account = provider.accountKey ?? "default";
  const source = provider.source ?? "quota-axi";
  const stale = provider.state.stale;
  const readAt = provider.state.refreshedAt ?? generatedAt;
  const readingError = stale
    ? (provider.state.error ?? provider.state.status)
    : null;
  const rows: AllowanceRow[] = provider.windows.map((window) => ({
    machine,
    harness: provider.provider,
    account,
    window: window.id,
    kind: window.kind,
    used_pct: window.percentUsed ?? null,
    // A shareOf window carries no percentRemaining by construction; a missing
    // remaining stays null rather than being derived from the used share.
    left_pct: window.percentRemaining ?? null,
    resets_at: window.resetsAt ?? null,
    read_at: readAt,
    stale,
    source,
    error: readingError,
    resets_cst: toCentralTime(window.resetsAt ?? null),
  }));
  if (provider.credits?.remaining !== undefined) {
    rows.push({
      machine,
      harness: provider.provider,
      account,
      window: "paid_credits",
      kind: "credits",
      used_pct: null,
      left_pct: null,
      resets_at: null,
      read_at: readAt,
      stale,
      source,
      error: readingError,
      resets_cst: null,
      credits: {
        balance: provider.credits.remaining,
        ...(provider.credits.unlimited ? { unlimited: true } : {}),
      },
    });
  }
  if (rows.length === 0) {
    rows.push({
      machine,
      harness: provider.provider,
      account,
      window: "*",
      kind: "unknown",
      used_pct: null,
      left_pct: null,
      resets_at: null,
      read_at: generatedAt,
      stale,
      source,
      error: provider.state.error ?? provider.state.status,
      resets_cst: null,
    });
  }
  return rows;
}

function assembleReport(input: {
  generatedAt: string;
  machine?: string;
  rows: AllowanceRow[];
  prior?: AllowancePriorState;
}): AllowanceReport {
  const prior = input.prior ?? EMPTY_PRIOR_STATE;
  const machines: Record<string, AllowanceMachine> = {};
  const byHarness: AllowanceSummary["byHarness"] = {};
  for (const row of input.rows) {
    const machine = (machines[row.machine] ??= {
      rows: 0,
      usable: 0,
      errors: 0,
      no_usable_streak: 0,
      reason: null,
    });
    machine.rows++;
    const harness = (byHarness[row.harness] ??= {
      rows: 0,
      usable: 0,
      errors: 0,
    });
    harness.rows++;
    if (row.error !== null) {
      machine.errors++;
      harness.errors++;
      machine.reason ??= row.error;
    } else if (isUsable(row)) {
      machine.usable++;
      harness.usable++;
    }
  }
  for (const [name, machine] of Object.entries(machines)) {
    machine.no_usable_streak =
      machine.usable > 0 ? 0 : (prior.noUsableStreak[name] ?? 0) + 1;
  }

  const alerts: string[] = [];
  for (const [name, machine] of Object.entries(machines)) {
    if (machine.no_usable_streak >= 2) {
      alerts.push(
        `machine ${name} has no usable rows for ${machine.no_usable_streak} consecutive runs`,
      );
    }
  }
  for (const row of input.rows) {
    if (
      row.kind === "weekly" &&
      row.error === null &&
      row.left_pct !== null &&
      row.left_pct < 10
    ) {
      alerts.push(
        `${row.machine} ${row.harness}/${row.account} ${row.window} has under 10% weekly left (${row.left_pct}%)`,
      );
    }
  }

  const creditRows = input.rows
    .filter(
      (row): row is AllowanceRow & { credits: { balance: number } } =>
        row.harness === "codex" && row.credits?.balance !== undefined,
    )
    .map((row) => ({
      machine: row.machine,
      account: row.account,
      balance: row.credits.balance,
      prev: prior.codexCredits[`${row.machine}:${row.account}`] ?? null,
    }));
  let prev: number | null = null;
  let drop: number | null = null;
  for (const credit of creditRows) {
    const before = credit.prev;
    if (before === null) continue;
    const fallen = before - credit.balance;
    if (drop === null || fallen > drop) {
      drop = fallen;
      prev = before;
    }
    if (fallen > 1000) {
      alerts.push(
        `Codex credits dropped ${fallen} on ${credit.machine}/${credit.account} (from ${before} to ${credit.balance})`,
      );
    }
  }
  const now =
    creditRows.length > 0
      ? Math.min(...creditRows.map((row) => row.balance))
      : null;

  return {
    generated_at: input.generatedAt,
    ...(input.machine ? { machine: input.machine } : {}),
    rows: input.rows,
    machines,
    summary: {
      rows: input.rows.length,
      usable: input.rows.filter(isUsable).length,
      errors: input.rows.filter((row) => row.error !== null).length,
      byHarness,
    },
    alerts,
    codexCredits: { now, prev, drop, rows: creditRows },
  };
}

/** Build one machine's report from a normalized quota response. */
export function buildAllowanceReport(input: {
  machine: string;
  generatedAt: string;
  providers: ProviderQuota[];
  prior?: AllowancePriorState;
}): AllowanceReport {
  const rows = input.providers.flatMap((provider) =>
    rowsForProvider(input.machine, input.generatedAt, provider),
  );
  return assembleReport({
    generatedAt: input.generatedAt,
    machine: input.machine,
    rows,
    ...(input.prior ? { prior: input.prior } : {}),
  });
}

/**
 * Merge per-machine reports into one dashboard object (the `merge.py` and
 * `guard.py` roles): rows concatenate, machines and pools stay separate,
 * and streak/credit alerts recompute against `prior`. Without `prior`, each
 * report's own stored streaks and prior credit balances carry over.
 */
export function mergeAllowanceReports(
  reports: readonly AllowanceReport[],
  prior?: AllowancePriorState,
): AllowanceReport {
  const rows = reports.flatMap((report) => report.rows);
  return assembleReport({
    generatedAt:
      reports
        .map((report) => report.generated_at)
        .sort()
        .at(-1) ?? "",
    rows,
    prior: prior ?? carriedPriorState(reports),
  });
}

function carriedPriorState(
  reports: readonly AllowanceReport[],
): AllowancePriorState {
  const noUsableStreak: Record<string, number> = {};
  const codexCredits: Record<string, number> = {};
  for (const report of reports) {
    for (const [name, machine] of Object.entries(report.machines ?? {})) {
      noUsableStreak[name] = Math.max(0, machine.no_usable_streak - 1);
    }
    for (const credit of report.codexCredits?.rows ?? []) {
      if (credit.prev !== null && credit.prev !== undefined) {
        codexCredits[`${credit.machine}:${credit.account}`] = credit.prev;
      }
    }
  }
  return { noUsableStreak, codexCredits };
}

/** Derive the next run's prior state from a finished report. */
export function priorStateFromReport(
  report: AllowanceReport,
): AllowancePriorState {
  const codexCredits: Record<string, number> = {};
  for (const row of report.codexCredits.rows) {
    codexCredits[`${row.machine}:${row.account}`] = row.balance;
  }
  const noUsableStreak: Record<string, number> = {};
  for (const [machine, value] of Object.entries(report.machines)) {
    noUsableStreak[machine] = value.no_usable_streak;
  }
  return { noUsableStreak, codexCredits };
}

/** Parse a persisted prior-state value, tolerating a missing or bad file. */
export function parsePriorState(value: unknown): AllowancePriorState {
  if (!value || typeof value !== "object") return { ...EMPTY_PRIOR_STATE };
  const record = value as Record<string, unknown>;
  const numbers = (input: unknown): Record<string, number> => {
    if (!input || typeof input !== "object") return {};
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === "number" && Number.isFinite(entry[1]),
      ),
    );
  };
  return {
    noUsableStreak: numbers(record.noUsableStreak),
    codexCredits: numbers(record.codexCredits),
  };
}

export function allowanceProvidersFor(
  response: QuotaAxiResponse,
): ProviderQuota[] {
  return response.providers.filter((provider) =>
    ALLOWANCE_PROVIDERS.includes(provider.provider),
  );
}
