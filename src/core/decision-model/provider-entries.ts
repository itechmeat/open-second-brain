/**
 * The provider chain of a resolved config, split out of `config.ts` so
 * the private-data guard (`egress-guard.ts`) can read the chain without
 * importing the resolver (and its endpoint validation) - the one import
 * edge that would otherwise close a cycle between the two.
 */

import { DECISION_MODEL_WIRE_MAX_CHOICE_OPTIONS } from "./presets.ts";
import type { ResolvedDecisionModelConfig, ResolvedDecisionProvider } from "./config-types.ts";

/**
 * The provider chain of a resolved config, first entry first. A config
 * resolved from `decision_model_providers` carries its entries; a config
 * built before the chain existed (hand-built test configs, older stored
 * objects) derives the single implied entry from its top-level fields, so
 * the callers of the chain behave identically on both shapes.
 */
export function resolvedProviderEntries(
  cfg: ResolvedDecisionModelConfig,
): ReadonlyArray<ResolvedDecisionProvider> {
  if (cfg.providers !== undefined && cfg.providers.length > 0) return cfg.providers;
  return Object.freeze([
    {
      name: cfg.provider ?? "unknown",
      adapter: cfg.adapter,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      envKey: cfg.envKey,
      keyPresent: cfg.keyPresent,
      keyRequired: cfg.keyRequired !== false,
      maxStateTokens: cfg.maxStateTokens,
      maxChoiceOptions: cfg.maxChoiceOptions ?? DECISION_MODEL_WIRE_MAX_CHOICE_OPTIONS,
      calibrated: cfg.calibrated,
      inputPriceUsdPerMtok: cfg.inputPriceUsdPerMtok,
      outputPriceUsdPerMtok: cfg.outputPriceUsdPerMtok ?? null,
      thresholdProfile: cfg.thresholdProfile ?? null,
      licenceNote: cfg.licenceNote ?? null,
      processor: cfg.processor,
      uses: cfg.uses,
      shadowOnlyUses: cfg.shadowOnlyUses ?? Object.freeze([]),
    },
  ]);
}
