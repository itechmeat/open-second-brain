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
 */

import type { RankAdjustExclusion } from "../../search/rank-adjust.ts";

export interface RetrievalReceiptInput {
  /** Count of candidates that survived the gate into the pack. */
  readonly surfaced: number;
  /** Candidates the gate excluded, with their namespaced reasons. */
  readonly excluded: ReadonlyArray<RankAdjustExclusion>;
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
}

export interface MemoryTrustAssessment {
  readonly evaluated: number;
  readonly surfaced: number;
  readonly quarantined: number;
  /** Histogram of namespaced exclusion reasons across the excluded set. */
  readonly reason_counts: Readonly<Record<string, number>>;
}

/**
 * Build the retrieval_decision_trace: every excluded candidate as a
 * compact reference (document / chunk id, path, reasons), plus the
 * evaluated / surfaced / excluded counts.
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
  });
}

/**
 * Build the memory_trust_assessment: the pack's trust posture as counts
 * plus a deterministic histogram of the exclusion reasons.
 */
export function buildMemoryTrustAssessment(input: RetrievalReceiptInput): MemoryTrustAssessment {
  const reasonCounts: Record<string, number> = {};
  for (const exclusion of input.excluded) {
    for (const reason of exclusion.reasons) {
      reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
    }
  }
  // Sort keys so the serialized histogram is byte-stable for a given input.
  const ordered: Record<string, number> = {};
  for (const key of Object.keys(reasonCounts).toSorted()) ordered[key] = reasonCounts[key]!;
  return Object.freeze({
    evaluated: input.surfaced + input.excluded.length,
    surfaced: input.surfaced,
    quarantined: input.excluded.length,
    reason_counts: Object.freeze(ordered),
  });
}
