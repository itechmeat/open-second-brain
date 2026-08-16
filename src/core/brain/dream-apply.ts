/**
 * The dream pass's mutation stage: turn a decided plan into disk state.
 *
 * One reason to change: the ORDER and mechanics of the writes. Nothing
 * here decides anything about the vault's contents — every choice was
 * already made by the planning stages. What this module owns is the
 * sequence that keeps the on-disk invariants true:
 *
 *   1. Write new unconfirmed preferences (so signal moves can find
 *      them).
 *   2. Apply refresh (counters, confidence, promotion) to existing
 *      preferences.
 *   3. Move retiring preferences out (after the refresh has had a
 *      chance to surface the most recent counters in the retired
 *      file). NOTE: refresh skips entries that will retire.
 *   4. Move consumed signals into `processed/`.
 *
 * Log emission is stage 5 and lives in `dream-report.ts`.
 *
 * Workrun checkpoints are emitted here rather than by the orchestrator
 * because a marker must mean "every durable effect attributed to that
 * phase is already on disk" — only the code that performs the writes
 * knows where that point is.
 */

import { existsSync, renameSync } from "node:fs";

import { appendDecisionChangeReceipt } from "./decisions/receipts.ts";
import { preferenceSlug, type PlanState } from "./dream-plan.ts";
import { SafeguardAbortError, SafeguardTimeoutError, type Safeguard } from "./safeguard.ts";
import type { RefreshResult } from "./dream-refresh.ts";
import type { DreamGatedRetireEntry } from "./dream-types.ts";
import { WORKRUN_PHASE, type WorkrunHandle } from "./dream-workrun.ts";
import { collectEvidenceForSlug } from "./evidence.ts";
import { runHealEnrichment } from "./heal-run.ts";
import { CHAIN_DECAY_STALE_DAYS } from "./inject-governor.ts";
import { appendLogEvent } from "./log.ts";
import { preferencePath, processedSignalPath } from "./paths.ts";
import { moveToRetired, parsePreference } from "./preference.ts";
import { writePreferenceTxn } from "./preference-txn.ts";
import { isoSecond } from "./time.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";
import {
  BRAIN_LOG_EVENT_KIND,
  BRAIN_PREFERENCE_STATUS,
  BRAIN_RETIRED_REASON,
  type BrainConfig,
  type BrainPreference,
  type BrainRetiredReason,
} from "./types.ts";

const DAY_MS = 24 * 3600 * 1000;

/** Agent of record when the caller declared no name. */
const DEFAULT_DREAM_AGENT = "dream";

export interface DreamApplyInput {
  readonly vault: string;
  readonly cfg: BrainConfig;
  readonly now: Date;
  readonly plan: PlanState;
  readonly refresh: RefreshResult;
  /** Identity threaded into edit-history and decision receipts. */
  readonly agentName: string | undefined;
  /** `[[Brain/log/<date>]]`, stamped as `retired_by` on each move. */
  readonly wikilinkToRun: string;
  /** Resolved `dream.heal_enrich` gate for this run. */
  readonly healEnrichEnabled: boolean;
  /**
   * The pass's cooperative deadline, forwarded to the one sub-unit here
   * that is unbounded in the vault's size: the opt-in heal enrichment,
   * which reads and rewrites every user page outside `Brain/`. Nothing
   * else in this module iterates over anything but the decided plan, so
   * nothing else needs it.
   */
  readonly safeguard?: Safeguard;
  readonly workrun: WorkrunHandle | null;
}

export interface DreamApplyResult {
  /** Signal ids actually moved into `processed/`. */
  readonly moved: string[];
  /** Retires the destructive-from-confirmed gate declined. */
  readonly gatedRetires: DreamGatedRetireEntry[];
  /** User pages the opt-in heal phase enriched. */
  readonly healEnriched: number;
}

/**
 * Signal ids a dry run WOULD move. Reported so the caller's summary is
 * accurate without touching disk.
 */
export function plannedSignalMoveIds(plan: PlanState): string[] {
  return Array.from(plan.signalsToMove.values(), (sig) => sig.id);
}

export function applyDreamPlan(input: DreamApplyInput): DreamApplyResult {
  const { vault, cfg, now, plan, refresh, wikilinkToRun, workrun } = input;
  const agent = input.agentName ?? DEFAULT_DREAM_AGENT;

  // This module renames signal files directly, so it owes the vault-identity
  // assertion on its own entry rather than trusting whoever called it. The
  // check is an idempotent in-memory pin and the caller's `openWorkrun` has
  // already satisfied it for this root, so it never fires twice in anger.
  assertVaultIdentityForWrite(vault);

  writePreferences(input, agent);
  writeConfidenceReceipts(vault, refresh, agent, now);

  // Synthesize is durable here and nowhere earlier: every new
  // unconfirmed preference, every refreshed preference and every
  // confidence receipt has landed. `promote_complete` is the pre-F2
  // name for the same writes, so it moves with it rather than being
  // left behind claiming a batch that had not started.
  workrun?.checkpoint(WORKRUN_PHASE.promoteComplete);
  workrun?.checkpoint(WORKRUN_PHASE.synthesizeComplete);

  const gatedRetires = executeRetires(vault, cfg, now, plan, wikilinkToRun);

  // Every planned retire has been moved (or explicitly gated) by here.
  workrun?.checkpoint(WORKRUN_PHASE.retireComplete);

  const moved = moveConsumedSignals(vault, plan);
  const healEnriched = input.healEnrichEnabled
    ? runHealEnrichmentSafely(vault, input.safeguard)
    : 0;

  // Heal's second half (the optional enrichment) is durable here; its
  // first half was the retire loop above. The marker sits at the later
  // of the two, so it is never a claim about work still to come.
  workrun?.checkpoint(WORKRUN_PHASE.healComplete);

  return { moved, gatedRetires, healEnriched };
}

/**
 * Steps 1 and 2: create the freshly-promoted preferences, then rewrite
 * the refreshed ones.
 *
 * Edit-history (F4): every dream-pass write records its content
 * before/after so a preference's evolution stays auditable. The agent of
 * record is whoever invoked the dream run.
 *
 * v0.12.0 Brain Integrity Suite: both loops route through
 * `writePreferenceTxn` so `_revision` auto-stamps and `_content_hash`
 * lands automatically on confirmed promotions. The empty expectations
 * array is deliberate - dream's plan-time logic has already decided to
 * proceed; the txn just owns the bookkeeping.
 */
function writePreferences(input: DreamApplyInput, agent: string): void {
  const { vault, cfg, now, plan, refresh } = input;
  const historyOpts = { agent, now: () => now };

  for (const np of plan.newUnconfirmed) {
    // Fresh pref has no apply-evidence yet; recentApplied/recentViolated
    // start empty and stay so until the next dream pass after the
    // first `brain_apply_evidence` event.
    writePreferenceTxn(
      vault,
      {
        slug: np.slug,
        topic: np.topic,
        principle: np.principle,
        created_at: isoSecond(now),
        unconfirmed_until: isoSecond(addDays(now, cfg.dream.unconfirmed_window_days)),
        status: BRAIN_PREFERENCE_STATUS.unconfirmed,
        evidenced_by: np.evidencedBy,
        // No evidence yet → Wilson lower bound on (0, 0) is 0. Pre-
        // seed the field so refresh on the next pass does not have
        // to treat `null` as "needs update" (which would lift
        // `changed: false` no-ops into spurious rewrites).
        confidence_value: 0,
        recentApplied: [],
        recentViolated: [],
        ...(np.scope ? { scope: np.scope } : {}),
        ...(np.supersedes ? { supersedes: np.supersedes } : {}),
        // F5: bi-temporal validity extracted from the source signal.
        ...(np.valid_from ? { valid_from: np.valid_from } : {}),
        ...(np.valid_until ? { valid_until: np.valid_until } : {}),
      },
      [],
      { overwrite: false },
      historyOpts,
    );
  }

  for (const update of refresh.updated.values()) {
    // Rebuild the evidence slice from the log on every pass so the
    // pref body stays in sync with the counters even when the
    // counters themselves stayed put (e.g. dropping the
    // v0.9.x placeholder body during a no-counter-change run).
    const ev = collectEvidenceForSlug(vault, update.slug, {
      sinceIso: update.created_at,
    });
    // The freshness trend was classified at PLAN time (planRefresh)
    // so the no-op pre-flight rendered these exact bytes.
    writePreferenceTxn(
      vault,
      {
        slug: update.slug,
        topic: update.topic,
        principle: update.principle,
        created_at: update.created_at,
        unconfirmed_until: update.unconfirmed_until,
        status: update.status,
        evidenced_by: update.evidenced_by,
        confirmed_at: update.confirmed_at,
        applied_count: update.applied_count,
        violated_count: update.violated_count,
        last_evidence_at: update.last_evidence_at,
        confidence: update.confidence,
        confidence_value: update.confidence_value,
        pinned: update.pinned,
        recentApplied: ev.applied,
        recentViolated: ev.violated,
        ...(update.freshness_trend !== undefined
          ? { freshness_trend: update.freshness_trend }
          : {}),
        ...(update.scope ? { scope: update.scope } : {}),
      },
      [],
      { overwrite: true },
      historyOpts,
    );
  }
}

/**
 * Belief lifecycle suite (B4): the preference-confidence update path
 * emits a decision-change receipt for each material confidence band
 * change captured this pass. `bandDrops` is the existing, already-
 * computed set of material weakenings (a band actually dropped), so
 * this rides on data the refresh already produced without touching its
 * byte-identical no-op guarantees. The receipt's idempotency key
 * (subject + before + after) makes a re-run a no-op. Fail-soft.
 */
function writeConfidenceReceipts(
  vault: string,
  refresh: RefreshResult,
  agent: string,
  now: Date,
): void {
  for (const d of refresh.bandDrops) {
    const before = `confidence:${d.previous}${d.previous_value !== null ? `(${d.previous_value.toFixed(2)})` : ""}`;
    const after = `confidence:${d.next}(${d.next_value.toFixed(2)})`;
    try {
      appendDecisionChangeReceipt(vault, {
        subject: d.id,
        before,
        after,
        confidenceDelta: d.previous_value !== null ? d.next_value - d.previous_value : null,
        actor: agent,
        rationale: `applied ${d.applied} / violated ${d.violated}`,
        reasonCode: "confidence-refresh",
        ts: now.toISOString(),
      });
    } catch {
      // Accountability mirror is best-effort; the refreshed preference
      // bytes remain authoritative.
    }
  }
}

/** Step 3: move each planned retire into `retired/`, honouring the evidence gate. */
function executeRetires(
  vault: string,
  cfg: BrainConfig,
  now: Date,
  plan: PlanState,
  wikilinkToRun: string,
): DreamGatedRetireEntry[] {
  // v0.12.0 Brain Integrity Suite: declined retires accumulate here.
  // Always an array (even when no gate is configured) so the eventual
  // DreamRunSummary.gated_retires field is consistently shaped.
  const gatedRetires: DreamGatedRetireEntry[] = [];
  const gateThreshold = cfg.retire.confirmed_evidence_min_threshold;

  for (const r of plan.retires) {
    const fromPath = preferencePath(vault, r.slug);
    if (!existsSync(fromPath)) continue;
    // v0.12.0 Brain Integrity Suite: destructive-from-confirmed gate.
    // When the operator has set retire.confirmed_evidence_min_threshold,
    // refuse to retire a confirmed (unpinned) pref whose accumulated
    // evidence count is below the configured floor. Operator-initiated
    // retires bypass.
    if (gateThreshold !== undefined && gateThreshold > 0) {
      try {
        const existing = parsePreference(fromPath);
        if (shouldGateRetireFromConfirmed(existing, r.reason, gateThreshold)) {
          gatedRetires.push({
            pref_id: existing.id,
            topic: existing.topic,
            applied_count: existing.applied_count,
            violated_count: existing.violated_count,
            threshold: gateThreshold,
            attempted_reason: r.reason,
          });
          continue;
        }
      } catch {
        // Parse failure - fall through to the normal retire path
        // (moveToRetired will surface the error through stderr below).
      }
    }
    try {
      moveToRetired(vault, fromPath, r.reason, {
        now,
        retired_by: wikilinkToRun,
        ...(r.supersededBy ? { superseded_by: r.supersededBy } : {}),
      });
      // Belief lifecycle suite (A4): record the accelerated retirement of
      // a low-recall superseded ancestor as a dedicated audit event.
      if (r.chainDecay) {
        appendLogEvent(vault, {
          timestamp: isoSecond(now),
          eventType: BRAIN_LOG_EVENT_KIND.chainDecay,
          body: {
            preference: `[[ret-${r.slug}]]`,
            reason: r.reason,
            stale_days: String(CHAIN_DECAY_STALE_DAYS),
          },
        });
      }
    } catch (err) {
      // A retire failure is logged via the `skip-corrupted-frontmatter`
      // pathway only if it stemmed from a parse error during the
      // plan; here the file may have been moved already (rare race).
      // Surface the cause so an operator chasing a missing retire can
      // see which slug tripped.
      process.stderr.write(
        `warning: retire stale pref ${r.slug} failed: ${(err as Error).message}\n`,
      );
    }
  }
  return gatedRetires;
}

/** Step 4: move every consumed signal out of `inbox/`. */
function moveConsumedSignals(vault: string, plan: PlanState): string[] {
  const moved: string[] = [];
  for (const sig of plan.signalsToMove.values()) {
    const dest = processedSignalPath(vault, sig.date, sig.slug);
    try {
      renameSync(sig.path, dest);
      moved.push(sig.id);
    } catch (err) {
      // Best-effort: a missing source signal (already moved) is
      // benign on rerun. Still surface so a real I/O issue is visible.
      process.stderr.write(
        `warning: move signal ${sig.id} to processed/ failed: ${(err as Error).message}\n`,
      );
    }
  }
  return moved;
}

/**
 * Heal phase (F6): opt-in deterministic vault enrichment, run after the
 * retire/move mutations (heal-after-mutations). Off by default so the
 * default install stays byte-identical; a failure is a warning, never
 * fatal to the dream pass.
 *
 * A SAFEGUARD STOP IS NOT SUCH A FAILURE, and the difference is the whole
 * reason this catch is narrowed. "Heal could not enrich a page" is a
 * hygiene miss the pass survives; "the operator cancelled" and "the pass
 * is past its budget" are decisions about the RUN, and swallowing either
 * into a stderr warning plus `0` would report a pass that enriched
 * nothing where the truth is a pass that was stopped. The pass's own
 * post-mutation checkpoint would throw an instant later anyway - so
 * absorbing it here only ever bought a wrong `heal_enriched: 0` on the
 * way to the same error.
 */
function runHealEnrichmentSafely(vault: string, safeguard: Safeguard | undefined): number {
  try {
    return runHealEnrichment(vault, safeguard ? { safeguard } : {}).enriched;
  } catch (err) {
    if (err instanceof SafeguardTimeoutError || err instanceof SafeguardAbortError) throw err;
    process.stderr.write(`warning: heal enrichment failed: ${(err as Error).message}\n`);
    return 0;
  }
}

/**
 * Brain Integrity Suite (v0.12.0). Pure decision function for the
 * destructive-from-confirmed gate. Exported so the gate logic can be
 * unit-tested without driving a full dream run.
 *
 * Returns `true` when the candidate retire MUST be held back. The
 * caller is responsible for recording a {@link DreamGatedRetireEntry}
 * and skipping the actual `moveToRetired` call.
 */
export function shouldGateRetireFromConfirmed(
  existing: BrainPreference,
  reason: BrainRetiredReason,
  threshold: number | undefined,
): boolean {
  if (threshold === undefined || threshold <= 0) return false;
  if (reason === BRAIN_RETIRED_REASON.userRejected) return false;
  if (reason === BRAIN_RETIRED_REASON.mergedInto) return false;
  if (existing.status !== BRAIN_PREFERENCE_STATUS.confirmed) return false;
  if (existing.pinned) return false;
  const evidenceCount = (existing.applied_count ?? 0) + (existing.violated_count ?? 0);
  return evidenceCount < threshold;
}

/**
 * Slugs whose retire the gate declined. The log body and the
 * DreamRunSummary must agree on this set, or the next dream pass would
 * parse a `pref-foo` log claiming the pref was retired while the file is
 * still in `preferences/`.
 */
export function gatedRetireSlugs(gatedRetires: ReadonlyArray<DreamGatedRetireEntry>): Set<string> {
  return new Set(gatedRetires.map((g) => preferenceSlug(g.pref_id)));
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS);
}
