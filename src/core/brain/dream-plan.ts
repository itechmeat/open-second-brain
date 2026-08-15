/**
 * Shared scan-record and plan-state shapes for the dream pass.
 *
 * Extracted from dream.ts so the planning sub-modules
 * (reconcile-outcomes.ts, dream-refresh.ts) and the orchestrator can
 * exchange typed state without a single-file dependency knot. Pure
 * data shapes plus three stateless helpers; no I/O. `topicKey` lives here
 * rather than at one consumer because the plan and the reconcile pass that
 * reads the plan must agree on what one topic IS, and two copies of that rule
 * would be one drift away from a contradiction the plan flags but reconcile
 * cannot find.
 */

import { foldQuoteVariantsByClass, normalizeEntityShape } from "./entities/canonical.ts";
import type { BrainPreference, BrainRetiredReason, BrainSignal, BrainSignalSign } from "./types.ts";

/**
 * The key one topic owns in the consolidation pass.
 *
 * The read path canonicalises an entity reference before it compares it
 * (`search/entity-alias.ts` folds query entities through
 * `normalizeEntityName`); the consolidation path compared raw bytes, so two
 * signals whose topics differed only by Unicode normal form, letter case, an
 * internal whitespace run, or a curly-versus-straight quote were consolidated
 * as unrelated subjects. The shape pass is the identity kernel's own -
 * `normalizeEntityShape` is NFC, trim, whitespace collapse, lowercase, every
 * step structural, so the rule behaves identically for a script with no case
 * distinction and for one that has it.
 *
 * The quote step is the kernel's OTHER fold, and deliberately so. The kernel
 * sends every quote class to the ASCII single quote, which merges a
 * typographic DOUBLE quote with an apostrophe: `prefer-“single”-quotes` and
 * `prefer-'single'-quotes` became one key, contended, and the pass then
 * planned nothing for either - two live rules inert and an inbox that only
 * grows. A topic key is computed per run and written nowhere, so it can
 * afford the faithful fold that a persisted identity key cannot; see
 * `foldQuoteVariantsByClass` and the note on `foldQuoteVariants` for what
 * re-targeting a stored key would cost.
 *
 * A key is an index, never a label. Everything an operator reads back keeps
 * the raw spelling a signal actually used - see `preferredTopicDisplay` in
 * `dream-plan-topics.ts`.
 *
 * NOT every raw topic comparison in the Brain goes through this function, and
 * the ones that do not are named rather than left implied: `query.ts`'s
 * preference lookup and `intent-review.ts`'s pre-dream clustering both
 * compare raw bytes, so the review can cluster signals differently from the
 * plan that acts on them. Folding those is a behaviour change to the read
 * path and to a report shape, which is a separate unit; what this release
 * adds is a doctor check (`topic-key-collision` in
 * `doctor/preference-hygiene.ts`) so the contention warning's remedy - find
 * the near-duplicate pair and give the key one owner - has a tool behind it.
 */
export function topicKey(rawTopic: string): string {
  return foldQuoteVariantsByClass(normalizeEntityShape(rawTopic));
}

/**
 * Two or more preferences whose topics fold onto one {@link topicKey}.
 *
 * Before the fold they were separate subjects and each answered its own
 * signals; after it they contend, and "one preference per topic" can no
 * longer decide which of them a signal on that key bears on. The pass records
 * the contention and plans nothing for the key rather than picking a winner
 * by scan order - retiring the wrong rule is not a recoverable mistake.
 *
 * Byte-identical topics are NOT a contention: that is the pre-existing
 * duplicate the design doc §7.4 invariant already covers, it keeps its
 * historical first-wins handling, and reporting it here would be this unit
 * inventing a finding it did not cause.
 */
export interface TopicKeyContention {
  /** The folded key both preferences resolve to. */
  readonly key: string;
  /** The distinct raw topics claiming it, in code-unit order. */
  readonly topics: ReadonlyArray<string>;
  /** The ids of every claiming preference, in code-unit order. */
  readonly prefIds: ReadonlyArray<string>;
}

/** Id prefix the preference writer stamps on every live rule. */
export const PREF_ID_PREFIX = "pref-";

/** Id prefix a preference carries once it has moved into `retired/`. */
export const RETIRED_ID_PREFIX = "ret-";

/**
 * The filename slug behind a preference id.
 *
 * Every writer emits `pref-<slug>`, but the on-disk artifacts are
 * user-editable and a hand-authored file may carry a bare id. The dream
 * pass has always read such an id as being its own slug, so the strip is
 * tolerant rather than strict.
 */
export function preferenceSlug(id: string): string {
  return id.startsWith(PREF_ID_PREFIX) ? id.slice(PREF_ID_PREFIX.length) : id;
}

export interface SignalRecord {
  readonly path: string;
  readonly signal: BrainSignal;
  /** True iff the file lives in `inbox/` (not `processed/`). */
  readonly active: boolean;
}

export interface PreferenceRecord {
  readonly path: string;
  readonly pref: BrainPreference;
  /**
   * Raw `superseded_by` frontmatter pointer (Belief lifecycle suite, A4).
   * The typed parser drops it, so scanBrain captures it from raw
   * frontmatter to drive accelerated decay of low-recall superseded
   * ancestors. `null` when the memory is a chain tip.
   */
  readonly supersededBy: string | null;
}

export interface RetiredRecord {
  readonly path: string;
  readonly topic: string;
  readonly id: string;
  readonly principle: string;
  readonly scope?: string;
  /**
   * The free-form user reason passed to `o2b brain reject --reason`.
   * Presence triggers signal-suppression for future signals on the
   * same (topic, scope) — see §6 of the OSB features summary.
   */
  readonly user_rejected_reason?: string;
}

export interface CorruptedEntry {
  readonly path: string;
}

export interface ScanResult {
  readonly signals: SignalRecord[];
  readonly preferences: PreferenceRecord[];
  readonly retired: RetiredRecord[];
  readonly corrupted: CorruptedEntry[];
}

/**
 * Entry surfacing a signal cluster that the self-approval guardrail
 * (v0.10.16) held back from promotion because one or more configured
 * thresholds were not met. Distinct from `suppressed` (which fires
 * on a user-rejected retired preference); a quarantined cluster
 * stays inbox-side and may promote on the next dream pass once
 * more evidence accumulates.
 */
export interface DreamQuarantinedEntry {
  /** Topic slug whose signals are held below the promotion threshold. */
  readonly topic: string;
  /** Count of accumulated same-sign signals. */
  readonly signal_count: number;
  /** Number of distinct agents that raised same-sign signals. */
  readonly distinct_agents: number;
  /** Age (in days) of the earliest signal in the cluster. */
  readonly age_days: number;
  /**
   * Which threshold(s) blocked promotion: any subset of
   * `min_signals`, `min_distinct_agents`, `min_age_days`.
   */
  readonly failed_gates: ReadonlyArray<string>;
}

export interface PlanState {
  /** Topic slug → planned new unconfirmed preference. */
  readonly newUnconfirmed: NewUnconfirmedPlan[];
  /** Preferences to retire (after refresh). */
  readonly retires: RetirePlan[];
  /** Same-sign signals on active prefs → moved + log event. */
  readonly notedRedundant: NotedRedundantPlan[];
  /** Pinned prefs that would have retired but stay because pinned. */
  readonly retainPinned: RetainPinnedPlan[];
  /** Signal id → record to move out of inbox/. */
  readonly signalsToMove: Map<string, SignalMovePlan>;
  /** Topic slugs flagged contradicted but no transition this run. */
  readonly contradictionTopics: Set<string>;
  /**
   * Signals dropped because their (topic, scope) matches a user-rejected
   * retired pref carrying a `user_rejected_reason`. Each entry produces
   * one `signal-suppressed` log event AND a move into `processed/` so
   * the inbox does not accumulate.
   */
  readonly signalsSuppressed: SignalSuppressedPlan[];
  /**
   * Signal clusters held back from promotion by the self-approval
   * guardrail (v0.10.16). The cluster passed the existing
   * `candidate_threshold` but failed one or more configured
   * thresholds in `BrainGuardrailConfig`. Preserved across the plan
   * so it surfaces on the DreamRunSummary without affecting the
   * existing move-to-processed semantics.
   */
  readonly quarantined: DreamQuarantinedEntry[];
  /**
   * Folded topic keys claimed by more than one preference. Every entry is a
   * key the pass deliberately planned nothing for; the run summary carries
   * one warning per entry so the ambiguity reaches an operator instead of
   * being resolved by directory-enumeration order.
   */
  readonly topicKeyContentions: TopicKeyContention[];
}

export interface SignalSuppressedPlan {
  readonly signal: string;
  /** Pre-rendered `[[ret-slug|principle]]` wikilink for the suppressor. */
  readonly retired: string;
  readonly reason: string;
  readonly topic: string;
}

export interface NewUnconfirmedPlan {
  readonly slug: string;
  readonly topic: string;
  readonly scope: string | undefined;
  readonly principle: string;
  readonly evidencedBy: ReadonlyArray<string>;
  readonly sign: BrainSignalSign;
  /**
   * Wikilink string (`[[ret-<slug>]]` or `[[pref-<slug>]]`) to the
   * preference this new entry supersedes, if any. Threaded through to
   * `writePreference` so the resulting frontmatter carries
   * `supersedes:` for audit-trail continuity across rebuttals.
   */
  readonly supersedes?: string;
  /**
   * Brain lifecycle suite (F5). Bi-temporal validity derived from the
   * source signal at plan time (explicit signal fields preferred, else
   * extracted from the signal's ISO temporal text). Threaded to the
   * preference writer on promotion.
   */
  readonly valid_from?: string;
  readonly valid_until?: string;
}

export interface RetirePlan {
  readonly slug: string;
  /**
   * Principle of the preference being retired, captured at plan time
   * so the dream summary log payload can render a titled wikilink
   * (`[[ret-slug|principle]]`) without re-reading the file after move.
   */
  readonly principle: string;
  readonly reason: BrainRetiredReason;
  readonly supersededBy?: string;
  /**
   * Belief lifecycle suite (A4, t_d9365884): this retire fired on the
   * accelerated chain-decay window (a low-recall superseded ancestor),
   * i.e. it would not yet have retired under the normal stale window. The
   * apply path emits a `chain-decay` event for these.
   */
  readonly chainDecay?: boolean;
}

export interface NotedRedundantPlan {
  /** Pre-rendered `[[pref-id|principle]]` wikilink for the active pref. */
  readonly preference: string;
  readonly signal: string;
}

export interface RetainPinnedPlan {
  /** Pre-rendered `[[pref-id|principle]]` wikilink for the pinned pref. */
  readonly preference: string;
  readonly reason: BrainRetiredReason;
}

export interface SignalMovePlan {
  readonly id: string;
  readonly date: string;
  readonly slug: string;
  readonly path: string;
}

export function emptyPlan(): PlanState {
  return {
    newUnconfirmed: [],
    retires: [],
    notedRedundant: [],
    retainPinned: [],
    signalsToMove: new Map(),
    contradictionTopics: new Set(),
    signalsSuppressed: [],
    quarantined: [],
    topicKeyContentions: [],
  };
}

export function recordSignalMove(plan: PlanState, rec: SignalRecord): void {
  if (!rec.active) return;
  const id = rec.signal.id;
  if (plan.signalsToMove.has(id)) return;
  // Derive date + slug from the id (`sig-YYYY-MM-DD-<slug>`).
  const m = /^sig-(\d{4}-\d{2}-\d{2})-(.+)$/.exec(id);
  if (!m) return;
  plan.signalsToMove.set(id, {
    id,
    date: m[1]!,
    slug: m[2]!,
    path: rec.path,
  });
}

export function filterWithinWindow(
  sigs: SignalRecord[],
  windowDays: number,
  now: Date,
): SignalRecord[] {
  const minTime = now.getTime() - windowDays * 24 * 3600 * 1000;
  return sigs.filter((s) => {
    const t = Date.parse(s.signal.created_at);
    return Number.isFinite(t) && t >= minTime;
  });
}
