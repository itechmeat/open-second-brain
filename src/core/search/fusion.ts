/**
 * Rank-fusion strategies for hybrid recall (Embedding Provider Suite).
 *
 * The default `linear` mode (a weighted sum of min-max-normalised BM25
 * and cosine, computed in `ranker.ts`) is unchanged. This module adds
 * `rrf` - Reciprocal Rank Fusion - which combines the sparse and dense
 * lanes by RANK POSITION rather than by score magnitude:
 *
 *   rrf(chunk) = sum over lanes of 1 / (k + rank_in_lane)
 *
 * RRF is weightless by design (it ignores the per-lane weights and the
 * intent multipliers) and robust to lanes whose score scales differ. The
 * raw RRF sums are min-max-normalised to [0, 1] so the fused relevance is
 * on the same scale as the linear path and composes with the same
 * downstream boosts (link / recency / entity / tier / session focus).
 */

/** Canonical RRF damping constant from the original Cormack et al. paper. */
export const DEFAULT_RRF_K = 60;

export type FusionMode = "linear" | "rrf";

const FUSION_MODES: ReadonlySet<string> = new Set(["linear", "rrf"]);

export function isFusionMode(value: string): value is FusionMode {
  return FUSION_MODES.has(value);
}

/**
 * Fuse two lanes by reciprocal rank and min-max-normalise the result to
 * [0, 1]. Each input is the lane's chunk ids in best-first order; a chunk
 * contributes `1 / (k + position)` for each lane it appears in. Returns a
 * map from chunk id to its normalised fused relevance. An empty input on
 * both lanes yields an empty map.
 */
export function rrfFuse(opts: {
  keywordRankedChunkIds: ReadonlyArray<number>;
  semanticRankedChunkIds: ReadonlyArray<number>;
  /**
   * Optional relational arm (t_09b7ccea): chunk ids from typed-edge
   * fan-out, best-first. Absent or empty contributes nothing, so the
   * two-lane fusion is byte-identical when the relational arm is off.
   */
  relationalRankedChunkIds?: ReadonlyArray<number>;
  k: number;
}): Map<number, number> {
  const k = Math.max(1, opts.k);
  const raw = new Map<number, number>();
  const accumulate = (ids: ReadonlyArray<number>): void => {
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      raw.set(id, (raw.get(id) ?? 0) + 1 / (k + (i + 1)));
    }
  };
  accumulate(opts.keywordRankedChunkIds);
  accumulate(opts.semanticRankedChunkIds);
  if (opts.relationalRankedChunkIds) accumulate(opts.relationalRankedChunkIds);

  if (raw.size === 0) return raw;

  const scores = [...raw.values()];
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const out = new Map<number, number>();
  if (max === min) {
    for (const id of raw.keys()) out.set(id, 1);
    return out;
  }
  for (const [id, score] of raw) {
    out.set(id, (score - min) / (max - min));
  }
  return out;
}
