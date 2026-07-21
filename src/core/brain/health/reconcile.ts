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
import { detectConceptGaps, latestEntryMsByTerm, type ConceptGapFinding } from "./concept-gap.ts";
import { parseIsoUtc } from "./iso-time.ts";
import {
  detectStaleClaims,
  type PreferenceForStaleClaim,
  type StaleClaimFinding,
} from "./stale-claim.ts";
import {
  detectBatchInflation,
  type BatchInflationFinding,
  type PreferenceForBatchInflation,
} from "./batch-inflation.ts";

/** A preference shape sufficient for every semantic-health detector. */
export type PreferenceForHealth = PreferenceForContradiction &
  PreferenceForStaleClaim &
  PreferenceForBatchInflation;

export interface SemanticHealthInput {
  readonly preferences: ReadonlyArray<PreferenceForHealth>;
  readonly signSignById: ReadonlyMap<string, BrainSignalSign>;
  /** Signal + preference principle text the concept-gap detector counts over. */
  readonly corpusPrinciples: ReadonlyArray<string>;
  /**
   * Per-entry authored dates, aligned index-for-index with
   * {@link corpusPrinciples}. Only consulted when a `silenceBefore`
   * watermark is set, to decide whether every entry mentioning a gap
   * term predates the watermark. An entry with no parseable date (a
   * `null` slot, a missing slot, or an unparseable string) is treated as
   * NEWER than any watermark, so the filter can only ever hide what is
   * provably old. Absent entirely: no concept gap is watermark-eligible.
   */
  readonly corpusPrincipleDates?: ReadonlyArray<string | null>;
  /** Preference topic slugs that already own a concept. */
  readonly coveredTopics: ReadonlyArray<string>;
}

export interface SemanticHealthConfig {
  readonly contradictionJaccard: number;
  readonly conceptGapMinFrequency: number;
  readonly staleClaimMaxAgeDays: number;
  readonly batchInflationWindowHours?: number;
  readonly batchInflationMinBurstSize?: number;
  /**
   * Optional acknowledge-before watermark (`health.silence_before`). When
   * set, advisory concept-gap and batch-inflation findings that are
   * entirely older than this instant are hidden from the surfaced
   * report and the verdict. Absent: behavior is byte-identical to a
   * build without the feature. An unparseable value throws rather than
   * silently disabling the filter.
   */
  readonly silenceBefore?: string;
  readonly now: Date;
}

/** Mirrors the doctor's `TrustVerdict` ladder. */
export type SemanticHealthVerdict = "clean" | "watch" | "investigate";

/**
 * Count of advisory findings hidden by the `silenceBefore` watermark,
 * with the baseline that hid them. Present only when a watermark is set
 * AND it suppressed at least one finding, so an unset watermark keeps the
 * report byte-identical and silent hiding never happens.
 */
export interface SemanticHealthSuppression {
  readonly conceptGaps: number;
  readonly batchInflation: number;
  readonly baseline: string;
}

export interface SemanticHealthReport {
  readonly contradictions: ReadonlyArray<ContradictionFinding>;
  readonly conceptGaps: ReadonlyArray<ConceptGapFinding>;
  readonly staleClaims: ReadonlyArray<StaleClaimFinding>;
  readonly batchInflation: ReadonlyArray<BatchInflationFinding>;
  readonly verdict: SemanticHealthVerdict;
  readonly suppressed?: SemanticHealthSuppression;
}

export function reconcileSemanticHealth(
  input: SemanticHealthInput,
  config: SemanticHealthConfig,
): SemanticHealthReport {
  const contradictions = detectContradictions(input.preferences, input.signSignById, {
    jaccard: config.contradictionJaccard,
  });
  const allConceptGaps = detectConceptGaps(input.corpusPrinciples, input.coveredTopics, {
    minFrequency: config.conceptGapMinFrequency,
  });
  const staleClaims = detectStaleClaims(input.preferences, {
    maxAgeDays: config.staleClaimMaxAgeDays,
    now: config.now,
  });
  const allBatchInflation = detectBatchInflation(input.preferences, {
    ...(config.batchInflationWindowHours !== undefined
      ? { windowHours: config.batchInflationWindowHours }
      : {}),
    ...(config.batchInflationMinBurstSize !== undefined
      ? { minBurstSize: config.batchInflationMinBurstSize }
      : {}),
  });

  // Acknowledge-before watermark: hide advisory findings the operator has
  // already seen and accepted. Detection above is untouched; this is a
  // surfacing filter over its output.
  const { conceptGaps, batchInflation, suppressed } = applyBaseline(
    allConceptGaps,
    allBatchInflation,
    input,
    config.silenceBefore,
  );

  // A contradiction between two confirmed preferences is the most
  // serious finding - two active rules disagree, so an agent will apply
  // a coin-flip. Gaps, stale claims, and batch-inflation bursts are
  // quality nudges, not active conflicts, so they only raise a watch.
  // The verdict folds the SURFACED findings, so a fully-acknowledged
  // burst no longer pins `watch`.
  let verdict: SemanticHealthVerdict = "clean";
  if (contradictions.length > 0) verdict = "investigate";
  else if (conceptGaps.length > 0 || staleClaims.length > 0 || batchInflation.length > 0)
    verdict = "watch";

  return {
    contradictions,
    conceptGaps,
    staleClaims,
    batchInflation,
    verdict,
    ...(suppressed !== null ? { suppressed } : {}),
  };
}

/**
 * Partition the advisory findings into what surfaces and what the
 * watermark hides. When `silenceBefore` is absent the inputs pass through
 * untouched and `suppressed` is `null`, keeping the report byte-identical
 * to a build without the feature.
 */
function applyBaseline(
  conceptGaps: ReadonlyArray<ConceptGapFinding>,
  batchInflation: ReadonlyArray<BatchInflationFinding>,
  input: SemanticHealthInput,
  silenceBefore: string | undefined,
): {
  conceptGaps: ReadonlyArray<ConceptGapFinding>;
  batchInflation: ReadonlyArray<BatchInflationFinding>;
  suppressed: SemanticHealthSuppression | null;
} {
  if (silenceBefore === undefined) {
    return { conceptGaps, batchInflation, suppressed: null };
  }
  const watermarkMs = parseIsoUtc(silenceBefore);
  if (!Number.isFinite(watermarkMs)) {
    throw new Error(
      `silenceBefore is not a parseable ISO-8601 date or timestamp: ${JSON.stringify(silenceBefore)}`,
    );
  }

  // A burst is hidden when its whole window predates the watermark, i.e.
  // its newest member (`windowEnd`) is strictly older than the baseline.
  const survivingBatch = batchInflation.filter((b) => {
    const endMs = parseIsoUtc(b.windowEnd);
    return !(Number.isFinite(endMs) && endMs < watermarkMs);
  });

  // A gap is hidden only when EVERY corpus entry mentioning its term is
  // older than the watermark. An entry with no parseable date counts as
  // newer than any watermark (Infinity), so it keeps the gap visible.
  const latestByTerm = latestEntryMsByTerm(input.corpusPrinciples, input.corpusPrincipleDates);
  const survivingGaps = conceptGaps.filter((g) => {
    const latest = latestByTerm.get(g.term) ?? Number.POSITIVE_INFINITY;
    return latest >= watermarkMs;
  });

  const conceptGapsHidden = conceptGaps.length - survivingGaps.length;
  const batchHidden = batchInflation.length - survivingBatch.length;
  if (conceptGapsHidden === 0 && batchHidden === 0) {
    return { conceptGaps, batchInflation, suppressed: null };
  }
  return {
    conceptGaps: survivingGaps,
    batchInflation: survivingBatch,
    suppressed: {
      conceptGaps: conceptGapsHidden,
      batchInflation: batchHidden,
      baseline: silenceBefore,
    },
  };
}
