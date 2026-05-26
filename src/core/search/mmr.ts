/**
 * Maximal Marginal Relevance diversity rerank.
 *
 * After the fused ranking, near-identical results (paraphrases, the
 * same idea re-chunked) can crowd out complementary content. MMR
 * greedily reselects from the pool, trading each candidate's relevance
 * against its similarity to the already-selected set:
 *
 *   argmax over remaining of  lambda * rel(d) - (1 - lambda) * max sim(d, s)
 *
 * `rel(d)` reuses the fused `score` (already in [0, 1]). Similarity is
 * a deterministic token-set Jaccard over chunk content - no embedding
 * round-trip, no language word lists, identical on every Syncthing
 * peer. The function is pure: same input, same output.
 */

import type { BrainSearchResult } from "./types.ts";

export interface MmrOptions {
  /**
   * Relevance-vs-diversity tradeoff in [0, 1]. 1 is pure relevance
   * (identity order); lower values diversify harder. Out-of-range or
   * non-finite values clamp into [0, 1].
   */
  readonly lambda: number;
}

/** Unicode-aware token set: lowercased letter/number runs. */
function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  const matches = text.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (matches) for (const m of matches) out.add(m);
  return out;
}

/** Jaccard overlap of two token sets, in [0, 1]. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (large.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function clampLambda(x: number): number {
  if (!Number.isFinite(x)) return 1;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function withMmrReason(r: BrainSearchResult): BrainSearchResult {
  if (r.reasons.some((x) => x.startsWith("mmr"))) return r;
  return Object.freeze({
    ...r,
    reasons: Object.freeze([...r.reasons, "mmr: reordered"]),
  });
}

/**
 * Reorder `results` (assumed already sorted by fused score desc) using
 * greedy MMR. Returns a new array; results whose final position differs
 * from their input position gain an `"mmr: reordered"` reason. Identity
 * for `lambda == 1` or fewer than two results.
 */
export function mmrRerank(
  results: ReadonlyArray<BrainSearchResult>,
  opts: MmrOptions,
): BrainSearchResult[] {
  const lambda = clampLambda(opts.lambda);
  if (results.length < 2 || lambda >= 1) {
    return results.slice();
  }

  const tokens = results.map((r) => tokenize(r.content));
  const remaining = results.map((_, i) => i);
  const selected: number[] = [];

  while (remaining.length > 0) {
    let bestPos = 0;
    let bestVal = -Infinity;
    for (let k = 0; k < remaining.length; k++) {
      const idx = remaining[k]!;
      let maxSim = 0;
      for (const s of selected) {
        const sim = jaccard(tokens[idx]!, tokens[s]!);
        if (sim > maxSim) maxSim = sim;
      }
      const val = lambda * results[idx]!.score - (1 - lambda) * maxSim;
      // Strict greater keeps the earlier (higher-relevance, since input
      // is score-sorted) candidate on ties - deterministic.
      if (val > bestVal) {
        bestVal = val;
        bestPos = k;
      }
    }
    selected.push(remaining[bestPos]!);
    remaining.splice(bestPos, 1);
  }

  return selected.map((origIdx, finalIdx) => {
    const r = results[origIdx]!;
    return origIdx === finalIdx ? r : withMmrReason(r);
  });
}
