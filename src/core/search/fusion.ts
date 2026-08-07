/**
 * Rank-fusion strategies for hybrid recall (Embedding Provider Suite).
 *
 * The default `linear` mode (a weighted sum of min-max-normalised BM25
 * and cosine, computed in `ranker.ts`) is unchanged. This module adds
 * `rrf` - Reciprocal Rank Fusion - which combines the sparse and dense
 * lanes by RANK POSITION rather than by score magnitude.
 *
 * RRF ignores the CONFIGURED lane weights (`search_keyword_weight` /
 * `search_semantic_weight`) on purpose: those calibrate two score
 * magnitudes against each other, and this fusion reads no magnitudes. It
 * does NOT ignore what the caller asked for. A per-query intent profile
 * (`query-plan.ts`, composed with the learned recall weights) states a
 * preference between the lanes themselves - a quoted phrase wants the
 * lexical lane - and that preference is applied to the per-lane
 * CONTRIBUTION, the standard weighted-RRF formulation:
 *
 *   rrf(chunk) = sum over lanes of w_lane / (k + rank_in_lane)
 *
 * so it stays rank-based and scale-free. `w_lane = 1` on every lane
 * reproduces the classic term exactly, which is what a query that
 * declared no intent gets.
 *
 * The raw RRF sums are min-max-normalised to [0, 1] so the fused relevance is
 * on the same scale as the linear path and composes with the same
 * downstream boosts (link / recency / entity / tier / session focus).
 */

import { SearchError } from "./search-error.ts";

/** Canonical RRF damping constant from the original Cormack et al. paper. */
export const DEFAULT_RRF_K = 60;

/** The weight of a lane the caller expressed no preference about. */
export const NEUTRAL_LANE_WEIGHT = 1;

/**
 * The relational fan-out arm is always neutral: the intent profile
 * describes a lexical-versus-semantic preference, and a typed-edge
 * traversal is neither, so there is no multiplier that would honestly
 * apply to it.
 */
const RELATIONAL_LANE_WEIGHT = NEUTRAL_LANE_WEIGHT;

/**
 * Per-lane multipliers for {@link rrfFuse}. Both default to
 * {@link NEUTRAL_LANE_WEIGHT}; both must be finite and strictly positive.
 */
export interface RrfLaneWeights {
  readonly keyword: number;
  readonly semantic: number;
}

/** The command that clears the learned half of a lane weight. */
const LEARNED_WEIGHTS_RESET_COMMAND = "o2b search weights --reset";

/**
 * A lane weight of zero would delete the lane and a negative one would
 * invert its rank order - in both cases the fusion silently answers a
 * question nobody asked. The bounded intent profiles cannot produce
 * either; a hand-edited learned-weights file can, so the refusal names
 * that file's reset command as the exit.
 */
function assertLaneWeight(weight: number, lane: keyof RrfLaneWeights): void {
  if (Number.isFinite(weight) && weight > 0) return;
  throw new SearchError(
    "INVALID_INPUT",
    `rrf fusion: the ${lane} lane weight must be a finite positive number, got ${weight}. ` +
      "A non-positive weight inverts the lane's rank order instead of down-weighting it. " +
      "The weight is the query intent profile composed with the learned recall weights; " +
      `clear the learned half with: ${LEARNED_WEIGHTS_RESET_COMMAND}`,
  );
}

export type FusionMode = "linear" | "rrf";

const FUSION_MODES: ReadonlySet<string> = new Set(["linear", "rrf"]);

export function isFusionMode(value: string): value is FusionMode {
  return FUSION_MODES.has(value);
}

/**
 * Fuse two lanes by reciprocal rank and min-max-normalise the result to
 * [0, 1]. Each input is the lane's chunk ids in best-first order; a chunk
 * contributes `w_lane / (k + position)` for each lane it appears in.
 * Returns a map from chunk id to its normalised fused relevance. An empty
 * input on both lanes yields an empty map.
 *
 * `laneWeights` is the per-query intent preference. Omitting it (or
 * passing {@link NEUTRAL_LANE_WEIGHT} on both lanes) yields the classic
 * weightless term, bit for bit.
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
  /** Per-lane intent multipliers; absent means neutral on both lanes. */
  laneWeights?: RrfLaneWeights;
}): Map<number, number> {
  const k = Math.max(1, opts.k);
  const keywordWeight = opts.laneWeights?.keyword ?? NEUTRAL_LANE_WEIGHT;
  const semanticWeight = opts.laneWeights?.semantic ?? NEUTRAL_LANE_WEIGHT;
  assertLaneWeight(keywordWeight, "keyword");
  assertLaneWeight(semanticWeight, "semantic");
  const raw = new Map<number, number>();
  const accumulate = (ids: ReadonlyArray<number>, weight: number): void => {
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      raw.set(id, (raw.get(id) ?? 0) + weight / (k + (i + 1)));
    }
  };
  accumulate(opts.keywordRankedChunkIds, keywordWeight);
  accumulate(opts.semanticRankedChunkIds, semanticWeight);
  if (opts.relationalRankedChunkIds) {
    accumulate(opts.relationalRankedChunkIds, RELATIONAL_LANE_WEIGHT);
  }

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
