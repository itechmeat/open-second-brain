/**
 * Kernel 1 - the deterministic retrieval rank-adjustment sink
 * (t_5f61130a).
 *
 * One stage between ranking and result emission where registered
 * adjusters return a verdict per candidate:
 *   - `keep`     - no change,
 *   - `multiply` - scale the candidate's score by a bounded factor and
 *                  append an explainability reason,
 *   - `exclude`  - drop the candidate from the pool and record it (with
 *                  reasons) so it is counted, never silently dropped.
 *
 * The sink is a pure function: callers (search.ts) build the adjuster
 * list per query and hand in the already-ranked pool. It is mounted on
 * BOTH the semantic and the pure-lexical paths because both flow through
 * the same ranked pool before the final slice.
 *
 * Byte-identical opt-out is the load-bearing invariant: with no adjuster
 * registered - and when every adjuster only ever returns `keep` or a
 * neutral `multiply(1)` - the exact input array is returned unchanged
 * (same reference, same objects), so a vault that engages no adjuster
 * ranks bit-identically to pre-kernel behaviour.
 *
 * Language-agnostic by construction: an adjuster's verdict carries a
 * structural reason token it chooses, never a natural-language word list.
 */

import { clamp01 } from "../math.ts";
import type { BrainSearchResult } from "./types.ts";

/** A per-candidate verdict returned by a {@link RankAdjuster}. */
export type RankAdjustVerdict =
  | { readonly kind: "keep" }
  | { readonly kind: "multiply"; readonly factor: number; readonly reason: string }
  | { readonly kind: "exclude"; readonly reason: string };

/** Keep the candidate unchanged. */
export function keepVerdict(): RankAdjustVerdict {
  return KEEP;
}
const KEEP: RankAdjustVerdict = Object.freeze({ kind: "keep" });

/** Scale the candidate's score by `factor`, tagging it with `reason`. */
export function multiplyVerdict(factor: number, reason: string): RankAdjustVerdict {
  return Object.freeze({ kind: "multiply", factor, reason });
}

/** Drop the candidate from the pool, recording `reason`. */
export function excludeVerdict(reason: string): RankAdjustVerdict {
  return Object.freeze({ kind: "exclude", reason });
}

/**
 * One registered adjuster. `name` namespaces the reasons it emits so a
 * receipt can attribute an exclusion / fade to the adjuster that caused
 * it. `adjust` is pure over the single candidate it is handed.
 */
export interface RankAdjuster {
  readonly name: string;
  adjust(result: BrainSearchResult): RankAdjustVerdict;
}

/** A candidate the sink removed, with the namespaced reasons why. */
export interface RankAdjustExclusion {
  readonly documentId: number;
  readonly chunkId: number;
  readonly path: string;
  readonly reasons: ReadonlyArray<string>;
}

/** The sink's output: surviving results plus the recorded exclusions. */
export interface RankAdjustOutcome {
  readonly results: ReadonlyArray<BrainSearchResult>;
  readonly excluded: ReadonlyArray<RankAdjustExclusion>;
}

const EMPTY_EXCLUSIONS: ReadonlyArray<RankAdjustExclusion> = Object.freeze([]);

/**
 * Apply every registered adjuster to every candidate.
 *
 * For each candidate the sink collects verdicts from all adjusters:
 * any `exclude` removes the candidate (its reasons, from every adjuster
 * that excluded, are recorded), otherwise the `multiply` factors compose
 * as a product and the reasons are appended. Survivors are re-sorted by
 * the ranker's tie-break family only when a score actually moved or a
 * candidate was excluded; when nothing changes the input array is
 * returned unchanged.
 */
export function applyRankAdjusters(
  ranked: ReadonlyArray<BrainSearchResult>,
  adjusters: ReadonlyArray<RankAdjuster>,
): RankAdjustOutcome {
  if (adjusters.length === 0) return { results: ranked, excluded: EMPTY_EXCLUSIONS };

  const survivors: BrainSearchResult[] = [];
  const excluded: RankAdjustExclusion[] = [];
  let changed = false;

  for (const candidate of ranked) {
    const excludeReasons: string[] = [];
    const multiplyReasons: string[] = [];
    let factor = 1;
    for (const adjuster of adjusters) {
      const verdict = adjuster.adjust(candidate);
      if (verdict.kind === "exclude") {
        excludeReasons.push(`${adjuster.name}:${verdict.reason}`);
      } else if (verdict.kind === "multiply" && verdict.factor !== 1) {
        factor *= verdict.factor;
        multiplyReasons.push(`${adjuster.name}:${verdict.reason}`);
      }
    }

    if (excludeReasons.length > 0) {
      changed = true;
      excluded.push(
        Object.freeze({
          documentId: candidate.documentId,
          chunkId: candidate.chunkId,
          path: candidate.path,
          reasons: Object.freeze(excludeReasons),
        }),
      );
      continue;
    }

    if (factor === 1) {
      survivors.push(candidate);
      continue;
    }

    changed = true;
    survivors.push(
      Object.freeze({
        ...candidate,
        score: clamp01(candidate.score * factor),
        reasons: Object.freeze([...candidate.reasons, ...multiplyReasons]),
      }),
    );
  }

  if (!changed) return { results: ranked, excluded: EMPTY_EXCLUSIONS };

  // Same tie-break family as the ranker and the relation-polarity phase:
  // score desc, keywordScore desc, chunkId asc - deterministic for equal
  // scores.
  survivors.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.keywordScore !== a.keywordScore) return b.keywordScore - a.keywordScore;
    return a.chunkId - b.chunkId;
  });

  return { results: survivors, excluded: Object.freeze(excluded) };
}
