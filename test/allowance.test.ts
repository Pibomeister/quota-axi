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
      (row) => row.harness === "codex" && row.window === "credits",
    );
    expect(credits?.credits?.balance).toBe(17325);
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
    expect(written.rows.some((row) => row.window === "credits")).toBe(true);
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
