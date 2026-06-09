/**
 * Shared scan-record and plan-state shapes for the dream pass.
 *
 * Extracted from dream.ts so the planning sub-modules
 * (reconcile-outcomes.ts, dream-refresh.ts) and the orchestrator can
 * exchange typed state without a single-file dependency knot. Pure
 * data shapes plus two stateless helpers; no I/O.
 */

import type { BrainPreference, BrainRetiredReason, BrainSignal, BrainSignalSign } from "./types.ts";
import type { DreamQuarantinedEntry } from "./dream.ts";

export interface SignalRecord {
  readonly path: string;
  readonly signal: BrainSignal;
  /** True iff the file lives in `inbox/` (not `processed/`). */
  readonly active: boolean;
}

export interface PreferenceRecord {
  readonly path: string;
  readonly pref: BrainPreference;
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
