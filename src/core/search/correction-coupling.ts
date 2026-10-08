/**
 * Serve-with-correction coupling predicate (truth-correctable-time-aware,
 * contract item 3, Task 15).
 *
 * A retired-but-serveable row - a validity-closed predecessor inside its
 * window, or a superseded non-tip that is still serveable - is served only
 * beside its chain-tip correction. When the chain-tip successor is
 * unresolved or unreadable at the caller's reach, the row is dropped
 * FAIL-CLOSED: a withheld page stays indistinguishable from an absent one.
 *
 * The predicate is pure: callers resolve the chain tip (via
 * `resolveChainTip`/`buildChainLookup`) and the successor's readability at
 * the caller's reach, then ask for the verdict. It performs no I/O and
 * never inspects the vault, so every serving surface - search post-rank,
 * recall by topic, context-pack, active.md, dream scan - consumes the one
 * spelling of the rule from this module.
 *
 * Tombstoned rows are NOT this predicate's concern: they stay dropped by
 * the status filter everywhere, before any coupling question arises. The
 * predicate governs the serveable-retired regime only.
 */

/** The verdict a serving surface acts on for one retired-but-serveable row. */
export type CouplingVerdict =
  | { readonly action: "serve_coupled"; readonly correctionPath: string }
  | { readonly action: "drop" };

export interface CouplingInput {
  /** Path of the retired-but-serveable row's page. */
  readonly predecessorPath: string;
  /** Chain-tip successor path from resolveChainTip/buildChainLookup, null when unresolved. */
  readonly successorPath: string | null;
  /** True when the successor page is readable at the caller's reach. */
  readonly successorReadable: boolean;
}

/** Action values, spelled once so the fail-closed default is visible here. */
const SERVE_COUPLED = "serve_coupled" as const;
const DROP = "drop" as const;

/**
 * Decide whether a retired-but-serveable row may be served. Resolved AND
 * readable successor yields `serve_coupled` carrying the correction path;
 * every other combination drops the row. Pure and deterministic.
 */
export function couplingVerdict(input: CouplingInput): CouplingVerdict {
  if (input.successorPath === null || !input.successorReadable) {
    return { action: DROP };
  }
  return { action: SERVE_COUPLED, correctionPath: input.successorPath };
}
