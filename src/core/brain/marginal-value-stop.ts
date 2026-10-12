/**
 * The marginal-value stop, as a pure leaf (recall-quality wave, lane A).
 *
 * A page (or a retrieval round) is worth taking only while its value is
 * at least a floor fraction of the best sample's value; the floor rises
 * with observed latency, so a slow route demands denser pages. The
 * formula is the advisor's, extracted verbatim (t_3ffb021c) so the
 * consumers reusing it - the advisor's own allocation and the search-side
 * iterative loop, which feeds per-round candidate yields and elapsed time
 * instead of a pack curve - share one tuning rather than re-deriving
 * their own.
 *
 * This module is a LEAF by construction: it imports nothing, so a
 * consumer in the search pipeline can read the exact advisor formula
 * without dragging the advisor's dependency graph (plan, pack, doctor)
 * behind it - a graph whose load order a pipeline import once flipped
 * into a module-init cycle, which is why the extraction sits here rather
 * than beside its original.
 */

/**
 * Marginal-value stop: a page is worth including only while its density is at
 * least this fraction of the top page's density. The fraction is the base
 * plus a p95-scaled surcharge, so a slow route demands denser pages.
 */
export const STOP_BASE_FRACTION = 0.25;
/** p95 latency (ms) that adds the full {@link STOP_MAX_EXTRA_FRACTION} surcharge. */
export const STOP_P95_SCALE_MS = 4000;
/** Cap on the p95-driven surcharge added to {@link STOP_BASE_FRACTION}. */
export const STOP_MAX_EXTRA_FRACTION = 0.5;

/** The stop verdict over one density curve. */
export interface RetrievalPlanMarginalStop {
  /** Include this many leading pages; beyond it marginal value < cost. */
  readonly stopRank: number;
  /** Cumulative tokens of the leading pages up to the stop. */
  readonly stopTokens: number;
  readonly reason: string;
}

/**
 * Where to stop allocating along a density curve given observed latency.
 * Samples are read in order; the walk keeps pages whose density meets the
 * latency-scaled floor (always at least the first), and the token counts
 * ride along so the caller knows what the kept pages cost.
 *
 * Extracted verbatim from the advisor's private stop so other lanes can
 * reuse the exact formula rather than re-tuning their own: the advisor feeds
 * it the context-pack density curve and the route's p95, and its
 * `buildRetrievalPlan` output stays byte-identical to the pre-extraction
 * fixtures by construction. The search-side iterative loop feeds it
 * per-round candidate yields and elapsed time instead — samples, not pages.
 */
export function marginalValueStop(
  densityCurve: ReadonlyArray<number>,
  tokens: ReadonlyArray<number>,
  p95LatencyMs: number | null,
): RetrievalPlanMarginalStop {
  if (densityCurve.length === 0) {
    return Object.freeze({ stopRank: 0, stopTokens: 0, reason: "no candidates to allocate" });
  }
  const top = densityCurve[0]!;
  const surcharge = Math.min(
    STOP_MAX_EXTRA_FRACTION,
    (Math.max(0, p95LatencyMs ?? 0) / STOP_P95_SCALE_MS) * STOP_MAX_EXTRA_FRACTION,
  );
  const fraction = STOP_BASE_FRACTION + surcharge;
  const floor = top * fraction;
  let stopRank = 0;
  let stopTokens = 0;
  for (let i = 0; i < densityCurve.length; i++) {
    if (densityCurve[i]! < floor && stopRank >= 1) break;
    stopRank += 1;
    stopTokens += tokens[i] ?? 0;
  }
  return Object.freeze({
    stopRank,
    stopTokens,
    reason:
      `stop after ${stopRank} page(s): density floor ${floor.toFixed(4)} ` +
      `(${(fraction * 100).toFixed(0)}% of top) given p95 ${p95LatencyMs ?? 0}ms`,
  });
}
