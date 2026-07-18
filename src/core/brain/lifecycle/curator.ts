/**
 * Curator read slices over observed-use verdicts (Belief lifecycle
 * suite, Track A anchor, t_7d5a3589).
 *
 * A read-only projection that folds the session-end observed-use
 * verdicts ({@link observedReuseRates}) into three actionable slices a
 * curator uses to decide what to tombstone, resurface, or trust:
 *
 *   - `injectedNeverUsed` - memories that were injected/observed but no
 *     transcript turn ever echoed them (all IGNORED). Retirement bait.
 *   - `contradicted` - memories a later turn structurally contradicted.
 *   - `highUsed` - memories echoed often enough to be load-bearing.
 *
 * Pure aggregation, no mutation. Language-agnostic: every input is a
 * count already computed by the observed-use kernel.
 */

import { observedReuseRates, type ObservedReuse } from "../observed-use.ts";

/**
 * Default minimum USED-verdict count for a memory to count as
 * high-used. A named constant rather than an inline literal; callers may
 * override per call via {@link CuratorSlicesOptions.highUseMin}.
 */
export const CURATOR_HIGH_USE_MIN_DEFAULT = 3;

/** One curator slice row: the artifact key plus its folded reuse stats. */
export interface CuratorEntry {
  /** Join key - vault-relative path when known, else the memory id. */
  readonly key: string;
  readonly reuse: ObservedReuse;
}

export interface CuratorSlices {
  readonly injectedNeverUsed: ReadonlyArray<CuratorEntry>;
  readonly contradicted: ReadonlyArray<CuratorEntry>;
  readonly highUsed: ReadonlyArray<CuratorEntry>;
}

export interface CuratorSlicesOptions {
  /** Minimum USED count for the high-used slice. Defaults to the constant. */
  readonly highUseMin?: number;
}

/** Stable ordering: primary metric descending, then key ascending. */
function byMetricThenKey(
  metric: (e: CuratorEntry) => number,
): (a: CuratorEntry, b: CuratorEntry) => number {
  return (a, b) => metric(b) - metric(a) || a.key.localeCompare(b.key);
}

/**
 * Compute the three curator slices from a vault's observed-use verdicts.
 */
export function curatorSlices(vault: string, opts: CuratorSlicesOptions = {}): CuratorSlices {
  const highUseMin = opts.highUseMin ?? CURATOR_HIGH_USE_MIN_DEFAULT;
  const rates = observedReuseRates(vault);

  const injectedNeverUsed: CuratorEntry[] = [];
  const contradicted: CuratorEntry[] = [];
  const highUsed: CuratorEntry[] = [];

  for (const [key, reuse] of rates) {
    const entry: CuratorEntry = { key, reuse };
    if (reuse.total > 0 && reuse.used === 0) injectedNeverUsed.push(entry);
    if (reuse.contradicted > 0) contradicted.push(entry);
    if (reuse.used >= highUseMin) highUsed.push(entry);
  }

  injectedNeverUsed.sort(byMetricThenKey((e) => e.reuse.ignored));
  contradicted.sort(byMetricThenKey((e) => e.reuse.contradicted));
  highUsed.sort(byMetricThenKey((e) => e.reuse.used));

  return { injectedNeverUsed, contradicted, highUsed };
}
