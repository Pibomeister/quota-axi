import type { ProviderId } from "./types.js";

/**
 * Dated model-to-pool catalog for Cursor and Factory Droid.
 *
 * `observed` is the day this page was recorded. A Factory multiplier applies
 * on and after its `from` date and before its `until` date. `until` is
 * exclusive, so Gemini 4 Carbon changes on 2026-12-01.
 *
 * A `prefixes` entry matches only an id that starts with that text and is
 * longer than it. Anything else stays unknown.
 *
 * `pageLabel` is that recorded page label: lowercase, spaces become
 * hyphens, and Claude family names keep a `claude-` prefix. It is not a
 * confirmed Factory registry id. Cursor's recorded context names Cursor
 * Grok as a house model and gives no id, so `pool:auto` does not list one.
 */
export type ModelPoolRule = {
  ids?: readonly string[];
  prefixes?: readonly string[];
};

export type FactoryMultiplierRate = {
  multiplier: number;
  from: string;
  until?: string;
};

export type FactoryMultiplier = {
  pageLabel: string;
  label: string;
  rates: readonly FactoryMultiplierRate[];
};

export type ModelPoolData = {
  observed: string;
  providers: Partial<
    Record<ProviderId, { scopes: Readonly<Record<string, ModelPoolRule>> }>
  >;
  factoryMultipliers: readonly FactoryMultiplier[];
};

export const MODEL_POOL_DATA: ModelPoolData = {
  observed: "2026-11-11",
  providers: {
    droid: {
      scopes: {
        droid_core: {
          ids: [
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
          ],
        },
        other_models: {
          prefixes: ["claude-", "gpt-", "gemini-", "grok-"],
        },
      },
    },
    cursor: {
      scopes: {
        "pool:auto": {
          prefixes: ["composer-"],
        },
        "pool:api": {
          prefixes: ["claude-", "gpt-", "gemini-", "codex-"],
        },
      },
    },
  },
  factoryMultipliers: [
    {
      pageLabel: "claude-opus-5.5",
      label: "Opus 5.5",
      rates: [{ multiplier: 1.6, from: "2026-11-11" }],
    },
    {
      pageLabel: "claude-sonnet-5.5",
      label: "Sonnet 5.5",
      rates: [{ multiplier: 0.8, from: "2026-11-11" }],
    },
    {
      pageLabel: "claude-haiku-5.5",
      label: "Haiku 5.5",
      rates: [{ multiplier: 0.04, from: "2026-11-11" }],
    },
    {
      pageLabel: "claude-fable-5.2",
      label: "Fable 5.2",
      rates: [{ multiplier: 3.2, from: "2026-11-11" }],
    },
    {
      pageLabel: "gpt-6.1-sol",
      label: "GPT-6.1 Sol",
      rates: [{ multiplier: 0.8, from: "2026-11-11" }],
    },
    {
      pageLabel: "gpt-6-luna",
      label: "GPT-6 Luna",
      rates: [{ multiplier: 0.04, from: "2026-11-11" }],
    },
    {
      pageLabel: "gemini-4-carbon",
      label: "Gemini 4 Carbon",
      rates: [
        { multiplier: 0.8, from: "2026-11-11", until: "2026-12-01" },
        { multiplier: 1.6, from: "2026-12-01" },
      ],
    },
    {
      pageLabel: "gemini-3.8-flash",
      label: "Gemini 3.8 Flash",
      rates: [{ multiplier: 0.3, from: "2026-11-11" }],
    },
    {
      pageLabel: "grok-4.7",
      label: "Grok 4.7",
      rates: [{ multiplier: 0.8, from: "2026-11-11" }],
    },
    {
      pageLabel: "glm-5.3-flash",
      label: "GLM-5.3-Flash",
      rates: [{ multiplier: 0.06, from: "2026-11-11" }],
    },
    {
      pageLabel: "minimax-m3.1-flash",
      label: "MiniMax M3.1 Flash",
      rates: [{ multiplier: 0.06, from: "2026-11-11" }],
    },
    {
      pageLabel: "deepseek-v4.1-flash",
      label: "DeepSeek V4.1 Flash",
      rates: [{ multiplier: 0.12, from: "2026-11-11" }],
    },
    {
      pageLabel: "glm-5.3",
      label: "GLM-5.3",
      rates: [{ multiplier: 0.56, from: "2026-11-11" }],
    },
    {
      pageLabel: "kimi-k3.1-pro",
      label: "Kimi K3.1 Pro",
      rates: [{ multiplier: 0.8, from: "2026-11-11" }],
    },
  ],
};
