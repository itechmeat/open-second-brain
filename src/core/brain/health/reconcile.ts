/**
 * Semantic-health reconciliation surface (F6).
 *
 * Runs the three semantic detectors over already-gathered vault data in
 * one deterministic pass and folds their findings into a single
 * verdict. This is the "truth reconciliation" surface, done without
 * sub-agents: each detector owns a domain, and the verdict escalates by
 * the most serious domain that fired.
 *
 * Pure - the caller is responsible for reading preferences, signals,
 * and the corpus; this module never touches the filesystem.
 */

import type { BrainSignalSign } from "../types.ts";
import {
  detectContradictions,
  type ContradictionFinding,
  type PreferenceForContradiction,
} from "./contradiction.ts";
import {
  detectConceptGaps,
  type ConceptGapFinding,
} from "./concept-gap.ts";
import {
  detectStaleClaims,
  type PreferenceForStaleClaim,
  type StaleClaimFinding,
} from "./stale-claim.ts";

/** A preference shape sufficient for every semantic-health detector. */
export type PreferenceForHealth = PreferenceForContradiction &
  PreferenceForStaleClaim;

export interface SemanticHealthInput {
  readonly preferences: ReadonlyArray<PreferenceForHealth>;
  readonly signSignById: ReadonlyMap<string, BrainSignalSign>;
  /** Signal + preference principle text the concept-gap detector counts over. */
  readonly corpusPrinciples: ReadonlyArray<string>;
  /** Preference topic slugs that already own a concept. */
  readonly coveredTopics: ReadonlyArray<string>;
}

export interface SemanticHealthConfig {
  readonly contradictionJaccard: number;
  readonly conceptGapMinFrequency: number;
  readonly staleClaimMaxAgeDays: number;
  readonly now: Date;
}

/** Mirrors the doctor's `TrustVerdict` ladder. */
export type SemanticHealthVerdict = "clean" | "watch" | "investigate";

export interface SemanticHealthReport {
  readonly contradictions: ReadonlyArray<ContradictionFinding>;
  readonly conceptGaps: ReadonlyArray<ConceptGapFinding>;
  readonly staleClaims: ReadonlyArray<StaleClaimFinding>;
  readonly verdict: SemanticHealthVerdict;
}

export function reconcileSemanticHealth(
  input: SemanticHealthInput,
  config: SemanticHealthConfig,
): SemanticHealthReport {
  const contradictions = detectContradictions(
    input.preferences,
    input.signSignById,
    { jaccard: config.contradictionJaccard },
  );
  const conceptGaps = detectConceptGaps(
    input.corpusPrinciples,
    input.coveredTopics,
    { minFrequency: config.conceptGapMinFrequency },
  );
  const staleClaims = detectStaleClaims(input.preferences, {
    maxAgeDays: config.staleClaimMaxAgeDays,
    now: config.now,
  });

  // A contradiction between two confirmed preferences is the most
  // serious finding - two active rules disagree, so an agent will apply
  // a coin-flip. Gaps and stale claims are quality nudges, not active
  // conflicts, so they only raise a watch.
  let verdict: SemanticHealthVerdict = "clean";
  if (contradictions.length > 0) verdict = "investigate";
  else if (conceptGaps.length > 0 || staleClaims.length > 0) verdict = "watch";

  return { contradictions, conceptGaps, staleClaims, verdict };
}
