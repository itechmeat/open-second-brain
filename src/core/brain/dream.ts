/**
 * `dream` — the only mutating batch operation in the Brain layer.
 *
 * `dream` reads the current Brain state and decides which transitions
 * to apply. It is deterministic given the inputs and the configured
 * time (the `--now` parameter). The algorithm is anchored in design
 * doc §7.3 and the per-rule clarifications in §7.4.
 *
 * This module is the ORCHESTRATOR: it sequences the stages and owns the
 * decisions that only make sense with the whole run in view — the run id,
 * the `changed` gate, the snapshot, the workrun lifecycle and the
 * safeguard checkpoints. Each stage's mechanics live in its own module:
 *
 *   - `dream-scan.ts`         read the `Brain/` tree into memory
 *   - `dream-plan-topics.ts`  what a cluster of signals on a topic means
 *   - `dream-refresh.ts`      counters, confidence, unconfirmed → confirmed
 *   - `dream-plan-retires.ts` when a preference has outlived its usefulness
 *   - `reconcile-outcomes.ts` domain classification of contradictions
 *   - `dream-apply.ts`        the plan turned into disk state, in order
 *   - `dream-report.ts`       the run's audit trail in `Brain/log/`
 *   - `dream-summary.ts`      the {@link DreamRunSummary} the caller sees
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

import { existsSync } from "node:fs";
import { join } from "node:path";

import { regenerateActiveQuiet } from "./active.ts";
import {
  applyDreamPlan,
  gatedRetireSlugs,
  plannedSignalMoveIds,
  type DreamApplyResult,
} from "./dream-apply.ts";
import { planAutoRetires } from "./dream-plan-retires.ts";
import { planTopics, topicKeyContentionWarnings } from "./dream-plan-topics.ts";
import type { PlanState } from "./dream-plan.ts";
import { planRefresh, scanApplyEvidence, type RefreshResult } from "./dream-refresh.ts";
import { writeDreamLog } from "./dream-report.ts";
import { scanBrain } from "./dream-scan.ts";
import { buildChangedSummary, buildNoOpSummary } from "./dream-summary.ts";
import type { DreamOptions, DreamRunSummary, DreamWarning } from "./dream-types.ts";
import { openWorkrun, WORKRUN_PHASE, type WorkrunHandle } from "./dream-workrun.ts";
import { buildIntentReview } from "./intent-review.ts";
import {
  OPERATION,
  progressCounter,
  progressReasonForError,
  type ProgressCounter,
} from "./progress.ts";
import { regenerateLessonsQuiet } from "./lessons.ts";
import { brainDirsForWrite, dreamWorkrunPath } from "./paths.ts";
import { loadBrainConfig } from "./policy.ts";
import { buildReconcileOutcomes } from "./reconcile-outcomes.ts";
import {
  planRollupLadder,
  readRollupLedger,
  resolveRollupThresholds,
  type RollupLadderPlan,
} from "./rollup-ladder.ts";
import { withDestructiveSnapshot } from "./snapshot-gate.ts";
import { compactRunStamp, isoDate } from "./time.ts";
import { BRAIN_SNAPSHOT_REASON } from "./types.ts";
import type { BrainConfig } from "./types.ts";

// ----- Public surface ------------------------------------------------------

export type {
  DreamGateOverrides,
  DreamGatedRetireEntry,
  DreamOptions,
  DreamRunSummary,
  DreamUncertainEntry,
  DreamWarning,
} from "./dream-types.ts";
export { shouldGateRetireFromConfirmed } from "./dream-apply.ts";
export { scanBrain } from "./dream-scan.ts";

// ----- Main entry ----------------------------------------------------------

/**
 * Execution stages of one pass, in the order they run.
 *
 * Neither existing vocabulary fits: `DREAM_PHASE` is the REPORTING order
 * of the summary, and `WORKRUN_PHASE` marks the points where a phase's
 * durable output has already landed - both are about what finished, and
 * progress is about what is happening. These five name the spans between
 * the safeguard checkpoints, which is where the wall-clock actually goes.
 *
 * So one operation has two stage vocabularies, and a reader will trip on
 * it, because `log` is a member of both and means different things: here
 * it is the span during which the audit tail is written, and in
 * `DREAM_PHASE` it is the summary section that reports what that span
 * did. If you are reading a progress record, this is the list it draws
 * from; if you are reading `DreamRunSummary.phases`, that is the other
 * one. Merging them would mean either reporting spans the summary does
 * not have or emitting progress for phases that never execute.
 */
const DREAM_STAGE = Object.freeze({
  scan: "scan",
  plan: "plan",
  apply: "apply",
  log: "log",
  finalize: "finalize",
} as const);

/** Code carried on the summary when the caller's progress sink failed. */
const PROGRESS_SINK_FAULT_CODE = "progress-sink-failed";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Carry a failed progress sink onto the summary the caller already reads.
 * Only the first fault is reported: the sink is detached after it, so a
 * second entry could only describe the same broken stream twice.
 */
function noteProgressFaults(warnings: DreamWarning[], faults: ReadonlyArray<string>): void {
  const first = faults[0];
  if (first === undefined) return;
  warnings.push({
    code: PROGRESS_SINK_FAULT_CODE,
    message: `progress reporting stopped after the sink threw: ${first}`,
  });
}

/**
 * Run one consolidation pass.
 *
 * A thin shell around {@link dreamRun} for one reason: a pass that stops
 * at a checkpoint - because the operator interrupted it, or because the
 * deadline elapsed - must say so on the progress stream before the error
 * leaves. Without this the stream would simply end, and a caller could
 * not tell a cancelled pass from a crashed one from a hung one, which is
 * the whole distinction `SafeguardAbortError` exists to preserve.
 */
export function dream(vault: string, opts: DreamOptions = {}): DreamRunSummary {
  // A caller's progress sink is an observer, and an observer must not be
  // able to destroy what it observes: a closed pipe or a renderer defect
  // cannot be allowed to abort a pass that is otherwise succeeding. Nor
  // may it vanish - the fault is carried out on the summary the caller
  // already reads, once, and the sink is detached for the rest of the run.
  const progressFaults: string[] = [];
  const progress = progressCounter(OPERATION.dream, opts.onProgress, {
    onSinkError: (error) => progressFaults.push(errorMessage(error)),
  });
  try {
    return dreamRun(vault, opts, progress, progressFaults);
  } catch (error) {
    const reason = progressReasonForError(error);
    if (reason !== null) progress.stop(reason);
    throw error;
  }
}

function dreamRun(
  vault: string,
  opts: DreamOptions,
  progress: ProgressCounter,
  progressFaults: ReadonlyArray<string>,
): DreamRunSummary {
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun === true;
  // The stage opens BEFORE the first checkpoint, not after it. A guard
  // that is already past its deadline - or a signal already aborted -
  // trips here, and a counter with no stage open emits nothing, so the
  // stream would report a pass that was stopped instantly as a pass that
  // never spoke. Those are the two cases this release exists to keep
  // apart.
  progress.start(DREAM_STAGE.scan);
  opts.safeguard?.checkpoint();
  const cfg = loadBrainConfig(vault);
  // Per-run gate resolution (no-dead-ends, Unit E): the override wins for
  // this run, the configured value decides when it is absent. Resolved
  // once, here, so the heal branch below has a single source of truth and
  // nothing writes the decision back to `_brain.yaml`.
  const healEnrichEnabled = opts.gates?.heal_enrich ?? cfg.dream.heal_enrich_enabled === true;
  let runId = formatRunId(now);
  const wikilinkToRun = `[[Brain/log/${isoDate(now)}]]`;

  const callerAgent = opts.agentName?.trim() ?? "";
  const isNonPrimary =
    cfg.primary_agent !== null && callerAgent.length > 0 && callerAgent !== cfg.primary_agent;
  const warnings = collectWarnings(isNonPrimary, callerAgent, cfg.primary_agent);

  // 0. Scan the whole Brain/ tree. Corrupted files (frontmatter
  //    parse-errors) are surfaced separately so the planning phase
  //    can emit `skip-corrupted-frontmatter` log entries without
  //    aborting.
  const scan = scanBrain(vault);
  progress.advance(DREAM_STAGE.scan);
  const intentReview = buildIntentReview(vault, { now });
  progress.start(DREAM_STAGE.plan, scan.preferences.length);

  // 1-2. Plan per-topic transitions: new unconfirmed preferences,
  //      same-sign noted-redundant moves, rebuttal accumulation.
  const plan = planTopics(scan, cfg, now);
  // A folded topic key claimed by two preferences is an ambiguity the pass
  // refuses to settle by scan order, so it planned nothing for that key. The
  // warning is how it says so - on the no-op summary as well as the changed
  // one, because a run that decided nothing is exactly the run that must
  // still explain itself.
  warnings.push(...topicKeyContentionWarnings(plan));

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

  // 5. §7.3 step "move consumed signals out of inbox/" needs no pass of
  //    its own: both routes that consume a signal - the topic loop and
  //    the active-pref handler - already enqueued it into
  //    `plan.signalsToMove` at the moment they decided to consume it.

  // Reconcile phase (F3): classify each contradiction topic into a
  // domain. Source-freshness with a clear gap auto-resolves (recorded,
  // never a sub-threshold mutation); everything else becomes an open
  // question. Computed in-memory before the `changed` gate so the
  // summary carries open_questions on both the no-op and changed paths;
  // the `reconcile` log events below are emitted only on a changed run.
  const reconcile = buildReconcileOutcomes(scan, plan, cfg, now);

  // Count-triggered fact rollup ladder (S3): pure counters over the
  // current fact artifacts (preferences) against the persisted per-tier
  // baselines. Computed before the `changed` gate so a run whose ONLY
  // effect is a rollup still counts as changed; below threshold it fires
  // nothing and the ledger is never written, so the run stays
  // byte-identical.
  let rollupPlan = buildRollupPlan(vault, cfg, scan.preferences.length, runId);

  if (!hasStateChange(plan, refresh, scan.corrupted.length, rollupPlan)) {
    if (!dryRun) {
      regenerateActiveQuiet(vault, { now });
      regenerateLessonsQuiet(vault, { now });
    }
    // A run that changed nothing still finished. Reporting it as an
    // unterminated stream would make an idempotent rerun - the common
    // case - indistinguishable from a pass that died in planning.
    progress.finish();
    noteProgressFaults(warnings, progressFaults);
    return buildNoOpSummary({
      runId,
      dryRun,
      plan,
      refresh,
      reconcile,
      intentReviews: intentReview.reviews,
      warnings,
    });
  }

  // ---- Execute --------------------------------------------------------

  // The pre-run recovery point and every mutation behind it now run
  // through `withDestructiveSnapshot`, the gate whose own header names
  // an inline `createSnapshot` as the anti-pattern it exists to prevent.
  // This module used to be that anti-pattern: it minted its own run id
  // through a second collision ladder, took its own archive, and pruned
  // retention afterwards with a third copy of the warning text. The
  // wrapper owns all three now, and the run id it reserves is the one
  // the workrun, the log and the rollup targets are named after.
  let snapshotPathStr: string | undefined;
  // Honor an already-expired deadline BEFORE spending snapshot I/O.
  opts.safeguard?.checkpoint();
  progress.start(DREAM_STAGE.apply);

  // v0.12.0 Brain Integrity Suite: durable workrun for the dream pass.
  // Opened lazily on the mutation path (no workrun on dry-run or
  // no-op early-return). The handle is null until the exec branch
  // claims it; it is finalised immediately before the summary is built.
  let workrun: WorkrunHandle | null = null;
  let exec: DreamApplyResult;
  if (dryRun) {
    // Dry-run still reports the move list so the caller's summary is
    // accurate, but it does not touch disk.
    opts.safeguard?.checkpoint();
    exec = { moved: plannedSignalMoveIds(plan), gatedRetires: [], healEnriched: 0 };
  } else {
    const baseRunId = runId;
    const gated = withDestructiveSnapshot(
      vault,
      BRAIN_SNAPSHOT_REASON.dream,
      (snapshot) => {
        runId = snapshot.runId;
        // The rollup plan (and each envelope's target_path) was built with
        // the pre-collision runId; if the ladder corrected it, rebuild the
        // plan so every target_path embeds the final run_id.
        if (rollupPlan.fired && runId !== baseRunId) {
          rollupPlan = buildRollupPlan(vault, cfg, scan.preferences.length, runId);
        }
        opts.safeguard?.checkpoint();
        const handle = openWorkrun(vault, runId);
        // Truthful checkpoints (no-dead-ends, Unit E). A marker means every
        // durable effect attributed to that phase is already on disk, so a
        // crash leaves a journal whose last marker names work that genuinely
        // finished. Cluster and close are the only two phases whose work
        // provably ends here: clustering is pure planning that produces no
        // file at all, and close's single artifact - the pre-run snapshot -
        // was written by the gate before this callback ran. Every other
        // marker moved down to the point where that phase's writes land;
        // see the emission notes there.
        handle.checkpoint(WORKRUN_PHASE.clusterComplete);
        handle.checkpoint(WORKRUN_PHASE.closeComplete);
        const applied = applyDreamPlan({
          vault,
          cfg,
          now,
          plan,
          refresh,
          agentName: opts.agentName,
          wikilinkToRun,
          healEnrichEnabled,
          workrun: handle,
        });
        return { applied, handle };
      },
      {
        // `now` rather than wall clock: the pass is byte-reproducible given
        // its injected clock, and the snapshot audit line must not be the
        // one thing that breaks that.
        now,
        // The dream run id names the workrun as well as the archive, so a
        // candidate free in `.snapshots/` is not enough. This is the claim
        // that used to live in a second ladder in this module.
        available: (candidate) => !existsSync(dreamWorkrunPath(vault, candidate)),
      },
    );
    snapshotPathStr = gated.snapshot.path;
    exec = gated.result.applied;
    workrun = gated.result.handle;
  }

  // Post-mutation safeguard checkpoint: every state-changing write for
  // this run is on disk, so a deadline that has passed stops the run here
  // rather than part-way through the audit tail.
  opts.safeguard?.checkpoint();
  progress.advance(DREAM_STAGE.apply);
  progress.start(DREAM_STAGE.log);

  // v0.12.0 Brain Integrity Suite: build the gated-slug set once so the
  // log body and the DreamRunSummary stay consistent — both views must
  // exclude retires the destructive-from-confirmed gate skipped, or
  // the next dream pass would parse a `pref-foo` log claiming the
  // pref was retired while the file is still in `preferences/`.
  const gatedSlugs = gatedRetireSlugs(exec.gatedRetires);

  if (!dryRun) {
    writeDreamLog({
      vault,
      now,
      runId,
      scan,
      plan,
      refresh,
      reconcile,
      rollupPlan,
      moved: exec.moved,
      gatedSlugs,
      isNonPrimary,
      callerAgent,
      workrun,
    });

    // Retention already ran inside the gate, immediately after the
    // archive was written. The set of survivors is the same either way -
    // this run creates no further archives - and the gate is where the
    // refusal and the removal list are reported, so a second prune here
    // would be a second rule for one directory.
    regenerateActiveQuiet(vault, { now });
    regenerateLessonsQuiet(vault, { now });
  }

  // Pre-finalize safeguard checkpoint (no-dead-ends, Unit E). Everything
  // between the post-mutation checkpoint and this line - the log events,
  // the rollup ledger write, snapshot pruning, the active/lessons
  // regeneration - used to run with no deadline check at all, so a run
  // already past its budget still reached `finalized`. Tripping here
  // leaves the workrun dangling, which is the documented contract.
  opts.safeguard?.checkpoint();
  progress.advance(DREAM_STAGE.log);
  progress.start(DREAM_STAGE.finalize);

  // v0.12.0 Brain Integrity Suite: finalise the durable workrun
  // immediately before constructing the summary. Any crash building
  // the summary leaves the workrun dangling for the next pass to
  // spot. `workrun` is null on dry-run / pre-mutation paths.
  workrun?.finalize();
  progress.advance(DREAM_STAGE.finalize);
  progress.finish();
  noteProgressFaults(warnings, progressFaults);

  return buildChangedSummary({
    runId,
    // `brainDirsForWrite` asserts the vault is writable, so the log path
    // is resolved only on the branch that actually wrote to it.
    runTail: dryRun
      ? { dry_run: true }
      : { log_path: join(brainDirsForWrite(vault).log, `${isoDate(now)}.md`) },
    scan,
    plan,
    refresh,
    reconcile,
    rollupPlan,
    intentReviews: intentReview.reviews,
    warnings,
    gatedRetires: exec.gatedRetires,
    gatedSlugs,
    moved: exec.moved,
    healEnriched: exec.healEnriched,
    snapshotPath: snapshotPathStr,
  });
}

/**
 * Non-fatal warnings raised during the run. The non-primary-dream-run
 * check is the first one: when the caller declares an agent name and it
 * differs from the vault's declared primary, surface a structured
 * warning. We do NOT abort — the declaration is observability, not
 * access control.
 */
function collectWarnings(
  isNonPrimary: boolean,
  callerAgent: string,
  primaryAgent: string | null,
): DreamWarning[] {
  if (!isNonPrimary) return [];
  return [
    {
      code: "non-primary-dream-run",
      message:
        `dream run from agent '${callerAgent}', but primary is ` +
        `'${primaryAgent}'. Convention violation, run proceeds.`,
    },
  ];
}

/**
 * Decide if anything is going to change. We treat any of the following
 * as a state change:
 *   - a new unconfirmed pref
 *   - a refreshed pref (counters/confidence/status changed)
 *   - a retire
 *   - a same-sign signal noted on an active pref (move + log)
 *   - a corrupted frontmatter (we want the skip event recorded)
 *   - any pinned-rebut-attempt warning
 *   - a fired rollup-ladder rung (S3)
 */
function hasStateChange(
  plan: PlanState,
  refresh: RefreshResult,
  corruptedCount: number,
  rollupPlan: RollupLadderPlan,
): boolean {
  return (
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
    rollupPlan.fired ||
    corruptedCount > 0
  );
}

function buildRollupPlan(
  vault: string,
  cfg: BrainConfig,
  factCount: number,
  runId: string,
): RollupLadderPlan {
  return planRollupLadder({
    factCount,
    ledger: readRollupLedger(vault),
    thresholds: resolveRollupThresholds(cfg),
    runId,
  });
}

function formatRunId(d: Date): string {
  // <reason>-YYYY-MM-DD-HHMMSS. The prefix is the snapshot-reason
  // constant rather than a literal, so the archive's filename and the
  // provenance stamped into its sidecar are one string.
  return `${BRAIN_SNAPSHOT_REASON.dream}-${compactRunStamp(d)}`;
}
