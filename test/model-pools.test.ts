import { describe, expect, it } from "vitest";
import { withQuotaSemantics } from "../src/interpretation.js";
import { MODEL_POOL_DATA } from "../src/model-pools.data.js";
import {
  factoryMultiplier,
  modelPoolMatchers,
  resolveModelPool,
  resolveModelPoolRules,
  UNKNOWN_MODEL_POOL,
} from "../src/model-pools.js";
import { quotaJsonReport, renderQuotaToon } from "../src/render.js";
import type { ProviderQuota, QuotaWindow } from "../src/types.js";

const OBSERVED = "2026-11-11";
const CARBON_CHANGE = "2026-12-01";

const DROID_CORE_IDS = [
  "glm-5.3-flash",
  "glm-5.3",
  "glm-5.2",
  "glm-5.2-fast",
  "kimi-k3.1-pro",
  "kimi-k3",
  "qwen3.8-max",
  "nemotron-3.5-super",
  "nemotron-3-ultra",
  "deepseek-v4.1-flash",
  "deepseek-v4.1-flash-1017",
  "minimax-m3.1-flash",
  "minimax-m3",
  "muse-spark-1.3",
  "muse-spark-1.2",
  "inkling",
  "beam-1.0",
  "mistral-large-4",
  "mistral-medium-3.5",
] as const;

const FACTORY_RATES: ReadonlyArray<readonly [string, number]> = [
  ["claude-opus-5.5", 1.6],
  ["claude-sonnet-5.5", 0.8],
  ["claude-haiku-5.5", 0.04],
  ["claude-fable-5.2", 3.2],
  ["gpt-6.1-sol", 0.8],
  ["gpt-6-luna", 0.04],
  ["gemini-4-carbon", 0.8],
  ["gemini-3.8-flash", 0.3],
  ["grok-4.7", 0.8],
  ["glm-5.3-flash", 0.06],
  ["minimax-m3.1-flash", 0.06],
  ["deepseek-v4.1-flash", 0.12],
  ["glm-5.3", 0.56],
  ["kimi-k3.1-pro", 0.8],
];

function provider(
  id: ProviderQuota["provider"],
  windows: QuotaWindow[],
  stale = false,
): ProviderQuota {
  return {
    provider: id,
    label: id,
    source: "api",
    windows,
    state: stale
      ? {
          status: "stale",
          stale: true,
          refreshedAt: "2026-07-01T00:00:00.000Z",
        }
      : { status: "fresh", stale: false },
  };
}

function window(id: string): QuotaWindow {
  return {
    id,
    label: id,
    kind: "monthly",
    percentUsed: 10,
    percentRemaining: 90,
  };
}

describe("model pool catalog", () => {
  it("records the catalog on the observed day", () => {
    expect(MODEL_POOL_DATA.observed).toBe(OBSERVED);
  });

  it("maps every listed Droid Core id to droid_core and no similar id", () => {
    expect(modelPoolMatchers("droid", "droid_core")).toEqual([
      ...DROID_CORE_IDS,
    ]);
    for (const id of DROID_CORE_IDS) {
      expect(resolveModelPool("droid", id), id).toBe("droid_core");
    }
    expect(resolveModelPool("droid", "glm-5.2-faster")).toBe(
      UNKNOWN_MODEL_POOL,
    );
    expect(resolveModelPool("droid", "GLM-5.3-flash")).toBe(UNKNOWN_MODEL_POOL);
    expect(resolveModelPool("droid", "muse-spark-1.4")).toBe(
      UNKNOWN_MODEL_POOL,
    );
  });

  it("maps frontier families to other_models and leaves an unknown id unknown", () => {
    expect(modelPoolMatchers("droid", "other_models")).toEqual([
      "claude-*",
      "gpt-*",
      "gemini-*",
      "grok-*",
    ]);
    for (const id of [
      "claude-opus-5.5",
      "gpt-6.1-sol",
      "gemini-4-carbon",
      "grok-4.7",
    ]) {
      expect(resolveModelPool("droid", id), id).toBe("other_models");
    }
    expect(resolveModelPool("droid", "not-a-model")).toBe(UNKNOWN_MODEL_POOL);
    expect(resolveModelPool("droid", "claude-")).toBe(UNKNOWN_MODEL_POOL);
  });

  it("maps Cursor house models to pool:auto and API families to pool:api", () => {
    expect(modelPoolMatchers("cursor", "pool:auto")).toEqual([
      "composer-*",
      "grok-*",
    ]);
    expect(modelPoolMatchers("cursor", "pool:api")).toEqual([
      "claude-*",
      "gpt-*",
      "gemini-*",
      "codex-*",
    ]);
    expect(resolveModelPool("cursor", "composer-2.5")).toBe("pool:auto");
    expect(resolveModelPool("cursor", "grok-4.7")).toBe("pool:auto");
    expect(resolveModelPool("cursor", "claude-opus-5.5")).toBe("pool:api");
    expect(resolveModelPool("cursor", "gpt-6.1-sol")).toBe("pool:api");
    expect(resolveModelPool("cursor", "gpt-5-codex")).toBe("pool:api");
    expect(resolveModelPool("cursor", "codex-mini")).toBe("pool:api");
    expect(resolveModelPool("cursor", "composer")).toBe(UNKNOWN_MODEL_POOL);
    expect(resolveModelPool("cursor", "grok")).toBe(UNKNOWN_MODEL_POOL);
    expect(resolveModelPool("cursor", "mystery-model")).toBe(
      UNKNOWN_MODEL_POOL,
    );
  });

  it("does not guess a pool for a provider with no catalog", () => {
    expect(resolveModelPool("claude", "claude-opus-5.5")).toBe(
      UNKNOWN_MODEL_POOL,
    );
    expect(resolveModelPool("cursor", "  ")).toBe(UNKNOWN_MODEL_POOL);
  });

  it("stays unknown when one id matches two scopes", () => {
    expect(
      resolveModelPoolRules(
        {
          first: { prefixes: ["foo-"] },
          second: { prefixes: ["foo-"] },
        },
        "foo-1",
      ),
    ).toBe(UNKNOWN_MODEL_POOL);
  });
});

describe("Factory multipliers", () => {
  it("returns each recorded rate on the observed day", () => {
    expect(MODEL_POOL_DATA.factoryMultipliers.map((entry) => entry.id)).toEqual(
      FACTORY_RATES.map(([id]) => id),
    );
    for (const [id, multiplier] of FACTORY_RATES) {
      expect(factoryMultiplier(id, OBSERVED), id).toBe(multiplier);
    }
  });

  it("changes Gemini 4 Carbon on 2026-12-01 and withholds other days", () => {
    expect(factoryMultiplier("gemini-4-carbon", "2026-11-30")).toBe(0.8);
    expect(factoryMultiplier("gemini-4-carbon", CARBON_CHANGE)).toBe(1.6);
    expect(factoryMultiplier("gemini-4-carbon", "2026-12-02")).toBe(1.6);
    expect(factoryMultiplier("gemini-4-carbon", "2026-11-10")).toBeUndefined();
    expect(factoryMultiplier("claude-opus-5.5", "2027-01-01")).toBe(1.6);
    expect(factoryMultiplier("claude-opus-5.5", "2026-11-10")).toBeUndefined();
  });

  it("does not invent a multiplier for an unlisted or undated id", () => {
    expect(factoryMultiplier("glm-5.2", OBSERVED)).toBeUndefined();
    expect(factoryMultiplier("not-a-model", OBSERVED)).toBeUndefined();
    expect(factoryMultiplier("claude-opus-5.5", "2026-13-01")).toBeUndefined();
    expect(factoryMultiplier("claude-opus-5.5", "yesterday")).toBeUndefined();
  });
});

describe("model pools in quota output", () => {
  const generatedAt = "2026-11-11T12:00:00.000Z";

  it("prints the catalog beside each Factory and Cursor scope in TOON and JSON", () => {
    const droid = withQuotaSemantics(
      provider("droid", [window("droid_core_5h"), window("other_models_5h")]),
      generatedAt,
    );
    const cursor = withQuotaSemantics(
      provider("cursor", [window("auto_usage"), window("api_usage")]),
      generatedAt,
    );
    const response = {
      generatedAt,
      schemaVersion: 5 as const,
      providers: [cursor, droid],
    };

    const toon = renderQuotaToon(response, "/usr/bin/quota-axi", false);
    expect(toon).toContain("modelPools[4]{provider,scope,models}:");
    expect(toon).toContain('cursor,"pool:auto",composer-* + grok-*');
    expect(toon).toContain(
      'cursor,"pool:api",claude-* + gpt-* + gemini-* + codex-*',
    );
    expect(toon).toContain("droid,droid_core,");
    expect(toon).toContain("glm-5.3-flash");
    expect(toon).toContain(
      "droid,other_models,claude-* + gpt-* + gemini-* + grok-*",
    );

    const json = quotaJsonReport(response, false);
    const cursorAuto =
      json.providers[0]?.quotaSemantics?.effectiveAvailability.find(
        (scope) => scope.scope === "pool:auto",
      );
    const cursorApi =
      json.providers[0]?.quotaSemantics?.effectiveAvailability.find(
        (scope) => scope.scope === "pool:api",
      );
    const core = json.providers[1]?.quotaSemantics?.effectiveAvailability.find(
      (scope) => scope.scope === "droid_core",
    );
    expect(cursorAuto?.models).toEqual(["composer-*", "grok-*"]);
    expect(cursorApi?.models).toEqual([
      "claude-*",
      "gpt-*",
      "gemini-*",
      "codex-*",
    ]);
    expect(core?.models).toEqual([...DROID_CORE_IDS]);
    expect(
      json.providers[0]?.quotaSemantics?.effectiveAvailability.find(
        (scope) => scope.scope === "all_models",
      )?.models,
    ).toBeUndefined();
  });

  it("keeps the catalog on a stale scope", () => {
    const stale = withQuotaSemantics(
      provider("cursor", [window("auto_usage")], true),
      generatedAt,
    );
    const auto = stale.quotaSemantics?.effectiveAvailability.find(
      (scope) => scope.scope === "pool:auto",
    );
    expect(auto?.status).toBe("unknown");
    expect(auto?.models).toEqual(["composer-*", "grok-*"]);
  });
});
