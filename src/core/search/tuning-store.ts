/**
 * Persisted tuned-parameters store (link-recall-intelligence, t_ae973491).
 *
 * The read/reset side of `Brain/search/tuning.json`, the bounded grid
 * axes, and `applyTunedParameters` - split out of `tuning.ts` so
 * `search.ts` can depend on the tuned-parameter READ path without
 * pulling in `tuneRecall`'s benchmark dependency. `tuning.ts` imports
 * the grid bounds and `tuningPath` back from here for its write side
 * (the module graph stays a DAG: tuning.ts -> tuning-store.ts and
 * tuning.ts -> benchmark.ts -> search.ts -> tuning-store.ts, never back
 * to tuning.ts or benchmark.ts).
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { ResolvedSearchConfig, TunedParameters } from "./types.ts";

export const TUNING_SCHEMA_VERSION = "o2b.tuning.v1";

/** Bounded grid axes - loadTunedParameters enforces these on read. */
export const TUNING_POOL_MULTIPLIERS: ReadonlyArray<number> = Object.freeze([3, 4, 5]);
export const TUNING_TRAVERSAL_DEPTHS: ReadonlyArray<number> = Object.freeze([1, 2]);

/**
 * A config with one grid point applied. Always disarms
 * `selfTuningEnabled` so an applied config can never re-apply itself.
 */
export function applyTunedParameters(
  config: ResolvedSearchConfig,
  params: TunedParameters,
): ResolvedSearchConfig {
  return Object.freeze({
    ...config,
    recall: Object.freeze({
      ...config.recall,
      poolMultiplier: params.poolMultiplier,
      maxHops: params.traversalDepth,
      learnedWeightsEnabled: params.learnedWeights,
      selfTuningEnabled: false,
    }),
  });
}

export function tuningPath(vault: string): string {
  return join(vault, "Brain", "search", "tuning.json");
}

/**
 * The persisted tuned parameters, re-validated against the grid
 * bounds. Fail-soft: missing file, torn JSON, or any out-of-bounds
 * value reads as null (search falls back to configured defaults).
 */
export function loadTunedParameters(vault: string): TunedParameters | null {
  const path = tuningPath(vault);
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const chosen = (parsed as { chosen?: unknown }).chosen;
    if (chosen === null || typeof chosen !== "object") return null;
    const c = chosen as Record<string, unknown>;
    if (
      typeof c["poolMultiplier"] !== "number" ||
      !TUNING_POOL_MULTIPLIERS.includes(c["poolMultiplier"]) ||
      typeof c["traversalDepth"] !== "number" ||
      !TUNING_TRAVERSAL_DEPTHS.includes(c["traversalDepth"]) ||
      typeof c["learnedWeights"] !== "boolean" ||
      typeof c["expansion"] !== "boolean"
    ) {
      return null;
    }
    return Object.freeze({
      poolMultiplier: c["poolMultiplier"],
      traversalDepth: c["traversalDepth"],
      learnedWeights: c["learnedWeights"],
      expansion: c["expansion"],
    });
  } catch {
    return null;
  }
}

/** Delete the persisted tuning state. Returns true when it existed. */
export function resetTuning(vault: string): boolean {
  const path = tuningPath(vault);
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}
