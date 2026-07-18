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
 * Pure and language-agnostic: every chain/decay decision is structural
 * (`superseded_by` presence, an integer recall count), never lexical.
 * The B5 prompt-match is deterministic structural token overlap
 * (`similarity.ts` jaccard) - no LLM, no language-specific word lists.
 */

import { jaccard, tokenise } from "./similarity.ts";

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

// ----- Rated-decision recall (B5, t_5712fa39) --------------------------------

/**
 * Minimum structural token overlap (jaccard of prompt tokens vs a rated
 * decision's tokens) for a prompt to be treated as a match. Deterministic
 * and language-agnostic - no LLM, no stopword list.
 */
export const DECISION_RECALL_MIN_OVERLAP = 0.2;

/** One rated decision offered to the prompt matcher. */
export interface RatedDecisionCandidate {
  readonly id: string;
  /** Rating in [1, 5]; higher ranks first on an overlap tie. */
  readonly rating: number;
  /** Verbatim text to match against (e.g. title + chosen). */
  readonly text: string;
}

/** A prompt-match hit: which decision matched and how strongly. */
export interface RatedDecisionMatch {
  readonly id: string;
  readonly rating: number;
  readonly overlap: number;
}

/**
 * Deterministically match a prompt against rated decisions by structural
 * token overlap. Returns hits at or above `minOverlap`, ranked by
 * descending overlap, then descending rating, then id (stable). Pure: no
 * disk, no model, no language-specific vocabulary.
 */
export function matchRatedDecisions(
  prompt: string,
  candidates: ReadonlyArray<RatedDecisionCandidate>,
  opts: { readonly minOverlap?: number } = {},
): RatedDecisionMatch[] {
  const minOverlap = opts.minOverlap ?? DECISION_RECALL_MIN_OVERLAP;
  const promptTokens = tokenise(prompt);
  if (promptTokens.size === 0) return [];
  const out: RatedDecisionMatch[] = [];
  for (const c of candidates) {
    const overlap = jaccard(promptTokens, tokenise(c.text));
    if (overlap < minOverlap) continue;
    out.push({ id: c.id, rating: c.rating, overlap });
  }
  out.sort((a, b) => b.overlap - a.overlap || b.rating - a.rating || a.id.localeCompare(b.id));
  return out;
}

/** Per-session caps + spacing for rated-decision recall. */
export interface DecisionRecallConfig {
  /**
   * Maximum recalls per session. `null` DISABLES recall entirely - the
   * governor surfaces nothing, so an unconfigured vault stays
   * byte-identical.
   */
  readonly maxPerSession: number | null;
  /** Minimum turns between two recalls. `0` means no spacing gate. */
  readonly minSpacingTurns: number;
}

/** Session bookkeeping the governor threads across turns (caller-owned). */
export interface DecisionRecallState {
  /** Ids already surfaced this session (never re-surfaced). */
  readonly surfacedIds: ReadonlyArray<string>;
  /** Turn index of the most recent recall, or `null` when none yet. */
  readonly lastTurn: number | null;
  /** Total recalls surfaced this session. */
  readonly count: number;
}

/** The zero state for a fresh session. */
export const EMPTY_DECISION_RECALL_STATE: DecisionRecallState = Object.freeze({
  surfacedIds: Object.freeze([]),
  lastTurn: null,
  count: 0,
});

export interface GovernDecisionRecallInput {
  readonly matches: ReadonlyArray<RatedDecisionMatch>;
  readonly state: DecisionRecallState;
  /** Monotonic current turn index. */
  readonly turn: number;
  readonly config: DecisionRecallConfig;
}

export interface GovernDecisionRecallResult {
  /** The single decision to resurface this turn, or `null` when gated. */
  readonly surface: RatedDecisionMatch | null;
  /** Next session state (advanced only when a decision was surfaced). */
  readonly state: DecisionRecallState;
}

/**
 * Apply per-session cap and spacing to a ranked match list, surfacing at
 * most one new rated decision this turn. Gates, in order:
 *   1. recall disabled (`maxPerSession === null`) -> surface nothing;
 *   2. per-session cap reached -> surface nothing;
 *   3. spacing: fewer than `minSpacingTurns` since the last recall ->
 *      surface nothing;
 *   4. otherwise surface the top-ranked match not already surfaced.
 * The returned state advances only when a decision is surfaced, so a
 * gated turn leaves the state (and thus future gating) unchanged.
 */
export function governDecisionRecall(input: GovernDecisionRecallInput): GovernDecisionRecallResult {
  const { config, state, turn, matches } = input;
  if (config.maxPerSession === null || config.maxPerSession <= 0) {
    return { surface: null, state };
  }
  if (state.count >= config.maxPerSession) {
    return { surface: null, state };
  }
  if (
    state.lastTurn !== null &&
    config.minSpacingTurns > 0 &&
    turn - state.lastTurn < config.minSpacingTurns
  ) {
    return { surface: null, state };
  }
  const already = new Set(state.surfacedIds);
  const pick = matches.find((m) => !already.has(m.id));
  if (pick === undefined) {
    return { surface: null, state };
  }
  return {
    surface: pick,
    state: Object.freeze({
      surfacedIds: Object.freeze([...state.surfacedIds, pick.id]),
      lastTurn: turn,
      count: state.count + 1,
    }),
  };
}
