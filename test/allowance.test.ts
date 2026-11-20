import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALLOWANCE_PROVIDERS,
  buildAllowanceReport,
  mergeAllowanceReports,
  priorStateFromReport,
  toCentralTime,
  type AllowanceReport,
} from "../src/allowance.js";
import { allowanceCommand } from "../src/commands.js";
import type { ProviderQuota, QuotaAxiResponse } from "../src/types.js";

const GENERATED = "2026-11-19T17:01:49-06:00";

function quota(partial: Partial<ProviderQuota>): ProviderQuota {
  return {
    provider: "claude",
    accountKey: "default",
    account: { email: "person@example.com" },
    windows: [],
    state: { status: "fresh", stale: false },
    ...partial,
  } as ProviderQuota;
}

describe("allowance rows", () => {
  it("keeps pools separate, carries Codex paid credits, and never leaks email", () => {
    const report = buildAllowanceReport({
      machine: "machine-a",
      generatedAt: GENERATED,
      providers: [
        quota({
          provider: "claude",
          windows: [
            {
              id: "weekly",
              label: "Weekly",
              kind: "weekly",
              percentUsed: 45,
              percentRemaining: 55,
              resetsAt: "2026-11-25T11:00:00.000Z",
            },
            {
              id: "share",
              label: "Share",
              kind: "model",
              percentUsed: 88,
              shareOf: "weekly",
            },
          ],
        }),
        quota({
          provider: "codex",
          windows: [
            {
              id: "weekly",
              label: "Weekly",
              kind: "weekly",
              percentUsed: 99,
              percentRemaining: 1,
            },
          ],
          credits: { remaining: 17325, unlimited: false, unit: "credits" },
        }),
        quota({
          provider: "cursor",
          windows: [
            {
              id: "monthly",
              label: "Monthly",
              kind: "monthly",
              percentUsed: 100,
              percentRemaining: 0,
            },
          ],
        }),
      ],
    });
    expect(ALLOWANCE_PROVIDERS).toEqual([
      "claude",
      "codex",
      "kimi",
      "muse",
      "grok",
      "agy",
      "cursor",
    ]);
    const harnesses = [...new Set(report.rows.map((row) => row.harness))];
    expect(harnesses).toEqual(["claude", "codex", "cursor"]);
    const share = report.rows.find((row) => row.window === "share");
    expect(share?.left_pct).toBeNull();
    const credits = report.rows.find(
      (row) => row.harness === "codex" && row.window === "paid_credits",
    );
    expect(credits?.credits?.balance).toBe(17325);
    expect(
      report.rows.find(
        (row) => row.harness === "claude" && row.window === "weekly",
      )?.resets_cst,
    ).toBe("2026-11-25T05:00:00-06:00");
    expect(JSON.stringify(report)).not.toContain("person@example.com");
    expect(report.summary.byHarness.claude?.rows).toBe(2);
    expect(report.summary.byHarness.codex?.rows).toBe(2);
    expect(report.summary.byHarness.cursor?.rows).toBe(1);
  });

  it("alerts when a weekly window has under 10% left, not at exactly 10%", () => {
    const low = buildAllowanceReport({
      machine: "machine-a",
      generatedAt: GENERATED,
      providers: [
        quota({
          provider: "kimi",
          windows: [
            {
              id: "weekly",
              label: "Weekly",
              kind: "weekly",
              percentUsed: 95,
              percentRemaining: 5,
            },
          ],
        }),
      ],
    });
    expect(low.alerts.join(" ")).toContain("under 10% weekly left");
    const edge = buildAllowanceReport({
      machine: "machine-a",
      generatedAt: GENERATED,
      providers: [
        quota({
          provider: "kimi",
          windows: [
            {
              id: "weekly",
              label: "Weekly",
              kind: "weekly",
              percentUsed: 90,
              percentRemaining: 10,
            },
          ],
        }),
      ],
    });
    expect(edge.alerts).toEqual([]);
  });

  it("alerts only when Codex credits drop by more than 1,000 from the prior run", () => {
    const providers = [
      quota({
        provider: "codex",
        credits: { remaining: 16000, unlimited: false, unit: "credits" },
      }),
    ];
    const dropped = buildAllowanceReport({
      machine: "machine-a",
      generatedAt: GENERATED,
      providers,
      prior: {
        noUsableStreak: {},
        codexCredits: { "machine-a:default": 17325 },
      },
    });
    expect(dropped.alerts.join(" ")).toContain("Codex credits dropped");
    expect(dropped.codexCredits.drop).toBe(1325);
    const exact = buildAllowanceReport({
      machine: "machine-a",
      generatedAt: GENERATED,
      providers: [
        quota({
          provider: "codex",
          credits: { remaining: 16325, unlimited: false, unit: "credits" },
        }),
      ],
      prior: {
        noUsableStreak: {},
        codexCredits: { "machine-a:default": 17325 },
      },
    });
    expect(exact.alerts).toEqual([]);
  });

  it("alerts after two consecutive runs with no usable rows for a machine", () => {
    const failing = [
      quota({
        provider: "claude",
        windows: [],
        state: { status: "unavailable", stale: false, error: "no credential" },
      }),
    ];
    const first = buildAllowanceReport({
      machine: "machine-a",
      generatedAt: GENERATED,
      providers: failing,
    });
    expect(first.machines["machine-a"]?.no_usable_streak).toBe(1);
    expect(first.alerts).toEqual([]);
    const second = buildAllowanceReport({
      machine: "machine-a",
      generatedAt: GENERATED,
      providers: failing,
      prior: priorStateFromReport(first),
    });
    expect(second.machines["machine-a"]?.no_usable_streak).toBe(2);
    expect(second.alerts.join(" ")).toContain("no usable rows");
    const recovered = buildAllowanceReport({
      machine: "machine-a",
      generatedAt: GENERATED,
      providers: [
        quota({
          windows: [
            {
              id: "weekly",
              label: "Weekly",
              kind: "weekly",
              percentUsed: 10,
              percentRemaining: 90,
            },
          ],
        }),
      ],
      prior: priorStateFromReport(second),
    });
    expect(recovered.machines["machine-a"]?.no_usable_streak).toBe(0);
  });

  it("keeps Codex paid credits beside a spend-control credits window", () => {
    const providers = [
      quota({
        provider: "codex",
        windows: [
          {
            id: "spend_control",
            label: "Spend control",
            kind: "credits",
            percentUsed: 100,
            percentRemaining: 0,
          },
        ],
        credits: { remaining: 15000, unlimited: false, unit: "credits" },
      }),
    ];
    const report = buildAllowanceReport({
      machine: "machine-a",
      generatedAt: GENERATED,
      providers,
      prior: {
        noUsableStreak: {},
        codexCredits: { "machine-a:default": 17325 },
      },
    });
    expect(report.rows.map((row) => row.window)).toEqual([
      "spend_control",
      "paid_credits",
    ]);
    expect(report.codexCredits.now).toBe(15000);
    expect(report.codexCredits.drop).toBe(2325);
    expect(report.alerts.join(" ")).toContain("Codex credits dropped 2325");
  });

  it("keeps Cursor pools of the same kind as distinct windows", () => {
    const pool = (id: string, left: number) => ({
      id,
      label: id,
      kind: "monthly" as const,
      percentUsed: 100 - left,
      percentRemaining: left,
    });
    const report = buildAllowanceReport({
      machine: "machine-a",
      generatedAt: GENERATED,
      providers: [
        quota({
          provider: "cursor",
          windows: [
            pool("included_usage", 40),
            pool("auto_usage", 70),
            pool("api_usage", 5),
          ],
        }),
      ],
    });
    expect(
      report.rows.map((row) => [row.window, row.kind, row.left_pct]),
    ).toEqual([
      ["included_usage", "monthly", 40],
      ["auto_usage", "monthly", 70],
      ["api_usage", "monthly", 5],
    ]);
  });

  it("marks a stale cached reading with its own read time and error", () => {
    const report = buildAllowanceReport({
      machine: "machine-a",
      generatedAt: GENERATED,
      providers: [
        quota({
          provider: "kimi",
          windows: [
            {
              id: "weekly",
              label: "Weekly",
              kind: "weekly",
              percentUsed: 95,
              percentRemaining: 5,
            },
          ],
          state: {
            status: "stale",
            stale: true,
            refreshedAt: "2026-11-18T08:00:00.000Z",
            error: "vendor read failed",
          },
        }),
      ],
    });
    const row = report.rows[0];
    expect(row?.read_at).toBe("2026-11-18T08:00:00.000Z");
    expect(row?.stale).toBe(true);
    expect(row?.error).toBe("vendor read failed");
    expect(report.machines["machine-a"]?.usable).toBe(0);
    expect(report.machines["machine-a"]?.no_usable_streak).toBe(1);
    expect(report.alerts).toEqual([]);
  });

  it("converts resets to America/Chicago time with the DST-aware offset", () => {
    expect(toCentralTime("2026-11-20T15:00:00.000Z")).toBe(
      "2026-11-20T09:00:00-06:00",
    );
    expect(toCentralTime("2026-07-01T12:00:00Z")).toBe(
      "2026-07-01T07:00:00-05:00",
    );
    expect(toCentralTime("2026-03-08T07:59:59Z")).toBe(
      "2026-03-08T01:59:59-06:00",
    );
    expect(toCentralTime("2026-03-08T08:00:00Z")).toBe(
      "2026-03-08T03:00:00-05:00",
    );
    expect(toCentralTime(null)).toBeNull();
  });

  it("carries each report's own streak and Codex prior balance into a merge", () => {
    const failing = [
      quota({
        provider: "claude",
        windows: [],
        state: { status: "unavailable", stale: false, error: "no credential" },
      }),
    ];
    const first = buildAllowanceReport({
      machine: "machine-b",
      generatedAt: GENERATED,
      providers: failing,
    });
    const machineB = buildAllowanceReport({
      machine: "machine-b",
      generatedAt: GENERATED,
      providers: failing,
      prior: priorStateFromReport(first),
    });
    const machineA = buildAllowanceReport({
      machine: "machine-a",
      generatedAt: GENERATED,
      providers: [
        quota({
          provider: "codex",
          credits: { remaining: 16000, unlimited: false, unit: "credits" },
        }),
      ],
      prior: {
        noUsableStreak: {},
        codexCredits: { "machine-a:default": 17325 },
      },
    });
    const merged = mergeAllowanceReports([machineA, machineB]);
    expect(merged.machines["machine-b"]?.no_usable_streak).toBe(2);
    expect(merged.alerts.join(" ")).toContain(
      "machine machine-b has no usable rows for 2 consecutive runs",
    );
    expect(merged.codexCredits.prev).toBe(17325);
    expect(merged.codexCredits.drop).toBe(1325);
    expect(merged.alerts.join(" ")).toContain("Codex credits dropped 1325");
  });

  it("merges per-machine reports without summing pools", () => {
    const fixture = JSON.parse(
      readFileSync("test/fixtures/allowance-reports.json", "utf8"),
    ) as { reports: AllowanceReport[] };
    const merged = mergeAllowanceReports(fixture.reports);
    expect(merged.rows).toHaveLength(3);
    expect(merged.machines["machine-a"]?.usable).toBe(2);
    expect(merged.machines["machine-b"]?.usable).toBe(1);
    expect(merged.alerts.join(" ")).toContain("under 10% weekly left");
    expect(merged.codexCredits.now).toBe(17325);
  });
});

describe("allowance command", () => {
  it("writes the fixed JSON file privately and persists prior state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quota-axi-allowance-"));
    const output = join(dir, "allowance.json");
    const response: QuotaAxiResponse = {
      generatedAt: GENERATED,
      schemaVersion: 6,
      providers: [
        quota({
          provider: "codex",
          windows: [
            {
              id: "weekly",
              label: "Weekly",
              kind: "weekly",
              percentUsed: 20,
              percentRemaining: 80,
            },
          ],
          credits: { remaining: 17325, unlimited: false, unit: "credits" },
        }),
      ],
    };
    const deps = { fetchQuota: async () => response };
    const text = await allowanceCommand(
      ["--machine", "machine-a", "--output", output],
      { binPath: "quota-axi" },
      deps,
    );
    expect(JSON.parse(text).machine).toBe("machine-a");
    expect(existsSync(output)).toBe(true);
    expect(statSync(output).mode & 0o777).toBe(0o600);
    const written = JSON.parse(readFileSync(output, "utf8")) as AllowanceReport;
    expect(written.rows.some((row) => row.window === "paid_credits")).toBe(
      true,
    );
    response.providers[0]!.credits = {
      remaining: 15000,
      unlimited: false,
      unit: "credits",
    };
    await allowanceCommand(
      ["--machine", "machine-a", "--output", output],
      { binPath: "quota-axi" },
      deps,
    );
    const second = JSON.parse(readFileSync(output, "utf8")) as AllowanceReport;
    expect(second.alerts.join(" ")).toContain("Codex credits dropped");
  });
});
