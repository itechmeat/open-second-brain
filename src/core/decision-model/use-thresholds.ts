/**
 * The threshold a use compares its answer against (design D10, D13): the
 * value stored in the thresholds store for the model that answered and
 * the use, the vault's override first, else the built-in default. A
 * stored value is what `o2b decision-model thresholds set` writes, so an
 * operator who tunes a use from shadow data gets exactly that value. A
 * stored value outside 0..1 is ignored for the built-in one.
 */

import type { ResolvedDecisionModelConfig } from "./config-types.ts";
import type { DecisionModelUse } from "./contract.ts";
import { BUILTIN_USE_THRESHOLDS } from "./questions.ts";
import { effectiveThresholds, readThresholdsStore, EMPTY_THRESHOLD_STORE } from "./thresholds.ts";

/**
 * The value of threshold `name` that `use` applies to an answer from
 * `model`. Never throws: an unreadable store gives the built-in value.
 */
export function appliedThreshold(
  cfg: ResolvedDecisionModelConfig,
  use: DecisionModelUse,
  model: string | null,
  name: string,
): number {
  const builtin = (BUILTIN_USE_THRESHOLDS[use] as Readonly<Record<string, number>>)[name];
  try {
    const path = cfg.thresholdsPath ?? null;
    const store = path === null ? EMPTY_THRESHOLD_STORE : readThresholdsStore(path);
    const value = effectiveThresholds(store, model, use, cfg.vault)[name];
    // Only a probability: a value outside 0..1 (a hand edit or a damaged
    // file; the CLI refuses to write one) would turn every answer on or
    // off, so it is ignored.
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1) {
      return value;
    }
  } catch {
    // The built-in value below.
  }
  // Every use has its built-in set (a typed record), so this is defined.
  return builtin as number;
}
