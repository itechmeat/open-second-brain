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

export function dream(vault: string, opts: DreamOptions = {}): DreamRunSummary {
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun === true;
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
  const intentReview = buildIntentReview(vault, { now });

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

  // v0.12.0 Brain Integrity Suite: finalise the durable workrun
  // immediately before constructing the summary. Any crash building
  // the summary leaves the workrun dangling for the next pass to
  // spot. `workrun` is null on dry-run / pre-mutation paths.
  workrun?.finalize();

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
