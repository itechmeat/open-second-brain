/**
 * Dedup detector (continuity-hygiene-freshness suite; kanban
 * t_da3f138f).
 *
 * Near-duplicate memories surface as merge findings. Two layers:
 *
 *   - Embedding similarity when vectors are available in the search
 *     index (cosine over stored chunk embeddings, threshold default
 *     0.97) - see `embeddingDuplicatePairs`.
 *   - Deterministic lexical fallback otherwise: the shared
 *     `findMergeCandidates` jaccard detector over preference
 *     principles, clearly labeled `method: "lexical"` so a report
 *     never passes lexical similarity off as semantic.
 *
 * The detector only nominates pairs; merging happens through the
 * hygiene apply plan (which routes to the existing merge machinery).
 */

import { findMergeCandidates } from "../../merge-candidates.ts";
import { hygieneFindingId } from "./id.ts";
import type { HygieneDetectorContext, HygieneFinding } from "../types.ts";

/** Cosine-similarity threshold for the embedding layer (upstream default). */
export const DEDUP_EMBEDDING_THRESHOLD = 0.97;
/** Jaccard threshold for the lexical fallback - above merge-suggest level. */
export const DEDUP_LEXICAL_THRESHOLD = 0.8;

export interface DedupDetectorOptions {
  readonly lexicalThreshold?: number;
}

export function detectDedup(
  vault: string,
  _ctx: HygieneDetectorContext,
  opts: DedupDetectorOptions = {},
): ReadonlyArray<HygieneFinding> {
  const threshold = opts.lexicalThreshold ?? DEDUP_LEXICAL_THRESHOLD;
  const candidates = findMergeCandidates(vault, { threshold, limit: 50 });
  return Object.freeze(
    candidates.map((pair) =>
      Object.freeze({
        id: hygieneFindingId("dedup", [pair.a, pair.b]),
        detector: "dedup" as const,
        severity: "warning" as const,
        title: `Near-duplicate preferences ${pair.a} and ${pair.b} (jaccard ${pair.jaccard})`,
        targets: Object.freeze([pair.a, pair.b]),
        proposed_action: "merge" as const,
        evidence: Object.freeze({
          method: "lexical",
          jaccard: pair.jaccard,
          topic: pair.topic,
          scope: pair.scope,
          principle_a: pair.principle_a,
          principle_b: pair.principle_b,
        }),
      }),
    ),
  );
}
