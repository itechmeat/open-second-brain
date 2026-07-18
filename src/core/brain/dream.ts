/**
 * `dream` — the only mutating batch operation in the Brain layer.
 *
 * `dream` reads the current Brain state and decides which transitions
 * to apply. It is deterministic given the inputs and the configured
 * time (the `--now` parameter). The algorithm is anchored in design
 * doc §7.3 and the per-rule clarifications in §7.4.
 *
 * Outputs (high level):
 *
 *   - Pre-run snapshot under `Brain/.snapshots/<run_id>.tar.zst`,
 *     created BEFORE any state-changing write so a crash mid-run can
 *     be rolled back atomically.
 *   - New / updated files in `Brain/preferences/`.
 *   - Moves into `Brain/retired/`.
 *   - Moves from `Brain/inbox/` into `Brain/inbox/processed/`.
 *   - One appended event in `Brain/log/<today>.md` summarising the
 *     run — **only** if any state actually changed. Idempotent reruns
 *     touch nothing.
 *
 * Invariants:
 *
 *   - Same-sign signals on an active preference are noted (moved to
 *     `processed/`, log event `noted-redundant`) but do NOT create a
 *     second preference and do NOT increment `applied_count`.
 *   - Opposite-sign signals against an active preference accumulate
 *     toward a rebuttal. Hitting `candidate_threshold` retires the
 *     active preference (reason `rebutted`) UNLESS it is pinned, in
 *     which case the rebut attempt is logged as a `retain-pinned`
 *     event and the preference stays.
 *   - Corrupted frontmatter on a single file produces a
 *     `skip-corrupted-frontmatter` log event and is skipped. The run
 *     continues for the rest of the tree.
 *   - dryRun mode returns the planned summary but performs no writes.
 */

import { existsSync, readdirSync, renameSync } from "node:fs";
import { basename, join } from "node:path";

import { parseFrontmatter } from "../vault.ts";
import { regenerateActiveQuiet } from "./active.ts";
import { regenerateLessonsQuiet } from "./lessons.ts";
import { openWorkrun, WORKRUN_PHASE, type WorkrunHandle } from "./dream-workrun.ts";
import { DREAM_PHASE, type DreamPhase, type DreamPhaseSummary } from "./dream-phases.ts";
import { extractTemporalConstraints } from "./temporal-extract.ts";
import { runHealEnrichment } from "./heal-run.ts";
import { collectEvidenceForSlug } from "./evidence.ts";
import { buildIntentReview, type BrainIntentReviewEntry } from "./intent-review.ts";
import { writePreferenceTxn } from "./preference-txn.ts";
import { appendLogEvent, type BrainLogEntry } from "./log.ts";
import { moveToRetired, parsePreference } from "./preference.ts";
import { parseSignal } from "./signal.ts";
import { isTombstoned } from "./lifecycle/tombstone.ts";
import { appendDecisionChangeReceipt } from "./decisions/receipts.ts";
import {
  CHAIN_DECAY_STALE_DAYS,
  effectiveStaleThresholdDays,
  isLowRecallSupersededAncestor,
} from "./inject-governor.ts";
import { isPinned } from "./pin.ts";
import { createSnapshot, pruneSnapshots } from "./snapshot.ts";
import { loadBrainConfig, resolveGuardrails } from "./policy.ts";
import { applySelfApprovalGuardrail } from "./trust/self-approval-guardrail.ts";
import {
  brainDirs,
  dreamWorkrunPath,
  preferencePath,
  processedSignalPath,
  snapshotPath,
  vaultRelative,
} from "./paths.ts";
import { countSigns, dominantSignOf } from "./sign.ts";
import { compactRunStamp, isoDate, isoSecond } from "./time.ts";
import {
  emptyPlan,
  filterWithinWindow,
  recordSignalMove,
  type CorruptedEntry,
  type PlanState,
  type PreferenceRecord,
  type RetiredRecord,
  type DreamQuarantinedEntry,
  type ScanResult,
  type SignalRecord,
} from "./dream-plan.ts";
import {
  planRefresh,
  scanApplyEvidence,
  type DreamOutcomeRegression,
  type RefreshResult,
} from "./dream-refresh.ts";
import { buildReconcileOutcomes } from "./reconcile-outcomes.ts";
import { renderPrefLink } from "./wikilink.ts";
import {
  BRAIN_LOG_EVENT_KIND,
  BRAIN_PREFERENCE_STATUS,
  BRAIN_RETIRED_REASON,
  BRAIN_SIGNAL_SIGN,
  type BrainConfig,
  type BrainPreference,
  type BrainRetiredReason,
  type BrainSignal,
  type BrainSignalSign,
  type DreamOpenQuestion,
} from "./types.ts";

// ----- Public types --------------------------------------------------------

/**
 * Structured non-fatal warning emitted alongside a dream summary. The
 * dream pass still completes when warnings are present; callers
 * (CLI / MCP) decide whether to surface them.
 */
export interface DreamWarning {
  readonly code: string;
  readonly message: string;
}

/**
 * Entry surfacing a step the dream pass attempted but could not
 * fully verify. Distinct from a `DreamWarning` (which flags
 * configuration smells): an `uncertain` entry means "I tried, no
 * hard error, but I cannot claim the operation completed". Consumed
 * by the trust verdict + operator summary (v0.10.16).
 */
export interface DreamUncertainEntry {
  /** Stable code identifying which sub-operation could not confirm. */
  readonly code: string;
  /** Optional topic slug or preference id this uncertainty concerns. */
  readonly topic?: string;
  /** Human-readable explanation. */
  readonly message: string;
}

/**
 * Brain Integrity Suite (v0.12.0). Entry for a retire that the dream
 * pass declined because `retire.confirmed_evidence_min_threshold` was
 * set and the source preference's accumulated evidence count fell
 * below it. The pref stays in `preferences/`; the operator can lift
 * the gate by raising the evidence count, lowering the threshold, or
 * running `o2b brain reject` explicitly.
 */
export interface DreamGatedRetireEntry {
  readonly pref_id: string;
  readonly topic: string;
  readonly applied_count: number;
  readonly violated_count: number;
  /** Configured threshold the pref's evidence count fell below. */
  readonly threshold: number;
  /** The retire reason the plan computed before the gate fired. */
  readonly attempted_reason: BrainRetiredReason;
}

export interface DreamRunSummary {
  /** `dream-YYYY-MM-DD-HHMMSS`. */
  readonly run_id: string;
  /** False on a true no-op run (no signals, no transitions, no retires). */
  readonly changed: boolean;
  /** Preference ids newly created in `unconfirmed` state. */
  readonly new_unconfirmed: ReadonlyArray<string>;
  /** Preference ids transitioning `unconfirmed → confirmed`. */
  readonly confirmed: ReadonlyArray<string>;
  /** Preferences moved to `retired/` and the reason for each. */
  readonly retired: ReadonlyArray<{ id: string; reason: BrainRetiredReason }>;
  /** Topic slugs where opposite-sign signals are accumulating but no
   *  state change happened yet (window not exceeded, or pinned). */
  readonly contradictions: ReadonlyArray<string>;
  /** Signal ids moved from inbox/ into inbox/processed/. */
  readonly moved_to_processed: ReadonlyArray<string>;
  /**
   * Signal ids dropped by §6 signal-suppression — a user-rejected
   * retired pref with the same topic blocked them from re-promotion.
   * Each entry is just the signal id (the retired wikilink + reason
   * land in the `signal-suppressed` log event).
   */
  readonly suppressed: ReadonlyArray<string>;
  /**
   * Non-fatal warnings raised during the run. Currently emitted only
   * for `non-primary-dream-run` (the runtime running dream differs
   * from `Brain/_brain.yaml.primary_agent`); the list is the
   * extension point for future advisory checks.
   */
  readonly warnings: ReadonlyArray<DreamWarning>;
  /**
   * Sub-operations the dream pass attempted but could not fully
   * verify. Empty on every clean run; populated by future
   * uncertainty-surfacing paths (v0.10.16).
   */
  readonly uncertain: ReadonlyArray<DreamUncertainEntry>;
  /**
   * Signal clusters held back from promotion by the self-approval
   * guardrail (v0.10.16). Empty when no cluster missed a threshold,
   * or when the guardrail is configured at default values that
   * match pre-v0.10.16 behaviour.
   */
  readonly quarantined: ReadonlyArray<DreamQuarantinedEntry>;
  /**
   * Deterministic pre-dream intent review over active signal clusters.
   * This is audit data for the two-stage gate: intent review explains
   * whether a cluster is ready for the existing main dream review,
   * needs more evidence, or is blocked by conflicting signals.
   */
  readonly intent_reviews: ReadonlyArray<BrainIntentReviewEntry>;
  /**
   * Brain Integrity Suite (v0.12.0). Retires the dream pass planned
   * but declined to execute because the source preference's evidence
   * count fell below `retire.confirmed_evidence_min_threshold`. Empty
   * when the config field is absent (the default).
   */
  readonly gated_retires: ReadonlyArray<DreamGatedRetireEntry>;
  /**
   * Outcome-regression findings (t_d478df53): confirmed preferences
   * whose recent applied events co-occur with failure outcomes. The
   * confidence penalty is already applied in this run's refresh; the
   * list is the explainable staging surface. Empty on outcome-free
   * vaults.
   */
  readonly outcome_regressions: ReadonlyArray<DreamOutcomeRegression>;
  /**
   * Multi-phase dream pipeline (Brain lifecycle suite, Feature 2).
   * Ordered per-phase summaries (close, reconcile, synthesize, heal,
   * log) for a changed run; empty on a no-op run. Additive: existing
   * fields are unchanged.
   */
  readonly phases: ReadonlyArray<DreamPhaseSummary>;
  /**
   * Reconcile-phase domain classification (Brain lifecycle suite,
   * Feature 3). Contradictions that stayed unresolved, each tagged with
   * a domain. Source-freshness contradictions that auto-resolved are
   * NOT listed here (they are recorded as `reconcile` log events on a
   * changed run). The legacy `contradictions` field remains a derived
   * topic-only view for back-compat.
   */
  readonly open_questions: ReadonlyArray<DreamOpenQuestion>;
  /** Snapshot file (absent on a no-op run). */
  readonly snapshot_path?: string;
  /** Log file the run summary landed in (absent on a no-op run). */
  readonly log_path?: string;
  /** True iff the run was a dry-run (no on-disk mutations performed). */
  readonly dry_run?: boolean;
}

export interface DreamOptions {
  /** Wall clock for the run. Defaults to `new Date()`. */
  readonly now?: Date;
  /** When true, compute the plan but make no writes. */
  readonly dryRun?: boolean;
  /**
   * Identity of the agent invoking dream. Compared against
   * `Brain/_brain.yaml.primary_agent`; mismatch emits a
   * `non-primary-dream-run` warning and tags the dream summary log
   * event with `non_primary_agent: <name>`. When unset, the warning
   * never fires (back-compat with callers that have not been
   * threaded yet); the CLI always provides the value.
   */
  readonly agentName?: string;
  /**
   * Cooperative deadline (t_06784b8d): checkpointed at entry and at
   * the phase seams (pre-mutation, post-promote, pre-finalize). A
   * tripped guard on the mutation path leaves the durable workrun
   * dangling, which is exactly the integrity contract - the next
   * pass spots and reports it.
   */
  readonly safeguard?: import("./safeguard.ts").Safeguard;
}

// ----- Internal scan types ------------------------------------------------

// ----- Main entry ----------------------------------------------------------

export function dream(vault: string, opts: DreamOptions = {}): DreamRunSummary {
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun === true;
  opts.safeguard?.checkpoint();
  const cfg = loadBrainConfig(vault);
  let runId = formatRunId(now);
  const wikilinkToRun = `[[Brain/log/${isoDate(now)}]]`;

  // Collect non-fatal warnings raised during the run. The
  // non-primary-dream-run check is the first one: when the caller
  // declares an agent name and it differs from the vault's declared
  // primary, surface a structured warning. We do NOT abort — the
  // declaration is observability, not access control.
  const warnings: DreamWarning[] = [];
  const callerAgent = opts.agentName?.trim() ?? "";
  const isNonPrimary =
    cfg.primary_agent !== null && callerAgent.length > 0 && callerAgent !== cfg.primary_agent;
  if (isNonPrimary) {
    warnings.push({
      code: "non-primary-dream-run",
      message:
        `dream run from agent '${callerAgent}', but primary is ` +
        `'${cfg.primary_agent}'. Convention violation, run proceeds.`,
    });
  }

  // 0. Scan the whole Brain/ tree. Corrupted files (frontmatter
  //    parse-errors) are surfaced separately so the planning phase
  //    can emit `skip-corrupted-frontmatter` log entries without
  //    aborting.
  const scan = scanBrain(vault);
  const intentReview = buildIntentReview(vault, { now });

  // 1-2. Plan per-topic transitions: new unconfirmed preferences,
  //      same-sign noted-redundant moves, rebuttal accumulation.
  const plan = planTopics(scan, cfg, now, wikilinkToRun);

  // 3. Plan refresh: applied / violated / last_evidence / confidence,
  //    and unconfirmed → confirmed promotion. We need the log of all
  //    apply-evidence entries up to `now` — we read every day file
  //    referenced by `last_evidence_at` plus today's file. Since the
  //    plan doesn't yet know dates, we scan the entire log/ directory.
  const evidence = scanApplyEvidence(vault);
  const refresh = planRefresh(vault, scan, evidence, cfg, now, plan);

  // 4. Plan retires (expired-unconfirmed, stale-no-evidence). Pinned
  //    preferences get a `retain-pinned` log event instead of a real
  //    retire.
  planAutoRetires(scan, cfg, now, plan, refresh);

  // 5. Plan signal moves (inbox/ → processed/).
  planSignalMoves(scan, plan);

  // Reconcile phase (F3): classify each contradiction topic into a
  // domain. Source-freshness with a clear gap auto-resolves (recorded,
  // never a sub-threshold mutation); everything else becomes an open
  // question. Computed in-memory before the `changed` gate so the
  // summary carries open_questions on both the no-op and changed paths;
  // the `reconcile` log events below are emitted only on a changed run.
  const reconcile = buildReconcileOutcomes(scan, plan, cfg, now);

  // Decide if anything is going to change. We treat any of the
  // following as a state change:
  //   - a new unconfirmed pref
  //   - a refreshed pref (counters/confidence/status changed)
  //   - a retire
  //   - a same-sign signal noted on an active pref (move + log)
  //   - a corrupted frontmatter (we want the skip event recorded)
  //   - any pinned-rebut-attempt warning
  const changed =
    plan.newUnconfirmed.length > 0 ||
    refresh.confirmed.size > 0 ||
    refresh.updated.size > 0 ||
    plan.retires.length > 0 ||
    plan.notedRedundant.length > 0 ||
    plan.signalsToMove.size > 0 ||
    plan.retainPinned.length > 0 ||
    plan.signalsSuppressed.length > 0 ||
    // v0.10.16: quarantine is a recorded decision (deferred-but-noted),
    // so a run that produces only quarantine entries is still a
    // meaningful run from the operator's perspective.
    plan.quarantined.length > 0 ||
    scan.corrupted.length > 0;

  if (!changed) {
    if (!dryRun) {
      regenerateActiveQuiet(vault, { now });
      regenerateLessonsQuiet(vault, { now });
    }
    return Object.freeze({
      run_id: runId,
      changed: false,
      new_unconfirmed: [],
      confirmed: [],
      retired: [],
      contradictions: [...plan.contradictionTopics],
      moved_to_processed: [],
      suppressed: [],
      warnings: Object.freeze([...warnings]),
      uncertain: Object.freeze([] as ReadonlyArray<DreamUncertainEntry>),
      quarantined: Object.freeze([...plan.quarantined]),
      intent_reviews: Object.freeze([...intentReview.reviews]),
      gated_retires: Object.freeze([] as ReadonlyArray<DreamGatedRetireEntry>),
      outcome_regressions: Object.freeze([...refresh.outcomeRegressions]),
      phases: Object.freeze([] as ReadonlyArray<DreamPhaseSummary>),
      open_questions: Object.freeze([...reconcile.openQuestions]),
      ...(dryRun ? { dry_run: true } : {}),
    } satisfies DreamRunSummary);
  }

  // ---- Execute --------------------------------------------------------

  // Snapshot must succeed before any mutation. If it fails, the
  // function throws and nothing changes on disk.
  let snapshotPathStr: string | undefined;
  // Honor an already-expired deadline BEFORE spending snapshot I/O.
  opts.safeguard?.checkpoint();
  if (!dryRun) {
    runId = nextAvailableDreamRunId(vault, runId);
    const snap = createSnapshot(vault, runId);
    snapshotPathStr = snap.path;
  }

  // Order of operations matters for the on-disk invariants:
  //   1. Write new unconfirmed preferences (so signal moves can find
  //      them).
  //   2. Apply refresh (counters, confidence, promotion) to existing
  //      preferences.
  //   3. Move retiring preferences out (after the refresh has had a
  //      chance to surface the most recent counters in the retired
  //      file). NOTE: refresh skips entries that will retire.
  //   4. Move consumed signals into `processed/`.
  //   5. Emit log entries (noted-redundant, retain-pinned,
  //      skip-corrupted-frontmatter, dream summary).
  const moved: string[] = [];
  // F6: count of user pages the opt-in heal phase enriched (0 unless
  // dream.heal_enrich_enabled).
  let healEnriched = 0;
  // v0.12.0 Brain Integrity Suite: declined retires accumulate here.
  // Always declared (even when no gate is configured) so the eventual
  // DreamRunSummary.gated_retires field is consistently an array.
  const gatedRetires: DreamGatedRetireEntry[] = [];

  // v0.12.0 Brain Integrity Suite: durable workrun for the dream pass.
  // Opened lazily on the mutation path (no workrun on dry-run or
  // no-op early-return). The handle is null until the exec branch
  // claims it; `finally` finalises if non-null.
  let workrun: WorkrunHandle | null = null;
  opts.safeguard?.checkpoint();
  if (!dryRun) {
    workrun = openWorkrun(vault, runId);
    workrun.checkpoint(WORKRUN_PHASE.clusterComplete);
    // Multi-phase dream (F2): close + reconcile are complete by the time
    // we reach the mutation path - the scan and contradiction planning
    // both ran before the `changed` gate. Emit their checkpoints here in
    // order; synthesize + heal follow the write loops below.
    workrun.checkpoint(WORKRUN_PHASE.closeComplete);
    workrun.checkpoint(WORKRUN_PHASE.reconcileComplete);
  }

  if (!dryRun) {
    // Edit-history (F4): every dream-pass write records its content
    // before/after so a preference's evolution stays auditable. The
    // agent of record is whoever invoked the dream run.
    const historyOpts = { agent: opts.agentName ?? "dream", now: () => now };
    for (const np of plan.newUnconfirmed) {
      // Fresh pref has no apply-evidence yet; recentApplied/recentViolated
      // start empty and stay so until the next dream pass after the
      // first `brain_apply_evidence` event.
      // v0.12.0 Brain Integrity Suite: route every dream-pass write
      // through writePreferenceTxn so _revision auto-stamps and
      // _content_hash lands automatically on confirmed promotions.
      // Empty expectations array - dream's plan-time logic has
      // already decided to proceed; the txn just owns the bookkeeping.
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
      // Same txn route as the newUnconfirmed loop: auto-stamps
      // _revision (existing+1) and _content_hash on confirmed status.
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

    // Belief lifecycle suite (B4): the preference-confidence update path
    // emits a decision-change receipt for each material confidence band
    // change captured this pass. `bandDrops` is the existing, already-
    // computed set of material weakenings (a band actually dropped), so
    // this rides on data the refresh already produced without touching its
    // byte-identical no-op guarantees. The receipt's idempotency key
    // (subject + before + after) makes a re-run a no-op. Fail-soft.
    for (const d of refresh.bandDrops) {
      const before = `confidence:${d.previous}${d.previous_value !== null ? `(${d.previous_value.toFixed(2)})` : ""}`;
      const after = `confidence:${d.next}(${d.next_value.toFixed(2)})`;
      try {
        appendDecisionChangeReceipt(vault, {
          subject: d.id,
          before,
          after,
          confidenceDelta: d.previous_value !== null ? d.next_value - d.previous_value : null,
          actor: opts.agentName ?? "dream",
          rationale: `applied ${d.applied} / violated ${d.violated}`,
          reasonCode: "confidence-refresh",
          ts: now.toISOString(),
        });
      } catch {
        // Accountability mirror is best-effort; the refreshed preference
        // bytes remain authoritative.
      }
    }

    for (const r of plan.retires) {
      const fromPath = preferencePath(vault, r.slug);
      if (!existsSync(fromPath)) continue;
      // v0.12.0 Brain Integrity Suite: destructive-from-confirmed gate.
      // When the operator has set retire.confirmed_evidence_min_threshold,
      // refuse to retire a confirmed (unpinned) pref whose accumulated
      // evidence count is below the configured floor. Operator-initiated
      // retires bypass.
      const gateThreshold = cfg.retire.confirmed_evidence_min_threshold;
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

    // Heal phase (F6): opt-in deterministic vault enrichment, run after
    // the retire/move mutations (heal-after-mutations). Off by default so
    // the default install stays byte-identical; a failure is a warning,
    // never fatal to the dream pass.
    if (cfg.dream.heal_enrich_enabled === true) {
      try {
        healEnriched = runHealEnrichment(vault).enriched;
      } catch (err) {
        process.stderr.write(`warning: heal enrichment failed: ${(err as Error).message}\n`);
      }
    }
  } else {
    // Dry-run still reports the move list so the caller's summary is
    // accurate, but it does not touch disk.
    for (const sig of plan.signalsToMove.values()) moved.push(sig.id);
  }

  // v0.12.0 Brain Integrity Suite: mark promote + retire phases. The
  // dream.ts execution loop runs promote (writePreference) then retire
  // (moveToRetired) sequentially; one checkpoint covers both
  // mutations so the workrun stays compact yet recovery-meaningful.
  opts.safeguard?.checkpoint();
  if (workrun !== null) {
    workrun.checkpoint(WORKRUN_PHASE.promoteComplete);
    // Multi-phase dream (F2): synthesize = the promote/confirm writes
    // just completed; heal = the retire (and, when enabled, enrichment)
    // writes. Emit the phase checkpoints in order alongside the legacy
    // promote/retire markers (readers tolerate the extra phases).
    workrun.checkpoint(WORKRUN_PHASE.synthesizeComplete);
    workrun.checkpoint(WORKRUN_PHASE.retireComplete);
    workrun.checkpoint(WORKRUN_PHASE.healComplete);
  }

  // v0.12.0 Brain Integrity Suite: build the gated-slug set once so the
  // log body and the DreamRunSummary stay consistent — both views must
  // exclude retires the destructive-from-confirmed gate skipped, or
  // the next dream pass would parse a `pref-foo` log claiming the
  // pref was retired while the file is still in `preferences/`.
  const gatedSlugs = new Set(gatedRetires.map((g) => g.pref_id.replace(/^pref-/, "")));

  // Emit log entries: skip-corrupted-frontmatter first (chronological
  // sense: corruption was detected during planning), then per-topic
  // events (noted-redundant), then run summary last.
  if (!dryRun) {
    let logCursorMs = now.getTime();
    const nextStamp = (): string => {
      const ts = new Date(logCursorMs);
      logCursorMs += 1000; // increment per emission so headings stay distinct
      return isoSecond(ts);
    };

    for (const corrupt of scan.corrupted) {
      writeEvent(vault, {
        timestamp: nextStamp(),
        eventType: BRAIN_LOG_EVENT_KIND.skipCorruptedFrontmatter,
        body: {
          path: vaultRelative(corrupt.path, vault),
        },
      });
    }

    for (const noted of plan.notedRedundant) {
      writeEvent(vault, {
        timestamp: nextStamp(),
        eventType: BRAIN_LOG_EVENT_KIND.notedRedundant,
        body: {
          preference: noted.preference,
          signal: noted.signal,
        },
      });
    }

    // Reconcile phase (F3): one event per open question + per
    // auto-resolution. Persisted only on this changed path so a no-op
    // run stays byte-identical.
    for (const q of reconcile.openQuestions) {
      writeEvent(vault, {
        timestamp: nextStamp(),
        eventType: BRAIN_LOG_EVENT_KIND.reconcile,
        body: {
          topic: q.topic,
          domain: q.domain,
          reason: q.reason,
          ...(q.scope ? { scope: q.scope } : {}),
          positives: String(q.positive_count),
          negatives: String(q.negative_count),
        },
      });
    }
    for (const r of reconcile.autoResolved) {
      writeEvent(vault, {
        timestamp: nextStamp(),
        eventType: BRAIN_LOG_EVENT_KIND.reconcile,
        body: {
          topic: r.topic,
          domain: r.domain,
          resolution: "auto-resolved",
          winner_sign: r.winner_sign,
          margin_days: String(r.margin_days),
        },
      });
    }

    for (const suppressed of plan.signalsSuppressed) {
      writeEvent(vault, {
        timestamp: nextStamp(),
        eventType: BRAIN_LOG_EVENT_KIND.signalSuppressed,
        body: {
          signal: suppressed.signal,
          retired: suppressed.retired,
          topic: suppressed.topic,
          reason: suppressed.reason,
        },
      });
    }

    for (const retain of plan.retainPinned) {
      // `retain-pinned` is not in the strict BrainLogEventKind enum
      // (the design doc names a generic `retire` event with an
      // attempted-but-blocked reason). We log it as a `retire` event
      // with a `blocked: pinned` payload field so the parser
      // round-trips cleanly and the doctor command can flag it.
      writeEvent(vault, {
        timestamp: nextStamp(),
        eventType: BRAIN_LOG_EVENT_KIND.retire,
        body: {
          preference: retain.preference,
          reason: retain.reason,
          blocked: "pinned",
        },
      });
    }

    // Summary event last. Link rendering threads the in-memory
    // principle alongside the id so the digest / Obsidian view can
    // hover-preview the rule without an extra file open.
    const slugToPrefPrinciple = new Map<string, string>();
    for (const rec of scan.preferences) {
      const recSlug = rec.pref.id.startsWith("pref-")
        ? rec.pref.id.slice("pref-".length)
        : rec.pref.id;
      slugToPrefPrinciple.set(recSlug, rec.pref.principle);
    }
    const newUnconfirmedIds = plan.newUnconfirmed.map((p) =>
      renderPrefLink({ id: `pref-${p.slug}`, principle: p.principle }),
    );
    const confirmedIds = Array.from(refresh.confirmed.values()).map((slug) =>
      renderPrefLink({
        id: `pref-${slug}`,
        principle: refresh.updated.get(slug)?.principle ?? slugToPrefPrinciple.get(slug) ?? "",
      }),
    );
    const retiredEntries = plan.retires
      .filter((r) => !gatedSlugs.has(r.slug))
      .map(
        (r) => `${renderPrefLink({ id: `ret-${r.slug}`, principle: r.principle })} (${r.reason})`,
      );
    const summaryBody: Record<string, string | ReadonlyArray<string>> = {
      run_id: runId,
    };
    if (newUnconfirmedIds.length > 0) summaryBody["new_unconfirmed"] = newUnconfirmedIds;
    if (confirmedIds.length > 0) summaryBody["confirmed"] = confirmedIds;
    if (retiredEntries.length > 0) summaryBody["retired"] = retiredEntries;
    if (moved.length > 0) summaryBody["moved_to_processed"] = moved;
    if (plan.contradictionTopics.size > 0) {
      summaryBody["contradictions"] = Array.from(plan.contradictionTopics);
    }
    if (plan.signalsSuppressed.length > 0) {
      summaryBody["suppressed"] = plan.signalsSuppressed.map((s) => `${s.signal} ← ${s.retired}`);
    }
    if (refresh.bandDrops.length > 0) {
      // Format matches the digest's tolerant `parseShiftLine` parser:
      // `[[pref-…|principle]] <from> -> <to> (applied: N, violated: M)`.
      summaryBody["confidence_shifts"] = refresh.bandDrops.map((d) =>
        [
          renderPrefLink({ id: d.id, principle: d.principle }),
          d.previous,
          "->",
          d.next,
          `(applied: ${d.applied}, violated: ${d.violated})`,
        ].join(" "),
      );
    }
    if (isNonPrimary) {
      // Audit-trail row matching the structured warning. Stored
      // alongside `run_id` so a non-primary dream pass is greppable in
      // the log without parsing the structured warnings array.
      summaryBody["non_primary_agent"] = callerAgent;
    }

    writeEvent(vault, {
      timestamp: nextStamp(),
      eventType: BRAIN_LOG_EVENT_KIND.dream,
      body: summaryBody,
    });
  }

  // Prune snapshots after the run so the new archive itself counts
  // toward retention.
  if (!dryRun) {
    try {
      pruneSnapshots(vault, cfg.snapshots.retention_count);
    } catch (err) {
      // Pruning is a hygiene step; failure should not turn a
      // successful dream run into an error. The next run will retry.
      // Surface so an operator can spot a recurring disk/permission
      // issue instead of wondering why retention stopped.
      process.stderr.write(`warning: prune snapshots failed: ${(err as Error).message}\n`);
    }
    regenerateActiveQuiet(vault, { now });
    regenerateLessonsQuiet(vault, { now });
  }

  // v0.12.0 Brain Integrity Suite: finalise the durable workrun
  // immediately before constructing the summary. Any crash building
  // the summary leaves the workrun dangling for the next pass to
  // spot. `workrun` is null on dry-run / pre-mutation paths.
  workrun?.finalize();

  // Multi-phase dream (F2): structured per-phase summaries for a changed
  // run. Metrics are integer counters derived from the plan/refresh that
  // already ran; additive keys may appear in later versions.
  const activeSignalCount = scan.signals.filter((s) => s.active).length;
  const retiredThisRun = plan.retires.filter((r) => !gatedSlugs.has(r.slug)).length;
  const phases: ReadonlyArray<DreamPhaseSummary> = Object.freeze([
    phaseSummary(DREAM_PHASE.close, {
      active_signals: activeSignalCount,
      preferences: scan.preferences.length,
      retired_files: scan.retired.length,
    }),
    phaseSummary(DREAM_PHASE.reconcile, {
      contradictions: plan.contradictionTopics.size,
      open_questions: reconcile.openQuestions.length,
      auto_resolved: reconcile.autoResolved.length,
    }),
    phaseSummary(DREAM_PHASE.synthesize, {
      new_unconfirmed: plan.newUnconfirmed.length,
      confirmed: refresh.confirmed.size,
    }),
    phaseSummary(DREAM_PHASE.heal, {
      retired: retiredThisRun,
      enriched: healEnriched,
    }),
    phaseSummary(DREAM_PHASE.log, {
      moved: moved.length,
      suppressed: plan.signalsSuppressed.length,
    }),
  ]);

  return Object.freeze({
    run_id: runId,
    changed: true,
    phases,
    open_questions: Object.freeze([...reconcile.openQuestions]),
    new_unconfirmed: plan.newUnconfirmed.map((p) => `pref-${p.slug}`),
    confirmed: Array.from(refresh.confirmed.values()).map((s) => `pref-${s}`),
    retired: plan.retires
      .filter((r) => !gatedSlugs.has(r.slug))
      .map((r) => ({ id: `ret-${r.slug}`, reason: r.reason })),
    contradictions: Array.from(plan.contradictionTopics),
    moved_to_processed: moved,
    suppressed: plan.signalsSuppressed.map((s) =>
      s.signal.replace(/^\[\[/, "").replace(/\]\]$/, ""),
    ),
    warnings: Object.freeze([...warnings]),
    uncertain: Object.freeze([] as ReadonlyArray<DreamUncertainEntry>),
    quarantined: Object.freeze([...plan.quarantined]),
    intent_reviews: Object.freeze([...intentReview.reviews]),
    gated_retires: Object.freeze([...gatedRetires]),
    outcome_regressions: Object.freeze([...refresh.outcomeRegressions]),
    ...(snapshotPathStr ? { snapshot_path: snapshotPathStr } : {}),
    ...(dryRun
      ? { dry_run: true }
      : { log_path: join(brainDirs(vault).log, `${isoDate(now)}.md`) }),
  } satisfies DreamRunSummary);
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

// ----- Scan ---------------------------------------------------------------

function scanBrain(vault: string): ScanResult {
  const dirs = brainDirs(vault);
  const signals: SignalRecord[] = [];
  const preferences: PreferenceRecord[] = [];
  const retired: RetiredRecord[] = [];
  const corrupted: CorruptedEntry[] = [];

  if (existsSync(dirs.inbox)) {
    for (const name of readdirSync(dirs.inbox)) {
      if (!name.endsWith(".md")) continue;
      const full = join(dirs.inbox, name);
      // Belief lifecycle suite (t_7d5a3589): a tombstoned signal is
      // excluded from the dream pass so it is never re-clustered.
      if (isTombstoned(parseFrontmatter(full)[0])) continue;
      try {
        const sig = parseSignal(full);
        signals.push({ path: full, signal: sig, active: true });
      } catch {
        corrupted.push({ path: full });
      }
    }
  }
  if (existsSync(dirs.processed)) {
    for (const name of readdirSync(dirs.processed)) {
      if (!name.endsWith(".md")) continue;
      const full = join(dirs.processed, name);
      if (isTombstoned(parseFrontmatter(full)[0])) continue;
      try {
        const sig = parseSignal(full);
        signals.push({ path: full, signal: sig, active: false });
      } catch {
        corrupted.push({ path: full });
      }
    }
  }
  if (existsSync(dirs.preferences)) {
    for (const name of readdirSync(dirs.preferences)) {
      if (!name.endsWith(".md")) continue;
      const full = join(dirs.preferences, name);
      const rawMeta = parseFrontmatter(full)[0];
      if (isTombstoned(rawMeta)) continue;
      // Belief lifecycle suite (A4): capture the raw superseded_by pointer
      // (the typed parser drops it) so accelerated chain decay can see a
      // temporally-superseded ancestor.
      const supersededBy =
        typeof rawMeta["superseded_by"] === "string" && rawMeta["superseded_by"] !== ""
          ? (rawMeta["superseded_by"] as string)
          : null;
      try {
        const pref = parsePreference(full);
        preferences.push({ path: full, pref, supersededBy });
      } catch {
        corrupted.push({ path: full });
      }
    }
  }
  if (existsSync(dirs.retired)) {
    for (const name of readdirSync(dirs.retired)) {
      if (!name.endsWith(".md")) continue;
      const full = join(dirs.retired, name);
      // Retired files we only need for topic + id (for supersede
      // bookkeeping) plus the optional `user_rejected_reason` that
      // drives signal-suppression (v0.10.1, _summary §6). We do a
      // lightweight frontmatter parse to avoid the strict folder
      // invariant check failing on permissive setups.
      try {
        const [meta] = parseFrontmatter(full);
        const topic = typeof meta["topic"] === "string" ? meta["topic"] : "";
        const id = typeof meta["id"] === "string" ? meta["id"] : "";
        const principle = typeof meta["principle"] === "string" ? meta["principle"] : "";
        const scope = typeof meta["scope"] === "string" ? meta["scope"] : undefined;
        const userReason =
          typeof meta["user_rejected_reason"] === "string"
            ? (meta["user_rejected_reason"] as string).trim()
            : "";
        if (topic && id) {
          retired.push({
            path: full,
            topic,
            id,
            principle,
            ...(scope ? { scope } : {}),
            ...(userReason ? { user_rejected_reason: userReason } : {}),
          });
        }
      } catch {
        corrupted.push({ path: full });
      }
    }
  }
  return { signals, preferences, retired, corrupted };
}

// ----- Planning -----------------------------------------------------------

function planTopics(
  scan: ScanResult,
  cfg: BrainConfig,
  now: Date,
  _wikilinkToRun: string,
): PlanState {
  void _wikilinkToRun;
  const plan = emptyPlan();
  const reservedSlugs = collectReservedPreferenceSlugs(scan);

  // Group active signals by topic. We only consider active signals for
  // the create/rebut decisions; processed signals stay in the global
  // log via `evidenced_by` already.
  const byTopic = new Map<string, SignalRecord[]>();
  for (const rec of scan.signals) {
    if (!rec.active) continue;
    const topic = rec.signal.topic;
    const arr = byTopic.get(topic);
    if (arr) arr.push(rec);
    else byTopic.set(topic, [rec]);
  }

  // Index existing active preferences by topic.
  const prefByTopic = new Map<string, PreferenceRecord>();
  for (const p of scan.preferences) {
    // The first wins; design doc §7.4 invariant says "one preference per
    // topic", so a duplicate would be a doctor-level issue, not a dream
    // concern.
    if (!prefByTopic.has(p.pref.topic)) prefByTopic.set(p.pref.topic, p);
  }

  // Index retired by topic for supersede bookkeeping.
  const retiredByTopic = new Map<string, RetiredRecord[]>();
  for (const r of scan.retired) {
    const arr = retiredByTopic.get(r.topic);
    if (arr) arr.push(r);
    else retiredByTopic.set(r.topic, [r]);
  }

  for (const [topic, sigs] of byTopic) {
    const active = prefByTopic.get(topic);
    if (active) {
      handleSignalsOnActivePref(active, sigs, plan, cfg, now, scan.signals, reservedSlugs);
      continue;
    }
    // v0.10.1 _summary §6: when a retired pref for this topic carries
    // a `user_rejected_reason`, the user explicitly rejected the rule
    // — re-growing it from fresh signals is exactly what they were
    // asking us not to do. Suppress every matching signal, emit one
    // `signal-suppressed` event per signal pointing at the retired
    // pref + the reason, and move them straight to processed.
    //
    // Per-signal scope match: an unscoped suppressor swallows every
    // signal on the topic; a scoped suppressor only swallows signals
    // sharing its scope (a signal without scope still matches an
    // unscoped suppressor but never a scoped one). Multiple retired
    // prefs on the same topic are tried in order — the first matching
    // suppressor wins. Non-matching signals fall through and remain
    // eligible for candidate-pref planning below.
    const suppressors = (retiredByTopic.get(topic) ?? []).filter((r) => !!r.user_rejected_reason);
    let candidateSigs: SignalRecord[] = sigs;
    if (suppressors.length > 0) {
      const remaining: SignalRecord[] = [];
      for (const sig of sigs) {
        const suppressor = suppressors.find((r) => {
          if (!r.scope) return true;
          if (!sig.signal.scope) return false;
          return r.scope === sig.signal.scope;
        });
        if (!suppressor) {
          remaining.push(sig);
          continue;
        }
        plan.signalsSuppressed.push({
          signal: `[[${sig.signal.id}]]`,
          retired: renderPrefLink({
            id: suppressor.id,
            principle: suppressor.principle,
          }),
          reason: suppressor.user_rejected_reason!,
          topic,
        });
        recordSignalMove(plan, sig);
      }
      if (remaining.length === 0) continue;
      candidateSigs = remaining;
    }
    // No active pref for this topic → either promote or note
    // contradiction.
    const windowedSigs = filterWithinWindow(
      candidateSigs,
      cfg.dream.contradiction_window_days,
      now,
    );
    const positives = windowedSigs.filter((s) => s.signal.signal === BRAIN_SIGNAL_SIGN.positive);
    const negatives = windowedSigs.filter((s) => s.signal.signal === BRAIN_SIGNAL_SIGN.negative);
    const dominant = positives.length >= negatives.length ? positives : negatives;
    const minoritySize = Math.min(positives.length, negatives.length);
    const dominantSize = dominant.length - minoritySize; // cancellation
    if (dominantSize >= cfg.dream.candidate_threshold) {
      // v0.10.16: extra self-approval guardrail. Defaults
      // (min_signals=2, min_distinct_agents=1, min_age_days=0) make
      // this check a no-op for clusters that already passed
      // candidate_threshold. Operators may opt into stricter
      // thresholds via `_brain.yaml:guardrails:*`. A failed gate
      // routes the cluster to `quarantined` instead of creating a
      // new unconfirmed preference; the contributing signals stay
      // in inbox/ so the cluster naturally re-evaluates on the next
      // pass once more evidence accumulates.
      const guardrails = resolveGuardrails(cfg);
      const distinctAgents = new Set(dominant.map((s) => s.signal.agent)).size;
      let earliestSignalMs = Number.POSITIVE_INFINITY;
      for (const s of dominant) {
        const t = Date.parse(s.signal.created_at);
        if (Number.isFinite(t) && t < earliestSignalMs) earliestSignalMs = t;
      }
      const ageDays = Number.isFinite(earliestSignalMs)
        ? Math.max(0, Math.floor((now.getTime() - earliestSignalMs) / (24 * 60 * 60 * 1000)))
        : 0;
      const verdict = applySelfApprovalGuardrail(
        {
          signal_count: dominantSize,
          distinct_agents: distinctAgents,
          age_days: ageDays,
        },
        guardrails,
      );
      if (verdict.decision === "quarantine") {
        plan.quarantined.push({
          topic,
          signal_count: dominantSize,
          distinct_agents: distinctAgents,
          age_days: ageDays,
          failed_gates: verdict.failed_gates,
        });
        continue;
      }
      // Decide supersede: if a retired pref for the same topic exists,
      // wire it through.
      const retiredForTopic = retiredByTopic.get(topic);
      const supersedes =
        retiredForTopic && retiredForTopic.length > 0 ? retiredForTopic[0]!.id : undefined;
      const sign = dominant[0]!.signal.signal;
      // Slug from topic for the canonical filename, but reserve slugs
      // already present in retired/. Otherwise a superseding preference
      // can be created as `pref-topic` while `ret-topic` already exists;
      // its later retirement would fail trying to overwrite that retired
      // file.
      const slug = allocatePreferencePlanSlug(topic, reservedSlugs);
      const principle = dominant[0]!.signal.principle;
      const scope = dominant[0]!.signal.scope;
      // evidencedBy = wikilinks to ALL active signals (dominant + minority)
      // that contributed to this topic in the window. We deliberately
      // include the minority signals so the audit trail preserves the
      // contradiction story even after the file moves to processed/.
      const evidencedBy = windowedSigs.map((s) => `[[${s.signal.id}]]`);
      const supersedesRecord = supersedes
        ? retiredForTopic!.find((r) => r.id === supersedes)
        : undefined;
      plan.newUnconfirmed.push({
        slug,
        topic,
        scope,
        principle,
        evidencedBy,
        sign,
        ...deriveSignalTemporal(dominant[0]!.signal, now),
        ...(supersedesRecord
          ? {
              supersedes: renderPrefLink({
                id: supersedesRecord.id,
                principle: supersedesRecord.principle,
              }),
            }
          : {}),
      });
      // Every contributing signal in the window gets moved.
      for (const s of windowedSigs) {
        recordSignalMove(plan, s);
      }
    } else if (positives.length > 0 && negatives.length > 0) {
      plan.contradictionTopics.add(topic);
    }
  }
  return plan;
}

function handleSignalsOnActivePref(
  active: PreferenceRecord,
  sigs: SignalRecord[],
  plan: PlanState,
  cfg: BrainConfig,
  now: Date,
  allSignals: ReadonlyArray<SignalRecord>,
  reservedSlugs: Set<string>,
): void {
  // Determine the active preference's sign. Order of preference:
  //
  //   1. Walk `evidenced_by` wikilinks and look up each referenced
  //      signal in the global scan; the dominant sign among them is
  //      the pref's "sign of record". This is the design-correct
  //      derivation since the writer baked those evidence pointers in.
  //
  //   2. If no `evidenced_by` resolves (e.g. a hand-crafted pref or a
  //      pref whose source signals were manually pruned), look at all
  //      historical signals on the same topic in the global scan.
  //
  //   3. If still nothing, assume the active pref is on the OPPOSITE
  //      sign of the incoming dominant sign. This makes a unanimous
  //      flood of new signals always count as rebuttal — which is the
  //      conservative, fail-loud choice: the operator gets a clear
  //      rebut/retire signal and can manually intervene if the system
  //      misread their intent.
  const signCounts = (records: ReadonlyArray<SignalRecord>): { pos: number; neg: number } =>
    countSigns(records.map((r) => r.signal.signal));

  // Tier-1 derivation now lives in the shared `sign.ts` helper so the
  // semantic-health contradiction detector and this pass agree on one
  // definition. `dominantSignOf` returning a concrete sign is exactly
  // the old `evidenceRecords.length > 0` branch (every signal carries a
  // polarity, so a resolved evidence link always counts); `"unknown"`
  // is the old "no evidenced signal resolved" fall-through.
  const signSignById = new Map(allSignals.map((r) => [r.signal.id, r.signal.signal]));
  const topicRecords = allSignals.filter((r) => r.signal.topic === active.pref.topic);

  const evidenceSign = dominantSignOf(active.pref.evidenced_by, signSignById);
  let activeSign: BrainSignalSign;
  if (evidenceSign !== "unknown") {
    activeSign = evidenceSign;
  } else if (topicRecords.length > sigs.length) {
    // There are processed signals for this topic that are NOT among
    // the active inbox set — use them.
    const historical = topicRecords.filter((r) => !sigs.includes(r));
    const c = signCounts(historical);
    activeSign = c.pos >= c.neg ? BRAIN_SIGNAL_SIGN.positive : BRAIN_SIGNAL_SIGN.negative;
  } else {
    // Fallback: assume the active pref is OPPOSITE to the incoming
    // dominant sign. A unanimous flood thus reads as rebuttal.
    const c = signCounts(sigs);
    activeSign = c.pos > c.neg ? BRAIN_SIGNAL_SIGN.negative : BRAIN_SIGNAL_SIGN.positive;
  }

  const oppositeSign: BrainSignalSign =
    activeSign === BRAIN_SIGNAL_SIGN.positive
      ? BRAIN_SIGNAL_SIGN.negative
      : BRAIN_SIGNAL_SIGN.positive;

  const windowed = filterWithinWindow(sigs, cfg.dream.contradiction_window_days, now);
  const sameSign = windowed.filter((s) => s.signal.signal === activeSign);
  const opposing = windowed.filter((s) => s.signal.signal === oppositeSign);

  // Same-sign → note redundant + move to processed.
  for (const s of sameSign) {
    plan.notedRedundant.push({
      preference: renderPrefLink({
        id: active.pref.id,
        principle: active.pref.principle,
      }),
      signal: `[[${s.signal.id}]]`,
    });
    recordSignalMove(plan, s);
  }

  // Opposite-sign → accumulate toward rebuttal.
  if (opposing.length >= cfg.dream.candidate_threshold) {
    const slug = active.pref.id.startsWith("pref-")
      ? active.pref.id.slice("pref-".length)
      : active.pref.id;
    if (isPinned(active.pref)) {
      plan.retainPinned.push({
        preference: renderPrefLink({
          id: active.pref.id,
          principle: active.pref.principle,
        }),
        reason: BRAIN_RETIRED_REASON.rebutted,
      });
      // Rebuttal signals on a pinned pref still get moved out — they
      // were addressed (the system saw them) and clogging the inbox
      // doesn't help.
      for (const s of opposing) recordSignalMove(plan, s);
    } else {
      plan.retires.push({
        slug,
        principle: active.pref.principle,
        reason: BRAIN_RETIRED_REASON.rebutted,
      });
      for (const s of opposing) recordSignalMove(plan, s);
      // Create a new unconfirmed pref for the new direction.
      // Build a fresh slug to avoid filename collision with the
      // retiring pref (which lives under preferences/<slug>.md and
      // will move to retired/<slug>.md). The simplest scheme: the
      // same slug, since `moveToRetired` unlinks the source first.
      // For safety against a half-completed move, we suffix with
      // `-rebut`.
      const newSlug = allocatePreferencePlanSlug(`${slug}-rebut`, reservedSlugs);
      const principle = opposing[0]!.signal.principle;
      const scope = opposing[0]!.signal.scope;
      const evidencedBy = opposing.map((s) => `[[${s.signal.id}]]`);
      plan.newUnconfirmed.push({
        slug: newSlug,
        topic: active.pref.topic,
        scope,
        principle,
        evidencedBy,
        sign: oppositeSign,
        ...deriveSignalTemporal(opposing[0]!.signal, now),
        supersedes: renderPrefLink({
          id: active.pref.id,
          principle: active.pref.principle,
        }),
      });
    }
  } else if (opposing.length > 0) {
    plan.contradictionTopics.add(active.pref.topic);
  }
}

function collectReservedPreferenceSlugs(scan: ScanResult): Set<string> {
  const out = new Set<string>();
  for (const p of scan.preferences) {
    const slug = preferenceSlugFromId(p.pref.id, "pref-");
    if (slug) out.add(slug);
  }
  for (const r of scan.retired) {
    const slug = preferenceSlugFromId(r.id, "ret-");
    if (slug) out.add(slug);
  }
  return out;
}

function preferenceSlugFromId(id: string, prefix: "pref-" | "ret-"): string | null {
  return id.startsWith(prefix) && id.length > prefix.length ? id.slice(prefix.length) : null;
}

function allocatePreferencePlanSlug(base: string, reserved: Set<string>): string {
  let candidate = base;
  let suffix = 2;
  while (reserved.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix++;
  }
  reserved.add(candidate);
  return candidate;
}

/**
 * Brain lifecycle suite (F5). Derive a preference's bi-temporal validity
 * from the source signal: prefer the signal's explicit `valid_from` /
 * `valid_until`, otherwise extract formal ISO temporal tokens from the
 * signal's principle + raw text. Returns `{}` when neither yields a
 * constraint, so callers spread it without changing byte output.
 */
function deriveSignalTemporal(
  sig: BrainSignal,
  now: Date,
): { valid_from?: string; valid_until?: string } {
  if (sig.valid_from || sig.valid_until) {
    return {
      ...(sig.valid_from ? { valid_from: sig.valid_from } : {}),
      ...(sig.valid_until ? { valid_until: sig.valid_until } : {}),
    };
  }
  const text = `${sig.principle ?? ""}\n${sig.raw ?? ""}`;
  return extractTemporalConstraints(text, { now });
}

/** Build one phase summary (module-scoped: captures nothing). */
function phaseSummary(phase: DreamPhase, metrics: Record<string, number>): DreamPhaseSummary {
  return { phase, metrics };
}

// ----- Refresh + promote --------------------------------------------------

// ----- Auto-retires (expired-unconfirmed, stale-no-evidence) --------------

function planAutoRetires(
  scan: ScanResult,
  cfg: BrainConfig,
  now: Date,
  plan: PlanState,
  refresh: RefreshResult,
): void {
  for (const rec of scan.preferences) {
    const slug = rec.pref.id.startsWith("pref-") ? rec.pref.id.slice("pref-".length) : rec.pref.id;
    // Already planned to retire (rebutted)? Skip.
    if (plan.retires.some((r) => r.slug === slug)) continue;

    // Use the refreshed status/confirmed_at if available — a pref
    // promoted to confirmed in THIS run should be eligible for stale
    // retire only if its (yet-to-be-refreshed) last_evidence_at is
    // actually old. We branch on the post-refresh shape.
    const refreshed = refresh.updated.get(slug);
    const effectiveStatus = refreshed ? refreshed.status : rec.pref.status;
    const effectiveLastEvidence = refreshed
      ? refreshed.last_evidence_at
      : rec.pref.last_evidence_at;

    if (effectiveStatus === BRAIN_PREFERENCE_STATUS.unconfirmed) {
      const deadline = Date.parse(rec.pref.unconfirmed_until);
      if (Number.isFinite(deadline) && now.getTime() > deadline) {
        if (isPinned(rec.pref)) {
          plan.retainPinned.push({
            preference: renderPrefLink({
              id: rec.pref.id,
              principle: rec.pref.principle,
            }),
            reason: BRAIN_RETIRED_REASON.expiredUnconfirmed,
          });
        } else {
          plan.retires.push({
            slug,
            principle: rec.pref.principle,
            reason: BRAIN_RETIRED_REASON.expiredUnconfirmed,
          });
          // Remove the refresh update — no point writing immediately
          // before moving to retired/.
          refresh.updated.delete(slug);
        }
      }
      continue;
    }

    // Confirmed/quarantine → stale-no-evidence check. Quarantine
    // is "still active" (design summary §20) so the time-based decay
    // applies to it identically — a pref sitting idle with no
    // evidence eventually retires whether confidence was healthy or
    // probationary at the time the clock ran out.
    if (
      effectiveStatus === BRAIN_PREFERENCE_STATUS.confirmed ||
      effectiveStatus === BRAIN_PREFERENCE_STATUS.quarantine
    ) {
      // Belief lifecycle suite (A4): a low-recall superseded ancestor
      // decays on the accelerated window so it leaves the working set
      // faster than a live memory. Non-superseded / well-used prefs keep
      // the normal window, so a vault with no chains is byte-identical.
      const effectiveApplied = refreshed ? refreshed.applied_count : rec.pref.applied_count;
      const chainDecay = isLowRecallSupersededAncestor({
        supersededBy: rec.supersededBy,
        appliedCount: effectiveApplied,
      });
      const staleDays = effectiveStaleThresholdDays(chainDecay, cfg.retire.stale_evidence_days);
      if (!effectiveLastEvidence) {
        // Confirmed with no evidence at all? Shouldn't happen, but
        // gate on the same staleness rule using `confirmed_at`. We
        // measure from confirmation in that case (cheaper than a
        // hand-crafted invariant check).
        const confirmedAt = refreshed ? refreshed.confirmed_at : rec.pref.confirmed_at;
        if (!confirmedAt) continue;
        const days = daysBetween(Date.parse(confirmedAt), now.getTime());
        if (days > staleDays) {
          if (isPinned(rec.pref)) {
            plan.retainPinned.push({
              preference: renderPrefLink({
                id: rec.pref.id,
                principle: rec.pref.principle,
              }),
              reason: BRAIN_RETIRED_REASON.staleNoEvidence,
            });
          } else {
            plan.retires.push({
              slug,
              principle: rec.pref.principle,
              reason: BRAIN_RETIRED_REASON.staleNoEvidence,
              ...(chainDecay ? { chainDecay: true } : {}),
            });
            refresh.updated.delete(slug);
          }
        }
        continue;
      }
      const days = daysBetween(Date.parse(effectiveLastEvidence), now.getTime());
      if (days > staleDays) {
        if (isPinned(rec.pref)) {
          plan.retainPinned.push({
            preference: renderPrefLink({
              id: rec.pref.id,
              principle: rec.pref.principle,
            }),
            reason: BRAIN_RETIRED_REASON.staleNoEvidence,
          });
        } else {
          plan.retires.push({
            slug,
            principle: rec.pref.principle,
            reason: BRAIN_RETIRED_REASON.staleNoEvidence,
            ...(chainDecay ? { chainDecay: true } : {}),
          });
          refresh.updated.delete(slug);
        }
      }
    }
  }
}

// ----- Signal moves -------------------------------------------------------

function planSignalMoves(scan: ScanResult, plan: PlanState): void {
  // All active signals whose topic now corresponds to a planned new
  // pref or an active pref were already enqueued by the topic-loop /
  // active-pref handler. This function exists for the §7.3 step that
  // says "Move consumed signals out of inbox/": we cover the case
  // where a signal references a preference that already exists (the
  // active-pref path), and the case where a signal is part of a fresh
  // new_unconfirmed (the topic-loop path). Both already populated
  // `plan.signalsToMove`. Nothing additional needed here today.
  void scan;
  void plan;
}

// ----- Helpers ------------------------------------------------------------

function writeEvent(vault: string, event: BrainLogEntry): void {
  appendLogEvent(vault, event);
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 24 * 3600 * 1000);
}

function daysBetween(thenMs: number, nowMs: number): number {
  if (!Number.isFinite(thenMs)) return 0;
  return (nowMs - thenMs) / (24 * 3600 * 1000);
}

function formatRunId(d: Date): string {
  // dream-YYYY-MM-DD-HHMMSS
  return `dream-${compactRunStamp(d)}`;
}

function nextAvailableDreamRunId(vault: string, baseRunId: string): string {
  let candidate = baseRunId;
  for (
    let n = 2;
    existsSync(snapshotPath(vault, candidate)) || existsSync(dreamWorkrunPath(vault, candidate));
    n++
  ) {
    candidate = `${baseRunId}-${n}`;
  }
  return candidate;
}

// Silence "unused" warnings for symbols exported only via barrel.
void basename;
