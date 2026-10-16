/**
 * Per-pack retrieval trust receipts (t_5f61130a).
 *
 * Two compact-reference receipts the retrieval path attaches to every
 * pack once the trust gate is engaged, consistent with the existing
 * context-receipt model (src/core/brain/context-receipts.ts): they
 * reference candidates by id / path and carry counts and structural
 * reasons only - they never duplicate result bodies.
 *
 *   - retrieval_decision_trace: the accountability record of what the
 *     gate excluded and why, so quarantined material is counted, never
 *     silently dropped.
 *   - memory_trust_assessment: the pack's trust posture - how many
 *     candidates were evaluated, how many surfaced, and a histogram of
 *     the exclusion reasons.
 *
 * Both are pure builders over the kernel-1 outcome; snake_cased to match
 * the receipt payload convention.
 *
 * Shadow measurements (session-mining-economy, t_05a0eaa4): under the
 * gate's measure-only mode the receipts gain a refusal section beside the
 * exclusion counts - `excluded` keeps meaning actually dropped, and a
 * would-be refusal is counted with its structural reasons, reported per
 * lane (the rank-adjust pool and the relational arm separately) so
 * neither lane's numbers blur. Enforce receipts carry no refusal section
 * of their own for the pool lane - the pool's drops ARE the exclusions -
 * but the relational arm's drops happen BEFORE the pool, where no
 * exclusion can ever name them, so those ride the same refusal record:
 * the gate's never-silently-dropped posture holds on both lanes. Every
 * receipt an arm-less enforce run ever built stays byte-identical: the
 * enforce section is present only when the arm actually dropped
 * something - absent, never an empty placeholder.
 */

import type { RankAdjustExclusion } from "../../search/rank-adjust.ts";

/**
 * The lane a measured refusal came from: the kernel rank-adjust pool
 * (the page gate) or the relational arm's edge-level eligibility gate.
 * Lanes are reported separately and never folded together.
 */
export const RETRIEVAL_TRUST_REFUSAL_LANE = Object.freeze({
  pool: "pool",
  arm: "arm",
} as const);

export type RetrievalTrustRefusalLane =
  (typeof RETRIEVAL_TRUST_REFUSAL_LANE)[keyof typeof RETRIEVAL_TRUST_REFUSAL_LANE];

/**
 * One measured-only refusal as a compact reference (no body): a
 * candidate the eligibility classification marked ineligible that shadow
 * kept in the pool (or the arm kept in its contribution set).
 */
export interface RetrievalTrustRefusal {
  readonly document_id: number;
  readonly chunk_id: number;
  readonly path: string;
  /** Structural reason tokens, namespaced by their origin, sorted. */
  readonly reasons: ReadonlyArray<string>;
  readonly lane: RetrievalTrustRefusalLane;
}

/** The shadow-only section both receipt builders project. */
export interface RetrievalShadowRefusals {
  readonly refusals: ReadonlyArray<RetrievalTrustRefusal>;
}

/**
 * The enforce-mode section: the relational arm's drops. The arm removes an
 * ineligible node before the pool, so no pool exclusion can name it; these
 * refusal records are the drop's only receipt. Mutually exclusive with the
 * `shadow` section by construction - a run resolves exactly one mode.
 */
export interface RetrievalEnforcedRefusals {
  readonly refusals: ReadonlyArray<RetrievalTrustRefusal>;
}

export interface RetrievalReceiptInput {
  /** Count of candidates that survived the gate into the pack. */
  readonly surfaced: number;
  /** Candidates the gate excluded, with their namespaced reasons. */
  readonly excluded: ReadonlyArray<RankAdjustExclusion>;
  /**
   * Present only under the shadow mode: the would-be refusals measured
   * beside an untouched exclusion count. Absent - never an empty
   * placeholder - under enforce, whose receipts keep today's shape.
   */
  readonly shadow?: RetrievalShadowRefusals;
  /**
   * Present only under enforce, and only when the relational arm actually
   * dropped an arrival: the arm lane's refusal records, the drop's only
   * receipt. Absent otherwise, so every enforce receipt an arm-less run
   * ever built is byte-identical.
   */
  readonly enforce?: RetrievalEnforcedRefusals;
}

/** One excluded candidate as a compact reference (no body). */
export interface RetrievalDecisionTraceExclusion {
  readonly document_id: number;
  readonly chunk_id: number;
  readonly path: string;
  readonly reasons: ReadonlyArray<string>;
}

export interface RetrievalDecisionTrace {
  readonly evaluated: number;
  readonly surfaced: number;
  readonly excluded: number;
  readonly exclusions: ReadonlyArray<RetrievalDecisionTraceExclusion>;
  /** Present only under shadow: the mode the receipts were built under. */
  readonly mode?: "shadow";
  /**
   * Refusal records riding the trace: under shadow, every would-be
   * refusal across both lanes (pool then arm); under enforce, the
   * relational arm's drops - removed before the pool, where no exclusion
   * can name them. Present only when there are records - never an empty
   * placeholder.
   */
  readonly refused?: number;
  /** The refusal records themselves, same presence rule as `refused`. */
  readonly refusals?: ReadonlyArray<RetrievalTrustRefusal>;
}

export interface MemoryTrustAssessment {
  readonly evaluated: number;
  readonly surfaced: number;
  readonly quarantined: number;
  /** Histogram of namespaced exclusion reasons across the excluded set. */
  readonly reason_counts: Readonly<Record<string, number>>;
  /** Present only under shadow: the mode the receipts were built under. */
  readonly mode?: "shadow";
  /**
   * Refusal aggregates for the records riding the receipts: under shadow,
   * every would-be refusal across both lanes; under enforce, the
   * relational arm's drops (the pool lane's drops are the exclusions
   * above, counted in `quarantined`). Present only when there are
   * records - never an empty placeholder.
   */
  readonly refused?: number;
  /**
   * Present with the refusal records: would-be refusal count per lane. A
   * lane with no refusals is present at 0 - a measured zero, not an
   * absence.
   */
  readonly refusals_by_lane?: Readonly<Record<string, number>>;
  /**
   * Present with the refusal records: the refusal reason histogram per
   * lane, keys sorted for a byte-stable serialization.
   */
  readonly refused_reason_counts?: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

/**
 * Sort an object's keys into a new frozen record so a serialized
 * histogram is byte-stable for a given input.
 */
function sortedRecord<T>(input: Record<string, T>): Readonly<Record<string, T>> {
  const ordered: Record<string, T> = {};
  for (const key of Object.keys(input).toSorted()) ordered[key] = input[key]!;
  return Object.freeze(ordered);
}

/**
 * Build the per-lane refusal aggregates for the shadow section: the
 * total, the per-lane counts (every known lane present, 0 included) and
 * the per-lane reason histograms with sorted keys.
 */
function refusalAggregates(refusals: ReadonlyArray<RetrievalTrustRefusal>): {
  readonly refused: number;
  readonly refusals_by_lane: Readonly<Record<string, number>>;
  readonly refused_reason_counts: Readonly<Record<string, Readonly<Record<string, number>>>>;
} {
  const lanes: Record<string, number> = {};
  const histograms: Record<string, Record<string, number>> = {};
  for (const lane of Object.values(RETRIEVAL_TRUST_REFUSAL_LANE)) {
    lanes[lane] = 0;
    histograms[lane] = {};
  }
  for (const refusal of refusals) {
    lanes[refusal.lane] = (lanes[refusal.lane] ?? 0) + 1;
    const histogram = (histograms[refusal.lane] ??= {});
    for (const reason of refusal.reasons) {
      histogram[reason] = (histogram[reason] ?? 0) + 1;
    }
  }
  const orderedHistograms: Record<string, Readonly<Record<string, number>>> = {};
  for (const [lane, histogram] of Object.entries(histograms)) {
    orderedHistograms[lane] = sortedRecord(histogram);
  }
  return {
    refused: refusals.length,
    refusals_by_lane: sortedRecord(lanes),
    refused_reason_counts: sortedRecord(orderedHistograms),
  };
}

/**
 * Build the retrieval_decision_trace: every excluded candidate as a
 * compact reference (document / chunk id, path, reasons), plus the
 * evaluated / surfaced / excluded counts. Under shadow the would-be
 * refusals ride beside them with the mode named; under enforce the
 * relational arm's drops ride the same refusal record (no mode stamp -
 * an enforce receipt never names itself shadow), and a run where the arm
 * dropped nothing keeps the pre-mode shape exactly.
 */
export function buildRetrievalDecisionTrace(input: RetrievalReceiptInput): RetrievalDecisionTrace {
  const exclusions = input.excluded.map((e) =>
    Object.freeze({
      document_id: e.documentId,
      chunk_id: e.chunkId,
      path: e.path,
      reasons: [...e.reasons],
    }),
  );
  return Object.freeze({
    evaluated: input.surfaced + input.excluded.length,
    surfaced: input.surfaced,
    excluded: input.excluded.length,
    exclusions: Object.freeze(exclusions),
    ...(input.shadow === undefined
      ? {}
      : {
          mode: "shadow",
          refused: input.shadow.refusals.length,
          refusals: Object.freeze([...input.shadow.refusals]),
        }),
    ...(input.enforce === undefined
      ? {}
      : {
          refused: input.enforce.refusals.length,
          refusals: Object.freeze([...input.enforce.refusals]),
        }),
  });
}

/**
 * Build the memory_trust_assessment: the pack's trust posture as counts
 * plus a deterministic histogram of the exclusion reasons. Under shadow
 * the would-be refusals are aggregated per lane beside them - never
 * folded into `quarantined`, which keeps meaning actually dropped. Under
 * enforce the arm's drops aggregate the same way; a run where the arm
 * dropped nothing keeps the pre-mode shape exactly.
 */
export function buildMemoryTrustAssessment(input: RetrievalReceiptInput): MemoryTrustAssessment {
  const reasonCounts: Record<string, number> = {};
  for (const exclusion of input.excluded) {
    for (const reason of exclusion.reasons) {
      reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
    }
  }
  return Object.freeze({
    evaluated: input.surfaced + input.excluded.length,
    surfaced: input.surfaced,
    quarantined: input.excluded.length,
    reason_counts: sortedRecord(reasonCounts),
    ...(input.shadow === undefined
      ? {}
      : { mode: "shadow", ...refusalAggregates(input.shadow.refusals) }),
    ...(input.enforce === undefined ? {} : refusalAggregates(input.enforce.refusals)),
  });
}
