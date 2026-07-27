/**
 * Effective ranking weights for one query: the plan's intent profile
 * composed with the opt-in weights learned from explicit feedback.
 */

import {
  composeWeightProfiles,
  isNeutralLearnedWeights,
  readLearnedWeights,
  type LearnedWeights,
} from "../feedback.ts";
import type { QueryPlan, ResolvedSearchConfig, WeightProfile } from "../types.ts";

export interface EffectiveWeights {
  /** Undefined leaves the ranker on its unweighted default. */
  readonly weightProfile: WeightProfile | undefined;
  /**
   * The learned weights that actually moved this ranking, or null when
   * the feature is off or the fold is neutral. Non-null is exactly the
   * condition under which a result explains the learned-weight effect.
   */
  readonly activeLearned: LearnedWeights | null;
}

export function resolveEffectiveWeights(
  config: ResolvedSearchConfig,
  plan: QueryPlan,
): EffectiveWeights {
  const intentProfile = config.recall.intentEnabled ? plan.weightProfile : undefined;
  // Learned recall weights (recall-trust-suite): opt-in multipliers
  // derived from explicit feedback compose with the intent profile.
  // Both factors are bounded, so the product is too; neutral learned
  // weights leave ranking bit-identical.
  const learned = config.recall.learnedWeightsEnabled ? readLearnedWeights(config.vault) : null;
  const activeLearned = learned !== null && !isNeutralLearnedWeights(learned) ? learned : null;
  const weightProfile =
    activeLearned !== null ? composeWeightProfiles(intentProfile, activeLearned) : intentProfile;
  return { weightProfile, activeLearned };
}
