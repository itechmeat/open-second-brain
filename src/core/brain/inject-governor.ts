/**
 * Injection governor (Belief lifecycle suite, A4, t_d9365884).
 *
 * The single helper that owns supersedes-chain consumer policy at the
 * injection choke point: it prefers chain tips over their superseded
 * ancestors so a chain of replacements injects only the current belief,
 * and it names the deterministic thresholds the dream pass uses to retire
 * low-recall superseded ancestors faster than live memories.
 *
 * Introduced here by the chain-policy unit; the rated-decision recall
 * unit (B5) extends the same governor with per-session caps and spacing.
 *
 * Pure and language-agnostic: every decision is structural
 * (`superseded_by` presence, an integer recall count), never lexical.
 */

// ----- Decay thresholds -----------------------------------------------------

/**
 * A superseded ancestor counts as low-recall when its `applied_count` is
 * at or below this. Zero means "never actually used in real work": the
 * safest ancestors to let the dream pass retire early.
 */
export const CHAIN_DECAY_LOW_RECALL_MAX_APPLIED = 0;

/**
 * Accelerated stale-evidence window (days) for a low-recall superseded
 * ancestor. Deliberately short: once a belief is superseded and the
 * ancestor was never load-bearing, it should fall out of the working set
 * quickly rather than waiting out the full `retire.stale_evidence_days`.
 */
export const CHAIN_DECAY_STALE_DAYS = 7;

// ----- Tip preference -------------------------------------------------------

/** Minimal shape the governor needs to reason about a chain position. */
export interface ChainCandidate {
  readonly supersededBy?: string | null;
}

export interface PreferChainTipsOptions {
  /**
   * Keep the whole chain instead of collapsing to tips. This is the
   * explicit historical flag - history is opt-in, never inferred from
   * the query text.
   */
  readonly historical?: boolean;
}

export interface PreferChainTipsResult<T> {
  /** Candidates to inject: chain tips plus every non-chain memory. */
  readonly kept: T[];
  /** Superseded ancestors dropped in favour of their tips. */
  readonly dropped: T[];
}

/** True when a candidate carries a non-empty `superseded_by` pointer. */
export function isSuperseded(candidate: ChainCandidate): boolean {
  const value = candidate.supersededBy;
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Prefer chain tips: drop any candidate that has been superseded so a
 * chain injects only its live tip. A memory with no `superseded_by`
 * pointer (the overwhelming common case) is always kept, so a vault with
 * no supersession chains passes through byte-identically. The historical
 * flag keeps the whole chain.
 */
export function preferChainTips<T extends ChainCandidate>(
  candidates: ReadonlyArray<T>,
  opts: PreferChainTipsOptions = {},
): PreferChainTipsResult<T> {
  if (opts.historical) return { kept: [...candidates], dropped: [] };
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const candidate of candidates) {
    if (isSuperseded(candidate)) dropped.push(candidate);
    else kept.push(candidate);
  }
  return { kept, dropped };
}

// ----- Decay acceleration ---------------------------------------------------

export interface LowRecallSupersededInput {
  readonly supersededBy?: string | null;
  readonly appliedCount: number;
}

/**
 * True when a memory is BOTH a superseded ancestor AND low-recall - the
 * exact class the dream pass may retire on the accelerated window. A live
 * (non-superseded) memory or a well-used ancestor is never accelerated.
 */
export function isLowRecallSupersededAncestor(
  input: LowRecallSupersededInput,
  opts: { readonly maxApplied?: number } = {},
): boolean {
  const maxApplied = opts.maxApplied ?? CHAIN_DECAY_LOW_RECALL_MAX_APPLIED;
  return isSuperseded(input) && input.appliedCount <= maxApplied;
}

/**
 * Resolve the effective stale-evidence window for a preference. An
 * accelerated (low-recall superseded ancestor) memory uses the shorter of
 * {@link CHAIN_DECAY_STALE_DAYS} and the vault's normal window, so
 * acceleration can never make a memory retire SLOWER than today.
 */
export function effectiveStaleThresholdDays(accelerated: boolean, normalDays: number): number {
  return accelerated ? Math.min(CHAIN_DECAY_STALE_DAYS, normalDays) : normalDays;
}
