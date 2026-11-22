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
 *   - `dream-outcome.ts`      the `changed` gate, warnings, retire siblings
 *   - `dream-rollup.ts`       the rollup-ladder plan and its link manifest
 *   - `dream-tail.ts`         topic planning and the human view render
 *
 * Outputs (high level):
 *
 *   - Pre-run snapshot under `Brain/.snapshots/<run_id>.tar.zst`,
 *     created BEFORE any state-changing write so a crash mid-run can
 *     be rolled back atomically.
 *   - New / updated files in `Brain/preferences/`.
 *   - Moves into `Brain/retired/`.
 *   - Moves from `Brain/inbox/` into `Brain/inbox/processed/`.
 *   - Moves from `Brain/inbox/` into `Brain/inbox/archived/` for signals
 *     that left the contradiction window unconsumed (`signal-archive.ts`).
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

import { withTopicPass, withViewPass } from "./dream-tail.ts";
import { vaultRelativeOf } from "./no-vault.ts";
import { withLogReadPass } from "./log-days.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { regenerateActiveQuiet } from "./active.ts";
import {
  applyDreamPlan,
  gatedRetireSlugs,
  plannedSignalArchiveIds,
  plannedSignalMoveIds,
  type DreamApplyResult,
} from "./dream-apply.ts";
import { planAutoRetires } from "./dream-plan-retires.ts";
import { planTopics, topicKeyContentionWarnings } from "./dream-plan-topics.ts";
import type { ScanResult } from "./dream-plan.ts";
import {
  planCrossTopicRules,
  readCrossTopicLedger,
  resolveCrossTopicConfig,
} from "./dream-plan-cross-topic.ts";
import { planRefresh, scanApplyEvidence } from "./dream-refresh.ts";
import { writeDreamLog } from "./dream-report.ts";
import {
  assertDreamOwner,
  recheckDreamOwner,
  recheckUnboundDreamOwner,
} from "./dream-owner/gate.ts";
import { withDreamPassLock } from "./dream-owner/owner.ts";
import {
  dreamOwnerGateOptions,
  withOwnerTag,
  type DreamOwnerTag,
} from "./dream-owner/pass-record.ts";
import { scanBrain } from "./dream-scan.ts";
import { planSignalArchive } from "./signal-archive.ts";
import { buildChangedSummary, buildNoOpSummary } from "./dream-summary.ts";
import type { DreamOptions, DreamRunSummary, DreamWarning } from "./dream-types.ts";
import { openWorkrun, WORKRUN_PHASE, workrunPath, type WorkrunHandle } from "./dream-workrun.ts";
import { buildIntentReview } from "./intent-review.ts";
import { logShardWikilink } from "./log.ts";
import {
  OPERATION,
  progressCounter,
  PROGRESS_REASON,
  progressReasonForError,
  type ProgressCounter,
} from "./progress.ts";
import { regenerateLessonsQuiet } from "./lessons.ts";
import { brainDirsForWrite, collisionCandidateName } from "./paths.ts";
import { isStoreOnly } from "../store/store-only.ts";
import { collectBetweenSteps } from "../runtime/collect-garbage.ts";
import { repairLaneEntryIds } from "../store-migration/lane-id-repair.ts";
import { loadBrainConfig } from "./policy.ts";
import { buildReconcileOutcomes } from "./reconcile-outcomes.ts";
import { buildRollupPlan, memoizedLinkCandidates } from "./dream-rollup.ts";
import { collectWarnings, hasStateChange, withRetireSiblings } from "./dream-outcome.ts";
import { applySalienceGate } from "./salience-gate.ts";
import { withDestructiveSnapshot } from "./snapshot-gate.ts";
import { compactRunStamp, isoDate } from "./time.ts";
import { BRAIN_SNAPSHOT_REASON } from "./types.ts";

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
  /**
   * The tail steps that belong to the brain store (`dream-tail.ts`):
   * entered only where the store is in use and the pass is no dry run, so
   * a pass on a machine without a store reports the five stages above.
   */
  topics: "topics",
  view: "view",
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

/** `previewReadable` was passed to a pass that is not a dry run. */
export class DreamPreviewReadableError extends Error {
  constructor() {
    super("dream: previewReadable applies to a dry run only");
    this.name = "DreamPreviewReadableError";
  }
}

/**
 * The scan as a caller who may read only what `admit` passes sees it:
 * every record at a path it rejects is dropped, as if it were absent.
 */
function scanAsAdmitted(
  vault: string | null,
  scan: ScanResult,
  admit: (rel: string) => boolean,
): ScanResult {
  const keep = (path: string): boolean => admit(vaultRelativeOf(path, vault));
  return {
    ...scan,
    signals: scan.signals.filter((r) => keep(r.path)),
    preferences: scan.preferences.filter((r) => keep(r.path)),
    retired: scan.retired.filter((r) => keep(r.path)),
    corrupted: scan.corrupted.filter((r) => keep(r.path)),
    tombstonedPreferences: scan.tombstonedPreferences?.filter((r) => keep(r.path)),
  };
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
export function dream(vault: string | null, opts: DreamOptions = {}): DreamRunSummary {
  // The dream owner gate (dream-owner/gate.ts) comes first, before the
  // tail wrappers and the lane-id repair write: a live pass on a device
  // that is not the owner writes nothing. The owner's live pass holds the
  // device-local pass lock for its whole length and checks the role again
  // once it holds it. A look that finds the lock held leaves its release
  // to the next look; `o2b dream owner --release` refuses after the wait.
  const gate = assertDreamOwner(vault, dreamOwnerGateOptions(opts));
  if (gate.status === "preview") return dreamPass(vault, opts, null);
  if (gate.status === "unbound") {
    if (gate.store === null) return dreamPass(vault, opts, null);
    return withDreamPassLock(gate.store, () => {
      recheckUnboundDreamOwner(gate.store!);
      return dreamPass(vault, opts, null);
    });
  }
  return withDreamPassLock(gate.store, () => {
    // A release written between the gate and the lock moved the role:
    // look again under the lock, before any write.
    const owner = recheckDreamOwner(gate);
    return withOwnerTag(dreamPass(vault, opts, owner), owner, opts.agentName);
  });
}

/** The pass itself, once the owner gate let it through (see {@link dream}). */
function dreamPass(
  vault: string | null,
  opts: DreamOptions,
  owner: DreamOwnerTag | null,
): DreamRunSummary {
  // A caller's progress sink is an observer, and an observer must not be
  // able to destroy what it observes: a closed pipe or a renderer defect
  // cannot be allowed to abort a pass that is otherwise succeeding. Nor
  // may it vanish - the fault is carried out on the summary the caller
  // already reads, once, and the sink is detached for the rest of the run.
  const progressFaults: string[] = [];
  const progress = progressCounter(OPERATION.dream, opts.onProgress, {
    onSinkError: (error) => progressFaults.push(errorMessage(error)),
  });
  // A tail step stopped at the deadline ends the stream there, with its
  // reason; a step after it still runs, unreported, as before.
  let stopped = false;
  try {
    // One read pass for the consolidation: the store-only log is read once
    // and shared by every preference's evidence walk (log-days.ts). It
    // ends before the topic and view steps, which read the store on their
    // own and never the log days: holding the whole log through them only
    // added it to their peak memory.
    const summary = withViewPass(
      afterStep(
        withTopicPass(
          afterStep(withLogReadPass(() => dreamRun(vault, opts, progress, progressFaults, owner))),
          opts,
          {
            start: () => progress.start(DREAM_STAGE.topics),
            done: () => progress.advance(DREAM_STAGE.topics),
            stopped: (error) => {
              stopped = true;
              progress.stop(progressReasonForError(error) ?? PROGRESS_REASON.failed);
            },
          },
        ),
      ),
      opts,
      {
        start: () => {
          if (!stopped) progress.start(DREAM_STAGE.view);
        },
        done: () => {
          if (!stopped) progress.advance(DREAM_STAGE.view);
        },
        stopped: (error) => {
          if (stopped) return;
          stopped = true;
          progress.stop(progressReasonForError(error) ?? PROGRESS_REASON.failed);
        },
      },
    );
    // The stream ends after the tail steps, not after the consolidation:
    // on a large store they are where most of the time goes, and a stream
    // that reported "finished" before them read as a pass that hung.
    if (!stopped) progress.finish();
    return withLateProgressFault(summary, progressFaults);
  } catch (error) {
    const reason = progressReasonForError(error);
    if (reason !== null && !stopped) progress.stop(reason);
    throw error;
  }
}

/** `value`, once the garbage of the step that made it is collected (`collect-garbage.ts`). */
function afterStep<T>(value: T): T {
  collectBetweenSteps();
  return value;
}

/**
 * `summary` with the progress-sink fault the consolidation could not see:
 * the sink may first throw in a tail step, after the summary was built.
 */
function withLateProgressFault(
  summary: DreamRunSummary,
  faults: ReadonlyArray<string>,
): DreamRunSummary {
  if (faults.length === 0) return summary;
  if (summary.warnings.some((w) => w.code === PROGRESS_SINK_FAULT_CODE)) return summary;
  const warnings: DreamWarning[] = [];
  noteProgressFaults(warnings, faults);
  return { ...summary, warnings: [...summary.warnings, ...warnings] };
}

/** Ladder attempts for a no-vault run id, as many as a snapshot run gets. */
const NO_VAULT_RUN_ID_ATTEMPTS = 100;

/** The first `<base>[-N]` run id whose no-vault workrun journal does not exist yet. */
function uniqueNoVaultRunId(base: string): string {
  for (let attempt = 1; attempt <= NO_VAULT_RUN_ID_ATTEMPTS; attempt++) {
    const candidate = collisionCandidateName(base, attempt);
    if (!existsSync(workrunPath(null, candidate))) return candidate;
  }
  throw new Error(`dream: no free run id after ${NO_VAULT_RUN_ID_ATTEMPTS} attempts (${base})`);
}

/**
 * Regenerate the active and lessons digests after a pass. Where they land
 * is `compiledDigestPath`'s one rule: `Brain/active.md` and
 * `Brain/lessons.md` on an unswitched machine, the device-local cache on
 * a store-only one (design D14 item 7), which this warms.
 */
function regenerateDigestPages(vault: string | null, now: Date): void {
  regenerateActiveQuiet(vault, { now });
  regenerateLessonsQuiet(vault, { now });
}

function dreamRun(
  vault: string | null,
  opts: DreamOptions,
  progress: ProgressCounter,
  progressFaults: ReadonlyArray<string>,
  owner: DreamOwnerTag | null,
): DreamRunSummary {
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun === true;
  if (opts.previewReadable !== undefined && !dryRun) throw new DreamPreviewReadableError();
  // The stage opens BEFORE the first checkpoint, not after it. A guard
  // that is already past its deadline - or a signal already aborted -
  // trips here, and a counter with no stage open emits nothing, so the
  // stream would report a pass that was stopped instantly as a pass that
  // never spoke. Those are the two cases this release exists to keep
  // apart.
  progress.start(DREAM_STAGE.scan);
  opts.safeguard?.checkpoint();
  const cfg = loadBrainConfig(vault);
  // Lane entries an earlier release filed under another path's id are
  // moved to their own (`store-migration/lane-id-repair.ts`); a no-op once
  // repaired, and never a reason to fail the pass.
  if (!dryRun && (vault === null || isStoreOnly({ vault }))) {
    try {
      repairLaneEntryIds(vault);
    } catch {
      // The next pass tries again.
    }
  }
  // Per-run gate resolution (no-dead-ends, Unit E): the override wins for
  // this run, the configured value decides when it is absent. Resolved
  // once, here, so the heal branch below has a single source of truth and
  // nothing writes the decision back to `_brain.yaml`.
  const healEnrichEnabled = opts.gates?.heal_enrich ?? cfg.dream.heal_enrich_enabled === true;
  let runId = formatRunId(now);
  // The retired_by stamp every retire in this pass carries. Built
  // through the shared helper so it names the log shard the pass's own
  // events land in - with a configured device id, the bare-date shape
  // names a file this device never writes, and the doctor reads the
  // provenance as a broken link.
  const wikilinkToRun = logShardWikilink(isoDate(now));

  const callerAgent = opts.agentName?.trim() ?? "";
  // A brain with a dream owner names the owner instead (`owner` below).
  const isNonPrimary =
    owner === null &&
    cfg.primary_agent !== null &&
    callerAgent.length > 0 &&
    callerAgent !== cfg.primary_agent;
  const warnings = collectWarnings(isNonPrimary, callerAgent, cfg.primary_agent);

  // 0. Scan the whole Brain/ tree. Corrupted files (frontmatter
  //    parse-errors) are surfaced separately so the planning phase
  //    can emit `skip-corrupted-frontmatter` log entries without
  //    aborting.
  //
  //    The guard goes in and the sink does not, and the two decisions
  //    have different reasons - see `ScanBrainOptions`. The scan is the
  //    largest unbounded read in the pass, so leaving it unguarded put
  //    the whole `Brain/` tree between two of the pass's five
  //    checkpoints; the stream, by contrast, is this counter's, which
  //    already owns a `scan` stage.
  const fullScan = scanBrain(vault, opts.safeguard ? { safeguard: opts.safeguard } : {});
  opts.onScanPreferences?.(fullScan.preferences);
  const scan =
    opts.previewReadable === undefined
      ? fullScan
      : scanAsAdmitted(vault, fullScan, opts.previewReadable);
  progress.advance(DREAM_STAGE.scan);
  const intentReview = buildIntentReview(vault, {
    now,
    ...(opts.previewReadable !== undefined ? { readable: opts.previewReadable } : {}),
  });
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
  // Archive step (issue #195): inbox signals the topic plan did not consume
  // and that have left the contradiction window can never count toward a
  // candidate again, so they leave the inbox for `inbox/archived/`.
  // Planned after the topic plan so a consumed signal is never archived.
  warnings.push(...planSignalArchive(scan, cfg, now, plan));

  // 3. Plan refresh: applied / violated / last_evidence / confidence,
  //    and unconfirmed → confirmed promotion. We need the log of all
  //    apply-evidence entries up to `now` — we read every day file
  //    referenced by `last_evidence_at` plus today's file. Since the
  //    plan doesn't yet know dates, we scan the entire log/ directory.
  // The two walks that grow with the history: a pass past its deadline
  // stops inside them, before it has written anything.
  const checkpoint = (): void => opts.safeguard?.checkpoint();
  const evidence = scanApplyEvidence(vault, checkpoint);
  const refresh = planRefresh(vault, scan, evidence, cfg, now, plan, checkpoint);

  // 4. Plan retires (expired-unconfirmed, stale-no-evidence). Pinned
  //    preferences get a `retain-pinned` log event instead of a real
  //    retire.
  planAutoRetires(scan, cfg, now, plan, refresh);

  // 4b. Cross-topic rule promotion (t_642bc2b8). Planned after the
  //     refresh pass - the source pool reads post-refresh confirmation
  //     state - and after the retire plan, so a preference this pass is
  //     about to retire is never cited as evidence. Before the `changed`
  //     gate, so a fired promotion counts as a state change and a
  //     below-threshold or budgeted-out pass stays byte-identical; the
  //     rollup ladder is the structural precedent (plan before the
  //     gate, persist the ledger only when fired). The ledger read is
  //     skipped entirely when the feature is off: an un-opted-in vault
  //     pays no I/O here. The disclosure sink is the run's warning list:
  //     a declared knob the resolver floored (finding 62) is named on
  //     the summary, never applied silently.
  const crossTopicConfig = resolveCrossTopicConfig(cfg, (code, message) =>
    warnings.push({ code, message }),
  );
  const crossTopic = planCrossTopicRules({
    scan,
    refresh,
    config: crossTopicConfig,
    ledger: crossTopicConfig ? readCrossTopicLedger(vault) : null,
    now,
    plan,
  });

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

  // Deterministic salience gate over the ladder's fold set
  // (salience-lifecycle-enrichment, unit 1). The ladder counts facts and
  // nothing else, so this is the only seam where a salience judgement can
  // change what the pass asks a model to fold. With
  // `dream.salience_threshold` unset the gate is open and reads nothing,
  // which is why an un-opted-in vault pays no I/O here.
  const salienceGate = applySalienceGate({ vault, preferences: scan.preferences, cfg, now });

  // The wikilink targets a fired rung's envelope offers, built at most
  // ONCE per dream run and only if a rung fires. The manifest is a whole
  // -vault walk (a frontmatter read per note under owner-scope delivery),
  // the ladder is planned before the `changed` gate, and the runId
  // collision path below re-plans - so an eager build paid that walk on
  // every dry run that fires nothing, and twice on a collision.
  const linkCandidates = memoizedLinkCandidates(vault, opts.agentName, opts.readable);

  // Count-triggered fact rollup ladder (S3): pure counters over the
  // ADMITTED fact artifacts (preferences) against the persisted per-tier
  // baselines. Computed before the `changed` gate so a run whose ONLY
  // effect is a rollup still counts as changed; below threshold it fires
  // nothing and the ledger is never written, so the run stays
  // byte-identical.
  let rollupPlan = buildRollupPlan(vault, cfg, salienceGate.admitted, runId, linkCandidates);

  if (!hasStateChange(plan, refresh, scan.corrupted.length, rollupPlan)) {
    if (!dryRun) regenerateDigestPages(vault, now);
    // A run that changed nothing still finished (`dream` ends the stream
    // after the tail steps). Reporting it as an unterminated stream would
    // make an idempotent rerun - the common case - indistinguishable from
    // a pass that died in planning.
    noteProgressFaults(warnings, progressFaults);
    return buildNoOpSummary({
      runId,
      dryRun,
      plan,
      refresh,
      reconcile,
      intentReviews: intentReview.reviews,
      warnings,
      salienceGate,
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
    exec = {
      moved: plannedSignalMoveIds(plan),
      archived: plannedSignalArchiveIds(plan),
      gatedRetires: [],
      healEnriched: 0,
    };
  } else {
    const baseRunId = runId;
    const applyRun = (): { applied: DreamApplyResult; handle: WorkrunHandle } => {
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
        ...(opts.safeguard ? { safeguard: opts.safeguard } : {}),
        workrun: handle,
      });
      return { applied, handle };
    };
    if (vault === null) {
      // No vault (design D14 item 9): the store's shards are append-only
      // and need no pre-run snapshot, so the plan applies directly. The
      // run id climbs the same `-N` ladder a snapshot run does, so two
      // passes in one second never share a workrun journal.
      runId = uniqueNoVaultRunId(runId);
      if (rollupPlan.fired && runId !== baseRunId) {
        rollupPlan = buildRollupPlan(vault, cfg, salienceGate.admitted, runId, linkCandidates);
      }
      const ran = applyRun();
      exec = ran.applied;
      workrun = ran.handle;
    } else {
      const gated = withDestructiveSnapshot(
        vault,
        BRAIN_SNAPSHOT_REASON.dream,
        (snapshot) => {
          runId = snapshot.runId;
          // The rollup plan (and each envelope's target_path) was built
          // with the pre-collision runId; if the ladder corrected it,
          // rebuild the plan so every target_path embeds the final run_id.
          if (rollupPlan.fired && runId !== baseRunId) {
            rollupPlan = buildRollupPlan(vault, cfg, salienceGate.admitted, runId, linkCandidates);
          }
          return applyRun();
        },
        {
          // `now` rather than wall clock: the pass is byte-reproducible given
          // its injected clock, and the snapshot audit line must not be the
          // one thing that breaks that.
          now,
          // The dream run id names the workrun as well as the archive, so a
          // candidate free in `.snapshots/` is not enough. This is the claim
          // that used to live in a second ladder in this module.
          available: (candidate) => !existsSync(workrunPath(vault, candidate)),
        },
      );
      snapshotPathStr = gated.snapshot.path;
      exec = gated.result.applied;
      workrun = gated.result.handle;
    }
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
      crossTopicLedger: crossTopic.ledger,
      moved: exec.moved,
      archived: exec.archived,
      gatedSlugs,
      isNonPrimary,
      callerAgent,
      ...(owner !== null ? { owner } : {}),
      workrun,
    });

    // Retention already ran inside the gate, immediately after the
    // archive was written. The set of survivors is the same either way -
    // this run creates no further archives - and the gate is where the
    // refusal and the removal list are reported, so a second prune here
    // would be a second rule for one directory.
    regenerateDigestPages(vault, now);
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
  noteProgressFaults(warnings, progressFaults);

  const summary = buildChangedSummary({
    runId,
    // `brainDirsForWrite` asserts the vault is writable, so the log path
    // is resolved only on the branch that actually wrote to it.
    runTail: dryRun
      ? { dry_run: true }
      : {
          // A store-only machine writes `log-event` records, no day file.
          log_path:
            vault === null || isStoreOnly({ vault })
              ? NO_VAULT_LOG_PATH
              : join(brainDirsForWrite(vault).log, `${isoDate(now)}.md`),
        },
    scan,
    plan,
    refresh,
    reconcile,
    rollupPlan,
    salienceGate,
    intentReviews: intentReview.reviews,
    warnings,
    gatedRetires: exec.gatedRetires,
    gatedSlugs,
    moved: exec.moved,
    archived: exec.archived,
    healEnriched: exec.healEnriched,
    snapshotPath: snapshotPathStr,
  });
  return withRetireSiblings(summary, scan, plan, {
    enabled: opts.retireSiblingsEnabled,
    gatedRetires: exec.gatedRetires,
    // A dry run applies nothing, so it gates nothing; the preview asks the
    // same confirmed-evidence gate the apply step will.
    previewGateThreshold: dryRun ? cfg.retire.confirmed_evidence_min_threshold : undefined,
  });
}

/** What a no-vault run names as its log: the brain log is a store record stream. */
const NO_VAULT_LOG_PATH = "store:log";

function formatRunId(d: Date): string {
  // <reason>-YYYY-MM-DD-HHMMSS. The prefix is the snapshot-reason
  // constant rather than a literal, so the archive's filename and the
  // provenance stamped into its sidecar are one string.
  return `${BRAIN_SNAPSHOT_REASON.dream}-${compactRunStamp(d)}`;
}
