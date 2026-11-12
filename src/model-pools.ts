import {
  MODEL_POOL_DATA,
  type FactoryMultiplier,
  type ModelPoolRule,
} from "./model-pools.data.js";

export { MODEL_POOL_DATA, type ModelPoolData } from "./model-pools.data.js";
import type { ProviderId } from "./types.js";

/** A model id the catalog does not place. Never a guessed scope. */
export const UNKNOWN_MODEL_POOL = "unknown";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Scope that limits `modelId` for this provider, or `unknown`.
 * Exact ids win only inside one scope. Two matching scopes stay unknown.
 */
export function resolveModelPool(
  provider: ProviderId,
  modelId: string,
): string {
  const scopes = MODEL_POOL_DATA.providers[provider]?.scopes;
  if (!scopes) return UNKNOWN_MODEL_POOL;
  return resolveModelPoolRules(scopes, modelId);
}

/**
 * Matchers published beside a scope. A trailing `*` is a prefix rule.
 * Empty when this provider has no catalog row for the scope.
 */
export function modelPoolMatchers(
  provider: ProviderId,
  scope: string,
): string[] {
  const rule = MODEL_POOL_DATA.providers[provider]?.scopes[scope];
  if (!rule) return [];
  return [
    ...(rule.ids ?? []),
    ...(rule.prefixes ?? []).map((prefix) => `${prefix}*`),
  ];
}

/**
 * Factory multiplier recorded for page label `modelId` on calendar day `on`.
 * The key is the recorded page label, not a confirmed registry id.
 * Missing when the label or the day has no recorded rate.
 */
export function factoryMultiplier(
  modelId: string,
  on: string,
): number | undefined {
  const day = calendarDay(on);
  if (!day) return undefined;
  const entry = MODEL_POOL_DATA.factoryMultipliers.find(
    (candidate) => candidate.pageLabel === modelId.trim(),
  );
  if (!entry) return undefined;
  const rate = entry.rates.find((candidate) => rateCovers(candidate, day));
  return rate?.multiplier;
}

export function resolveModelPoolRules(
  scopes: Readonly<Record<string, ModelPoolRule>>,
  modelId: string,
): string {
  const id = modelId.trim();
  if (!id) return UNKNOWN_MODEL_POOL;
  const hits: string[] = [];
  for (const [scope, rule] of Object.entries(scopes)) {
    const exact = rule.ids?.includes(id) ?? false;
    const prefixed =
      rule.prefixes?.some(
        (prefix) => id.startsWith(prefix) && id.length > prefix.length,
      ) ?? false;
    if (exact || prefixed) hits.push(scope);
  }
  const [only] = hits;
  return hits.length === 1 && only !== undefined ? only : UNKNOWN_MODEL_POOL;
}

function rateCovers(
  rate: FactoryMultiplier["rates"][number],
  day: string,
): boolean {
  return rate.from <= day && (rate.until === undefined || day < rate.until);
}

function calendarDay(value: string): string | undefined {
  if (!DAY.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString().slice(0, 10) === value ? value : undefined;
}

function assertCatalog(): void {
  if (!calendarDay(MODEL_POOL_DATA.observed)) {
    throw new Error("model pool catalog observed date is not a calendar day");
  }
  const multiplierIds = new Set<string>();
  for (const entry of MODEL_POOL_DATA.factoryMultipliers) {
    if (multiplierIds.has(entry.pageLabel)) {
      throw new Error(`duplicate Factory page label ${entry.pageLabel}`);
    }
    multiplierIds.add(entry.pageLabel);
    if (resolveModelPool("droid", entry.pageLabel) === UNKNOWN_MODEL_POOL) {
      throw new Error(
        `${entry.pageLabel} has a multiplier and no Factory pool`,
      );
    }
    assertRates(entry);
  }
  for (const [provider, catalog] of Object.entries(MODEL_POOL_DATA.providers)) {
    if (!catalog) continue;
    for (const [scope, rule] of Object.entries(catalog.scopes)) {
      for (const id of rule.ids ?? []) {
        if (resolveModelPool(provider as ProviderId, id) !== scope) {
          throw new Error(`${provider} id ${id} does not resolve to ${scope}`);
        }
      }
      for (const prefix of rule.prefixes ?? []) {
        if (!prefix || prefix.includes("*")) {
          throw new Error(`${provider} prefix ${prefix} is not a plain prefix`);
        }
        const sample = `${prefix}sample`;
        if (resolveModelPool(provider as ProviderId, sample) !== scope) {
          throw new Error(
            `${provider} prefix ${prefix} does not resolve to ${scope}`,
          );
        }
      }
    }
  }
}

function assertRates(entry: FactoryMultiplier): void {
  if (entry.rates.length === 0) {
    throw new Error(`${entry.pageLabel} has no multiplier rates`);
  }
  let previousUntil: string | undefined;
  entry.rates.forEach((rate, index) => {
    if (!calendarDay(rate.from) || !(rate.multiplier > 0)) {
      throw new Error(
        `${entry.pageLabel} rate ${index} is not a dated positive multiplier`,
      );
    }
    if (rate.until !== undefined && !calendarDay(rate.until)) {
      throw new Error(
        `${entry.pageLabel} rate ${index} until is not a calendar day`,
      );
    }
    if (rate.until !== undefined && rate.until <= rate.from) {
      throw new Error(`${entry.pageLabel} rate ${index} ends before it starts`);
    }
    if (index === 0 && rate.from !== MODEL_POOL_DATA.observed) {
      throw new Error(`${entry.pageLabel} does not start on the observed date`);
    }
    if (index > 0 && rate.from !== previousUntil) {
      throw new Error(`${entry.pageLabel} rates leave a gap or an overlap`);
    }
    if (index < entry.rates.length - 1 && rate.until === undefined) {
      throw new Error(
        `${entry.pageLabel} has an open rate before the last one`,
      );
    }
    previousUntil = rate.until;
  });
}

assertCatalog();
