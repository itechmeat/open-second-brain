/**
 * The automatic store migration worker (change auto-store-migration,
 * design D3). One attempt, in whatever process calls it: the detached
 * `o2b brain migrate-store --auto <token>` worker that
 * `ensureVaultCurrent` starts, or the caller of `o2b update`, which runs
 * the same logic in the foreground with progress on stderr.
 *
 * The bar: after any failure, throw or kill at any point, the machine is
 * either fully on the legacy layout and writable, or brought to fully
 * switched by a later start. The rules, in order:
 *
 *  1. The opt-out (`auto_store_migration`, default on, failing closed:
 *     `config.ts`) is honoured: with it off the migration is offered where
 *     it is offered today and this worker writes nothing. A machine the
 *     operator rolled back is never migrated again on its own.
 *  2. A machine that is switched has nothing to migrate, but two things
 *     may be left to finish, and only those are done:
 *     - its own run stopped after the `device-switched` record (killed,
 *       or a step after it threw): the switch is finished through
 *       `migrateStore` (`finishInterruptedSwitch`: the switch marker, the
 *       vault binding, the view writer, the gate), unless a live run
 *       still holds the gate;
 *     - an automatic attempt switched it and did not write its success
 *       records (the record of the attempt is still there): they are
 *       written now.
 *     Anything else costs one small read and writes nothing.
 *  3. The per-vault, per-machine worker lock (`auto-state.ts`) decides
 *     which attempt runs.
 *  4. Before the attempt does anything, it records itself
 *     (`recordAutoMigrationAttempt`): a failure record carrying the
 *     cooldown a failure would start. Its real outcome replaces it. A
 *     killed attempt, or one that cannot write its outcome (a full disk),
 *     leaves it, so the next starts do not each spawn a worker; a kill
 *     that left the gate held is resumed at once regardless.
 *  5. Nothing is created before the cheap checks pass: the managed-file
 *     upgrade (skipped while a migration gate exists, whose writes it would
 *     refuse), the dry run (unmapped entries and unparseable items are
 *     refusals: the person decides with the manual command), the device
 *     id, a readable store that holds `shared`, the free disk, the gate of
 *     another migration. A store that cannot be read right now is a wait,
 *     not a failure.
 *  6. With no store yet, another device's migration of this vault that
 *     the synced Brain log shows (`auto-probe.ts`) is waited for instead
 *     of creating a second store; otherwise the store is initialised
 *     exactly as `o2b store init` does.
 *  7. The migration runs through `migrateStore`, always resuming. The
 *     migrator closes the gate, backs up with a verified restore, converts
 *     through the journal, verifies, and only then switches; a thrown
 *     failure reopens the gate in its own `finally`, a killed worker's
 *     gate is taken over by the next attempt's resume, and a failure after
 *     the switch record is finished by rule 2 at the next start.
 *  8. Outcome `waiting` records the waiting state and no cooldown.
 *  9. Success writes the one-time notice, then clears the attempt's
 *     record, then appends one metrics row and one brain log line.
 *
 * It never throws: every state, notice, row and log write is guarded, and
 * one guard around the whole attempt turns anything left into `failed`.
 */

import { resolveAppendShardId } from "../brain/ledger-shards.ts";
import { listMetrics } from "../brain/metrics.ts";
import { isoSecond } from "../brain/time.ts";
import { BRAIN_LOG_EVENT_KIND } from "../brain/types.ts";
import { runSelfHealUpgrade, SELF_HEAL_UPGRADE_OUTCOME } from "../maintenance/self-heal-upgrade.ts";
import {
  describeSelfHealUpgradeLock,
  readSelfHealUpgradeLock,
} from "../maintenance/self-heal-upgrade-state.ts";
import { describeImportCounts } from "../migration-gate.ts";
import { processDirsEnv } from "../platform-dirs.ts";
import {
  MIGRATE_STORE_COMMAND,
  MIGRATE_STORE_DRY_RUN_COMMAND,
  STORE_INIT_COMMAND,
  type MigrationAvailability,
} from "../store/migration-availability.ts";
import { LOG_EVENT_KIND } from "../store/constants.ts";
import { readPartition } from "../store/state-digest.ts";
import { inspectStore } from "../store/store-open.ts";
import {
  isPathInsideResolved,
  resolveConfiguredStoreRoot,
  storesStateDir,
  StoreRootInsideVaultError,
} from "../store/store-paths.ts";
import {
  otherDeviceMigrationMark,
  ownMigrationRunRead,
  type OwnMigrationRun,
  type OwnMigrationRunRead,
} from "./auto-probe.ts";
import type { GateDecision, GateNone } from "./gate-decision.ts";
import { refusalAsk, refusalReason } from "./auto-report.ts";
import {
  gatherGate,
  openableGateRun,
  stoppedGateOf,
  switchProvenRead,
  type GatheredGate,
} from "./gate-state.ts";
import {
  AutoMigrationClaimLostError,
  claimedWrites,
  type ClaimedWrites,
} from "./auto-claimed-writes.ts";
import {
  autoMigrationClaimOwnership,
  autoMigrationStatePath,
  claimAutoMigrationLock,
  handAutoMigrationLock,
  readAutoMigrationFailure,
  readAutoMigrationWaiting,
  AUTO_MIGRATION_LOCK_JUDGE,
  AUTO_MIGRATION_SELF_CLAIM,
  releaseAutoMigrationLock,
  reportableText,
  type AutoMigrationWaiting,
} from "./auto-state.ts";
import { readMigrationBackup } from "./backup.ts";
import { planMigrationDryRun } from "./dry-run.ts";
import {
  checkDisk,
  finishInterruptedSwitch,
  MigrationRefusedError,
  openMigrationStore,
  safeAgent,
  type MigrationHooks,
  type MigrationStep,
} from "./migrate.ts";
import { MigrationSwitchedError, migrateStore } from "./outcome.ts";
import { processStartIdentity } from "./process-identity.ts";
import { MigrationGateBusyError, releaseStoppedRunGate, stoppedRunGateRemains } from "./quiesce.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Metrics surface the worker's attempts go to, one row per attempt that moved or failed. */
export const AUTO_MIGRATION_SURFACE = "auto_store_migration";

/** How one automatic attempt ended. */
export const AUTO_MIGRATION_OUTCOME = Object.freeze({
  /** The migration finished and this machine switched (or its switch was finished). */
  applied: "applied",
  /** A later machine's store does not hold the first machine's cut yet, or no store arrived. */
  waiting: "waiting",
  /** Another attempt holds the worker lock, or a live migration the gate. */
  running: "running",
  /** The dry run or a preflight refused; the failure record names why. */
  refused: "refused",
  /** The run failed after starting; the failure record names why. */
  failed: "failed",
  /** The machine opted out. */
  disabled: "disabled",
  /** The operator rolled this machine back; it is not migrated again on its own. */
  rolledBack: "rolled_back",
  /** Nothing to migrate (no legacy data), or this machine already switched. */
  notNeeded: "not_needed",
} as const);

export type AutoMigrationOutcome =
  (typeof AUTO_MIGRATION_OUTCOME)[keyof typeof AUTO_MIGRATION_OUTCOME];

/** The worker's own step boundaries, beside the migrator's ({@link MigrationStep}). */
export const AUTO_MIGRATION_STEP = Object.freeze({
  /** Before the worker lock is claimed. */
  beforeLock: "before-lock",
  /** The worker lock is held. */
  lockClaimed: "lock-claimed",
  /** Right before the managed-file upgrade. */
  upgrade: "upgrade",
  /** Right before the dry run. */
  dryRun: "dry-run",
  /** The store exists (initialised now, or already there). */
  storeReady: "store-ready",
  /** Right before the success records are written. */
  successRecords: "success-records",
  /** After the notice, before the attempt's record is cleared. */
  noticeWritten: "notice-written",
} as const);

export type AutoMigrationStep = (typeof AUTO_MIGRATION_STEP)[keyof typeof AUTO_MIGRATION_STEP];

/**
 * Fault-injection points. An in-process option only: the CLI entry
 * (`--auto <token>`) never passes them, and no flag, environment variable
 * or config key reaches them, so a production run cannot set them. They
 * exist because the step boundaries they name cannot be reached from
 * outside a run that takes milliseconds; the crash tests kill their own
 * child process from inside one.
 */
export interface AutoMigrationHooks extends Omit<MigrationHooks, "atStep"> {
  readonly atStep?: (step: MigrationStep | AutoMigrationStep) => void;
}

export interface AutoMigrationRun {
  readonly outcome: AutoMigrationOutcome;
  /** The failure; set for `refused` and `failed`. */
  readonly error: string | null;
  /** The command an operator can run instead; set for `refused` and `failed`. */
  readonly manualCommand: string | null;
  /** What the store still lacks; set for `waiting`. */
  readonly wait: AutoMigrationWaiting | null;
  /** Items imported; set for `applied` when a migration ran. */
  readonly imported: number | null;
}

export interface RunAutoStoreMigrationOptions {
  readonly configPath?: string;
  /**
   * The lock claim a parent made and handed over (`--auto <token>`).
   * Absent, the attempt claims the lock itself.
   */
  readonly lockToken?: string;
  /** Clock for the lock, the cooldown and the records. Defaults to wall clock. */
  readonly now?: Date;
  /** One-line progress for a foreground caller's stderr. */
  readonly progress?: (line: string) => void;
  /** Fault-injection points; see {@link AutoMigrationHooks}. */
  readonly hooks?: AutoMigrationHooks;
  /**
   * The migration's settle wait after the gate closes, in ms (the
   * migrator's default when absent). An in-process option like `hooks`:
   * the CLI entry never passes it. Tests with no writer in flight shorten
   * it, as they do for the migrator itself.
   */
  readonly settleMs?: number;
  /**
   * Who runs the attempt: the worker a start spawned (`worker`, the
   * default when a claim is handed over: it decides again under its claim
   * exactly as its start decided, cooldown and remembered wait included),
   * or an explicit run in this process (`update`, the default otherwise:
   * `o2b update`, the foreground mode), which does not wait out either.
   */
  readonly asker?: "worker" | "update";
}

function run(
  outcome: AutoMigrationOutcome,
  extra: Partial<AutoMigrationRun> = {},
): AutoMigrationRun {
  return Object.freeze({
    outcome,
    error: null,
    manualCommand: null,
    wait: null,
    imported: null,
    ...extra,
  });
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Run `write`; a write that throws is reported as false and never escapes. */
function guarded(write: () => void): boolean {
  try {
    write();
    return true;
  } catch {
    return false;
  }
}

interface Attempt {
  readonly vault: string;
  readonly now: Date;
  readonly opts: RunAutoStoreMigrationOptions;
  readonly cfg: { configPath?: string };
  readonly progress: (line: string) => void;
  readonly started: number;
}

/**
 * One automatic migration attempt for `vault`. Never throws: it runs
 * where nothing is left to catch (a detached worker with its streams
 * ignored), and every way it can end is an outcome.
 */
export function runAutoStoreMigration(
  vault: string,
  opts: RunAutoStoreMigrationOptions = {},
): AutoMigrationRun {
  try {
    return start(vault, opts);
  } catch (err) {
    return run(AUTO_MIGRATION_OUTCOME.failed, {
      error: reportableText(messageOf(err)),
      manualCommand: MIGRATE_STORE_COMMAND,
    });
  }
}

function start(vault: string, given: RunAutoStoreMigrationOptions): AutoMigrationRun {
  // A worker started with no claim of its own claims the lock itself.
  const opts: RunAutoStoreMigrationOptions =
    given.lockToken === AUTO_MIGRATION_SELF_CLAIM
      ? Object.fromEntries(Object.entries(given).filter(([key]) => key !== "lockToken"))
      : given;
  const now = opts.now ?? new Date();
  if (opts.lockToken !== undefined) {
    // A claim handed to a worker process covers that whole process: it is
    // released when the process ends, however it ends short of a kill, and
    // only while it is still this claim. Registered first, so no early
    // return or throw below can leave it behind.
    const held = opts.lockToken;
    process.once("exit", () => releaseAutoMigrationLock(vault, held));
  }
  const a: Attempt = {
    vault,
    now,
    opts: { ...opts, asker: given.asker ?? (given.lockToken !== undefined ? "worker" : "update") },
    cfg: opts.configPath !== undefined ? { configPath: opts.configPath } : {},
    progress: opts.progress ?? (() => {}),
    started: performance.now(),
  };
  opts.hooks?.atStep?.(AUTO_MIGRATION_STEP.beforeLock);
  // The decision is the gate decision a start takes (`gate-decision.ts`),
  // with the holder judged exactly. Nothing to do: answered without the
  // claim. Anything to do: decided again under the claim, on the state as
  // it is then, and only that answer is acted on (another pass may have
  // finished, refused or reopened what this one saw while it waited).
  //
  // Before the claim the worker writes nothing (it has no writes to make:
  // they come with the claim, `auto-claimed-writes.ts`): an answer that
  // writes (a moot record to clear, a wait to remember) is decided again
  // and written under the claim.
  const first = gather(a);
  if (first.decision.act === "none") {
    const answer = answerWithoutClaim(a, first.decision.why, first.state.switched);
    if (answer !== null) return answer;
  }
  return withLock(a, (w, token) => act(a, gather(a), w, token));
}

function gather(a: Attempt): GatheredGate {
  return gatherGate({
    vault: a.vault,
    configPath: a.opts.configPath,
    asker: a.opts.asker ?? "worker",
    now: a.now,
  });
}

/** The run id of the stopped migration run's gate on this vault the state saw, or null. */
function stoppedGateRun(g: GatheredGate): string | null {
  const gate = g.state.gate;
  return stoppedGateOf(g) !== null && gate?.kind === "held" ? gate.runId : null;
}

/** How often a step that only counts on is reported again, in ms. */
const PROGRESS_REPEAT_MS = 30_000;

/**
 * The migrator's progress as the worker's lines: every new step at once,
 * the same step with new counts at most every {@link PROGRESS_REPEAT_MS}
 * (the import reports after every batch).
 */
function migratorProgress(
  line: (text: string) => void,
): (step: string, counts?: { readonly journaled: number; readonly planned: number }) => void {
  let last = "";
  let at = 0;
  return (step, counts) => {
    const t = performance.now();
    if (step === last && t - at < PROGRESS_REPEAT_MS) return;
    last = step;
    at = t;
    line(counts === undefined ? step : `${step}, ${describeImportCounts(counts)}`);
  };
}

/** Act on the decision taken under the claim. */
function act(a: Attempt, g: GatheredGate, w: ClaimedWrites, token: string): AutoMigrationRun {
  const d = g.decision;
  switch (d.act) {
    case "none":
      return answerNone(a, w, d.why, g.state.switched);
    case "open": {
      const answer = answerNone(a, w, d.why, g.state.switched);
      openStoppedGate(a, w, openableGateRun(g));
      return answer;
    }
    case "refuse":
      return refuseGate(a, g, w, d);
    case "finish":
      return switchedMachine(a, g, w);
    case "migrate":
      return legacyMachine(a, g, w, token);
    default:
      // A start's answers (spawn, gather) never reach a worker.
      return run(AUTO_MIGRATION_OUTCOME.running);
  }
}

/**
 * What the worker answers for the gate decision's "nothing" when the
 * answer writes nothing (reads only), or null when it writes: a moot
 * record to clear, a wait to remember. Safe before the claim.
 */
function answerWithoutClaim(a: Attempt, why: GateNone, switched: boolean): AutoMigrationRun | null {
  const outcome = noneOutcome(why);
  switch (why) {
    case "not-available":
    case "nothing-left":
      // Nothing to move, or nothing left to finish: a state record left
      // from before is moot, and clearing it is a write.
      return existsSync(autoMigrationStatePath(a.vault)) ? null : run(outcome);
    case "run-unreadable":
      // A switched machine's switch is not proven finished: whatever record
      // an attempt left stays as it is (pending), and nothing is written.
      return switched ? run(outcome) : null;
    case "switch-unproven":
      // Nothing will prove this switch on its own: the record stays for
      // the report, and the operator's run ends it.
      return run(outcome, { manualCommand: MIGRATE_STORE_COMMAND });
    case "waiting":
      return run(outcome, { wait: readAutoMigrationWaiting(a.vault) });
    case "backoff": {
      // The recorded failure's cooldown stands; nothing new is recorded.
      const failure = readAutoMigrationFailure(a.vault);
      return run(outcome, {
        error: failure?.error ?? null,
        manualCommand: failure?.manualCommand ?? MIGRATE_STORE_COMMAND,
      });
    }
    default:
      return run(outcome);
  }
}

/**
 * The outcome the worker answers for the gate decision's "nothing" (and
 * for "open", which opens the gate and answers its reason), so every
 * surface that restates it (`o2b update --dry-run`) says the same.
 */
export function noneOutcome(why: GateNone): AutoMigrationOutcome {
  switch (why) {
    case "disabled":
    case "skipped":
      return AUTO_MIGRATION_OUTCOME.disabled;
    case "not-available":
    case "nothing-left":
      return AUTO_MIGRATION_OUTCOME.notNeeded;
    case "rolled-back":
      return AUTO_MIGRATION_OUTCOME.rolledBack;
    case "run-unreadable":
    case "waiting":
      return AUTO_MIGRATION_OUTCOME.waiting;
    case "switch-unproven":
      return AUTO_MIGRATION_OUTCOME.refused;
    case "backoff":
      return AUTO_MIGRATION_OUTCOME.refused;
    case "running":
    case "other-vault-running":
      return AUTO_MIGRATION_OUTCOME.running;
  }
}

/** What the worker answers for the gate decision's "nothing", under its claim. */
function answerNone(
  a: Attempt,
  w: ClaimedWrites,
  why: GateNone,
  switched: boolean,
): AutoMigrationRun {
  const read = answerWithoutClaim(a, why, switched);
  if (read !== null) return read;
  if (why === "run-unreadable") {
    // The run could be one the operator rolled back: nothing is
    // migrated until it can be read.
    return wait(a, w, {
      missing: [],
      firstMachines: [],
      reason:
        "this machine's migration run state cannot be read right now, so the automatic " +
        "migration cannot tell whether a run was rolled back; it starts nothing until it can",
    });
  }
  // Nothing to move, or nothing left to finish: the record left is moot.
  guarded(() => w.clear());
  return run(AUTO_MIGRATION_OUTCOME.notNeeded);
}

/** Refuse: the gate is another command's, or another vault's ({@link GateRefusal}). */
function refuseGate(
  a: Attempt,
  g: GatheredGate,
  w: ClaimedWrites,
  d: Extract<GateDecision, { act: "refuse" }>,
): AutoMigrationRun {
  // An interrupted rollback or removal of this vault still holds the
  // gate, or a rollback of this vault began and did not finish: only its
  // own command finishes it. A migration over it would cut across it, so
  // the attempt refuses instead. The reason and the command are the ones
  // every surface names (`refusalReason`); a gate that is gone names no run.
  const gate = g.context.gate.kind === "held" ? ` (run ${g.context.gate.gate.run_id})` : "";
  const refusal = refusalReason(d);
  return recordFailure(
    a,
    w,
    `${refusal.text}${gate}; ${refusalAsk(refusal)}`,
    refusal.command,
    AUTO_MIGRATION_OUTCOME.refused,
  );
}

/**
 * Run `body` holding the worker lock (its claim `token`, and the writes
 * made under it), or answer `running`.
 */
function withLock(
  a: Attempt,
  body: (w: ClaimedWrites, token: string) => AutoMigrationRun,
): AutoMigrationRun {
  let token: string | null;
  if (a.opts.lockToken !== undefined) {
    // The worker stamps its own pid and start identity on the claim it was
    // handed, so the claim reads as live for exactly as long as this
    // process runs. A claim taken over meanwhile is no longer ours.
    // The stamp is also the worker's confirmation that it started: a claim
    // handed to a worker that never confirms it, and is gone, is recorded
    // as a failure by the start that spawned it, or by the next start.
    token = handAutoMigrationLock(
      a.vault,
      a.opts.lockToken,
      process.pid,
      processStartIdentity(process.pid),
      true,
    )
      ? a.opts.lockToken
      : null;
  } else {
    token = claimAutoMigrationLock(a.vault, a.now, { judge: AUTO_MIGRATION_LOCK_JUDGE.exact });
  }
  if (token === null) return run(AUTO_MIGRATION_OUTCOME.running);
  const claim = token;
  const held = (): AutoMigrationRun => {
    a.opts.hooks?.atStep?.(AUTO_MIGRATION_STEP.lockClaimed);
    return body(claimedWrites(a.vault, claim), claim);
  };
  // A handed claim is released when the process ends (see `start`).
  if (a.opts.lockToken !== undefined) return held();
  try {
    return held();
  } finally {
    releaseAutoMigrationLock(a.vault, token);
  }
}

// ----- A switched machine ---------------------------------------------------

/**
 * Finish what a switched machine has left (the gate decision's `finish`):
 * an interrupted switch, the success outputs of the automatic attempt
 * that switched it, a moot record; then a stopped migration run's gate of
 * this vault still left. Finishing asks no consent: the machine already
 * switched, and the opt-out only governs starting a migration.
 */
function switchedMachine(a: Attempt, g: GatheredGate, w: ClaimedWrites): AutoMigrationRun {
  try {
    return finishSwitched(a, g, w);
  } finally {
    openStoppedGate(a, w, stoppedGateRun(g));
  }
}

function finishSwitched(a: Attempt, g: GatheredGate, w: ClaimedWrites): AutoMigrationRun {
  const own = g.context.own;
  const interrupted = g.state.run?.phase === "in-progress";
  if (interrupted && own.kind === "run") {
    const finished = finishSwitch(a, own.run, w);
    if (finished !== null) return finished;
  }
  if (interrupted || g.state.record?.kind === "attempt") {
    // The switch was finished just now, or an automatic attempt switched
    // this machine and did not write all its success outputs: write the
    // ones it did not, once the switch is proven finished (`succeed`).
    const read = ownMigrationRunRead(a.opts.configPath);
    const fresh = read.kind === "run" ? read.run : null;
    const backup = fresh !== null ? readMigrationBackup(fresh.dir) : null;
    return succeed(
      a,
      w,
      {
        runId: fresh?.state.kind === "state" ? fresh.state.state.run_id : null,
        snapshot: backup?.snapshot ?? null,
        imported: null,
        device: resolveAppendShardId(),
      },
      { replay: true, proof: read },
    );
  }
  // A failure or waiting state of before the switch is moot now.
  guarded(() => w.clear());
  return run(AUTO_MIGRATION_OUTCOME.notNeeded);
}

/**
 * Finish this device's interrupted switch (`finishInterruptedSwitch`):
 * the vault that run migrated is bound, never a vault configured since,
 * whose own transition import is left to the manual command. Returns null
 * when the switch is finished, or the outcome to answer.
 */
function finishSwitch(a: Attempt, own: OwnMigrationRun, w: ClaimedWrites): AutoMigrationRun | null {
  a.progress("finishing the switch to the brain store");
  try {
    const store = openMigrationStore(a.vault, a.opts.configPath);
    finishInterruptedSwitch(a.vault, store, safeAgent(a.opts.configPath));
  } catch (err) {
    if (err instanceof MigrationGateBusyError) return run(AUTO_MIGRATION_OUTCOME.running);
    return recordFailure(
      a,
      w,
      messageOf(err),
      MIGRATE_STORE_COMMAND,
      AUTO_MIGRATION_OUTCOME.failed,
    );
  }
  // Only a run state read back as done proves the switch finished: one
  // that cannot be read, or is gone, says nothing, and the attempt stays
  // pending for the next start, which finishes or publishes at once.
  if (!switchProvenRead(ownMigrationRunRead(a.opts.configPath))) {
    return switchUnproven(
      a,
      w,
      `the switch of run ${own.state.kind === "state" ? own.state.state.run_id : "unknown"} ` +
        "to the brain store does not read back as finished",
    );
  }
  return null;
}

/**
 * The switch is not proven finished ({@link switchProvenRead}): nothing is
 * published, and the record stays an attempt's (pending, never a failure
 * a later start would only clear), so the next start finishes the switch
 * or writes the success outputs at once.
 */
function switchUnproven(a: Attempt, w: ClaimedWrites, reason: string): AutoMigrationRun {
  const text = reportableText(reason);
  guarded(() => w.unfinishedSwitch(text, a.now));
  return run(AUTO_MIGRATION_OUTCOME.failed, { error: text, manualCommand: MIGRATE_STORE_COMMAND });
}

// ----- A legacy machine -----------------------------------------------------

/** The raw state file, to put back when an attempt ends as `running`. */
function readRawState(vault: string): string | null {
  try {
    return readFileSync(autoMigrationStatePath(vault), "utf8");
  } catch {
    return null;
  }
}

function legacyMachine(
  a: Attempt,
  g: GatheredGate,
  w: ClaimedWrites,
  token: string,
): AutoMigrationRun {
  // A run of this machine stopped with the gate closed (its run still
  // `in-progress`, or killed before it put itself on record): the
  // migration below takes the gate over and goes on with it, and every way
  // this attempt ends before it gets there (a refusal of the dry run or a
  // preflight, a wait) opens that gate instead of leaving it closed. The
  // release leaves a live holder, another run and another vault alone.
  try {
    return attemptOnLegacy(a, g, w, token);
  } finally {
    openStoppedGate(a, w, stoppedGateRun(g));
  }
}

/**
 * Open the gate the stopped run `runId` left on this vault, or keep it
 * owed: when it is still there afterwards (the removal failed, the gate
 * lock was busy), the attempt's record is put back to an attempt's, so
 * the next start recovers it at once instead of honouring the opt-out or
 * a cooldown the outcome of this attempt would carry.
 */
function openStoppedGate(a: Attempt, w: ClaimedWrites, runId: string | null): void {
  if (runId === null) return;
  let reason = "the gate lock was busy";
  try {
    if (releaseStoppedRunGate(a.vault, runId)) {
      // A gate an earlier attempt owed is paid: its record is the failure.
      if (readAutoMigrationFailure(a.vault)?.gateOwed === runId) {
        guarded(() => w.settleGateOwed(runId));
      }
      return;
    }
  } catch (err) {
    reason = messageOf(err);
  }
  if (!guardedRead(() => stoppedRunGateRemains(a.vault, runId))) return;
  guarded(() => w.gateOwed(runId, reportableText(reason), a.now));
}

/** `read`, or true when it throws: a check that cannot be made keeps what is owed. */
function guardedRead(read: () => boolean): boolean {
  try {
    return read();
  } catch {
    return true;
  }
}

function attemptOnLegacy(
  a: Attempt,
  g: GatheredGate,
  w: ClaimedWrites,
  token: string,
): AutoMigrationRun {
  const { vault } = a;
  const hooks = a.opts.hooks;
  const availability = g.context.availability!;
  // Whether a gate (of a stopped run this attempt takes over) is there.
  const gate = g.context.gate;
  const before = readRawState(vault);
  try {
    w.attempt(a.now);
  } catch (err) {
    // Taken over before it began: the holder now does the work.
    if (err instanceof AutoMigrationClaimLostError) return run(AUTO_MIGRATION_OUTCOME.running);
    // The attempt cannot even record that it starts: it starts nothing.
    return run(AUTO_MIGRATION_OUTCOME.failed, {
      error: reportableText(`the automatic migration cannot record its attempt: ${messageOf(err)}`),
      manualCommand: MIGRATE_STORE_COMMAND,
    });
  }
  /** `running` after the attempt recorded itself: its record is taken back. */
  const notOurTurn = (): AutoMigrationRun => {
    // Under the claim only: a worker whose claim was taken over leaves the
    // new holder's record alone.
    guarded(() => w.restore(before));
    return run(AUTO_MIGRATION_OUTCOME.running);
  };
  try {
    // The managed-file upgrade runs first, through the upgrade worker's
    // own entry point and lock: the start that spawned this worker left it
    // here, because a second worker would race the migration into its
    // gate. While a gate exists (an interrupted run this attempt resumes)
    // it is skipped: the gate refuses its writes, and a switched machine
    // has no managed files to upgrade.
    if (gate.kind === "none") {
      a.progress("bringing the brain's managed files up to date");
      hooks?.atStep?.(AUTO_MIGRATION_STEP.upgrade);
      const upgrade = runSelfHealUpgrade(vault, { now: a.now, ...a.cfg });
      if (upgrade.outcome === SELF_HEAL_UPGRADE_OUTCOME.running) {
        // Only a live upgrade of this machine holds the migration off: its
        // lock sits in the vault's synced folder, and a claim another
        // machine made, or one an older release wrote without its machine
        // and process, says nothing of this one. The upgrade is then left
        // for a later start. What covers each upgrade that may still run:
        //  - one of this release asks the gate when its apply starts and
        //    again when its snapshot starts (`assertVaultIdentityForWrite`
        //    in `applyUpgrade` and `takeSnapshot`), not before each file
        //    write; its claim is a record of this machine's live process
        //    (`here`), so the migration waits for it and never overlaps it;
        //  - one of an older release knows no gate and may rewrite
        //    `Brain/_brain.yaml`, `Brain/_BRAIN.md` and a repaired
        //    preference after the snapshot: the ordinary legacy writer after
        //    the snapshot. The import passes run until one imports nothing,
        //    the settings are read from `_brain.yaml` at the switch,
        //    `_BRAIN.md` is a compiled page written again after it, and a
        //    preference written after the last pass is a late legacy write
        //    the transition import brings in after the switch.
        const holder = readSelfHealUpgradeLock(vault, a.now);
        if (holder.kind === "here") {
          a.progress(
            `the managed-file upgrade runs (${describeSelfHealUpgradeLock(holder)}); the ` +
              "migration is left to the next start",
          );
          return notOurTurn();
        }
        a.progress(
          `the managed-file upgrade is left for later (${describeSelfHealUpgradeLock(holder)}); ` +
            "the migration goes on",
        );
      }
    }
    // The dry run reads the legacy tree alone and writes nothing.
    a.progress("checking what a migration would move");
    hooks?.atStep?.(AUTO_MIGRATION_STEP.dryRun);
    const plan = planMigrationDryRun(vault);
    if (!plan.ok) {
      const listed = plan.unmapped
        .slice(0, 10)
        .map((u) => u.path)
        .join(", ");
      return recordFailure(
        a,
        w,
        `${plan.unmapped.length} legacy entr(ies) have no destination (${listed})`,
        MIGRATE_STORE_DRY_RUN_COMMAND,
        AUTO_MIGRATION_OUTCOME.refused,
      );
    }
    if (plan.totals.unparseable > 0) {
      // The real run would archive them into the backup only; nobody is
      // watching an automatic run, so the person decides.
      const listed = plan.unparseable
        .slice(0, 10)
        .map((u) => (u.line !== null ? `${u.path}:${u.line}` : u.path))
        .join(", ");
      return recordFailure(
        a,
        w,
        `${plan.totals.unparseable} legacy item(s) cannot be parsed (${listed}); a migration ` +
          "would keep them only in its backup archive, so the automatic migration leaves the " +
          "decision to you: fix them, or run the migration by hand to archive them",
        MIGRATE_STORE_DRY_RUN_COMMAND,
        AUTO_MIGRATION_OUTCOME.refused,
      );
    }
    const pre = preflight(
      a,
      w,
      availability,
      plan.surfaces.reduce((sum, s) => sum + s.bytes, 0),
    );
    if (pre !== null) return pre;
    if (availability.storeExists === false) {
      // A store another device created for this vault has not arrived:
      // wait for it instead of creating a second, diverging one.
      const scan = otherDeviceMigrationMark(vault, resolveAppendShardId());
      if (scan.mark === null && scan.incomplete !== null) {
        // A shard that may hold another device's mark could not be read:
        // creating a store now could make a second, diverging one. The
        // next start looks again (no day-long wait is remembered).
        return wait(a, w, {
          missing: [],
          firstMachines: [],
          reason:
            `${scan.incomplete}, so this machine cannot tell yet whether another device ` +
            "started migrating this vault; it creates no store until it can",
        });
      }
      const mark = scan.mark;
      if (mark !== null) {
        return wait(a, w, {
          missing: [],
          firstMachines: [mark.device],
          awaitsStore: true,
          reason:
            `device ${mark.device} started migrating this vault into its brain store, and that ` +
            "store has not arrived on this machine yet; this machine migrates as a later " +
            "machine once sync delivers it. If this machine is to share that store, set " +
            "auto_store_migration: false here until it arrives (or fix its sync); give this " +
            `machine a store of its own (\`${STORE_INIT_COMMAND}\`, then ` +
            `\`${MIGRATE_STORE_COMMAND}\`) only at a store root sync never brings together ` +
            "with that device's",
        });
      }
      // Created under the claim: a worker whose claim was taken over
      // creates nothing; the one that holds the claim now does the work.
      a.progress("creating the brain store");
      try {
        w.createStore(a.cfg);
      } catch (err) {
        if (err instanceof AutoMigrationClaimLostError) return notOurTurn();
        return recordFailure(
          a,
          w,
          messageOf(err),
          STORE_INIT_COMMAND,
          AUTO_MIGRATION_OUTCOME.refused,
        );
      }
    }
    hooks?.atStep?.(AUTO_MIGRATION_STEP.storeReady);
    // The migration itself runs inside the gate, which serialises it with
    // any other: a worker taken over by now stops before it starts one.
    if (autoMigrationClaimOwnership(vault, token) !== "owned") return notOurTurn();
    a.progress("running the migration");
    const outcome = migrateStore(vault, {
      resume: true,
      // A device switched meanwhile refuses: the transition import of this
      // vault is the operator's (`MigrationSwitchedError`, below).
      automatic: true,
      // Nobody watches an automatic run: an unparseable item conversion
      // meets is left to the person, as the dry run leaves it.
      refuseUnparseable: true,
      ...a.cfg,
      ...(hooks !== undefined ? { hooks } : {}),
      ...(a.opts.settleMs !== undefined ? { settleMs: a.opts.settleMs } : {}),
      onProgress: migratorProgress(a.progress),
    });
    if (outcome.mode === "waiting") {
      return wait(a, w, {
        missing: outcome.wait.missing,
        firstMachines: outcome.wait.firstMachines,
      });
    }
    if (outcome.mode === "migration" && outcome.ok) {
      return succeed(a, w, {
        runId: outcome.run_id,
        snapshot: outcome.backup?.snapshot ?? null,
        imported: outcome.imported,
        device: outcome.device,
      });
    }
    if (outcome.mode === "migration") {
      return recordFailure(
        a,
        w,
        `${outcome.gaps.length} legacy item(s) are not in the store`,
        MIGRATE_STORE_COMMAND,
        AUTO_MIGRATION_OUTCOME.failed,
      );
    }
    // A transition outcome: an automatic call never gets one (the migrator
    // refuses it, `MigrationSwitchedError` below); answered the same way.
    guarded(() => w.clear());
    return run(AUTO_MIGRATION_OUTCOME.notNeeded);
  } catch (err) {
    if (err instanceof MigrationSwitchedError) {
      // Another run switched this machine before this one started (a
      // manual run, or another vault's migration): nothing of this attempt
      // to announce, and this vault's transition import is the operator's.
      guarded(() => w.clear());
      return run(AUTO_MIGRATION_OUTCOME.notNeeded);
    }
    const after = ownMigrationRunRead(a.opts.configPath);
    if (after.kind === "run" && after.run.switched) {
      // The attempt switched this machine and failed after: its switch or
      // its success records are left for the next start, which finishes
      // them at once (`switchedMachine`), not after a cooldown. A release
      // of its gate that met a busy gate lock is one such end: the gate is
      // left closed, and the next start opens it and publishes. (An
      // automatic call never gets past a switch it did not make: it is
      // refused with `MigrationSwitchedError` above.)
      const text = reportableText(messageOf(err));
      guarded(() => w.unfinishedSwitch(text, a.now));
      recordRow(a, w, { outcome: AUTO_MIGRATION_OUTCOME.failed });
      return run(AUTO_MIGRATION_OUTCOME.failed, {
        error: text,
        manualCommand: MIGRATE_STORE_COMMAND,
      });
    }
    if (err instanceof MigrationGateBusyError) {
      // A live migration (this machine's manual run, or another attempt
      // that lost the race into the gate) holds the gate: not a failure.
      return notOurTurn();
    }
    return recordFailure(
      a,
      w,
      messageOf(err),
      MIGRATE_STORE_COMMAND,
      err instanceof MigrationRefusedError || err instanceof StoreRootInsideVaultError
        ? AUTO_MIGRATION_OUTCOME.refused
        : AUTO_MIGRATION_OUTCOME.failed,
    );
  }
}

/**
 * The cheap checks the migrator would refuse on, run before anything is
 * created (a store, a device binding, a view writer claim). Returns the
 * outcome to answer, or null when the attempt may go on.
 */
function preflight(
  a: Attempt,
  w: ClaimedWrites,
  availability: MigrationAvailability,
  bytes: number,
): AutoMigrationRun | null {
  const refuse = (reason: string, command: string = MIGRATE_STORE_COMMAND): AutoMigrationRun =>
    recordFailure(a, w, reason, command, AUTO_MIGRATION_OUTCOME.refused);
  let root: string;
  try {
    root = resolveConfiguredStoreRoot(a.opts.configPath).root;
  } catch (err) {
    return refuse(messageOf(err), STORE_INIT_COMMAND);
  }
  if (isPathInsideResolved(root, a.vault, process.platform)) {
    return refuse(
      `the brain store root ${root} is inside the vault ${a.vault}; set store_root to a ` +
        "folder outside it",
      STORE_INIT_COMMAND,
    );
  }
  if (availability.storeExists === null) {
    // A store that cannot be read right now (sync replacing it, a
    // permission being fixed) is a wait, not a failure with a cooldown.
    return wait(a, w, {
      missing: [],
      firstMachines: [],
      reason: `the brain store cannot be read right now (${availability.error ?? "unknown"})`,
    });
  }
  if (resolveAppendShardId() === "") {
    return refuse(
      "this machine has no device id; set device_id in the machine config or O2B_DEVICE_ID",
    );
  }
  if (availability.storeExists) {
    let store: ReturnType<typeof inspectStore>;
    try {
      store = inspectStore(root);
    } catch (err) {
      // Readable a moment ago (sync replacing its metadata now): the same
      // wait as a store that could not be read at the first look.
      return wait(a, w, {
        missing: [],
        firstMachines: [],
        reason: `the brain store cannot be read right now (${messageOf(err)})`,
      });
    }
    if (store !== null && !store.partitions.has("shared")) {
      return refuse("this machine does not hold the shared partition of the store");
    }
  }
  try {
    checkDisk(storesStateDir(processDirsEnv()), bytes);
  } catch (err) {
    return refuse(messageOf(err));
  }
  return null;
}

// ----- Outcomes -------------------------------------------------------------

function wait(
  a: Attempt,
  writes: ClaimedWrites,
  w: {
    missing: ReadonlyArray<string>;
    firstMachines: ReadonlyArray<string>;
    reason?: string;
    awaitsStore?: boolean;
  },
): AutoMigrationRun {
  let recorded: AutoMigrationWaiting | null = null;
  guarded(() => {
    recorded = writes.waiting(w, a.now);
  });
  recordRow(a, writes, { outcome: AUTO_MIGRATION_OUTCOME.waiting });
  return run(AUTO_MIGRATION_OUTCOME.waiting, {
    wait: recorded ?? readAutoMigrationWaiting(a.vault),
  });
}

function succeed(
  a: Attempt,
  w: ClaimedWrites,
  info: {
    runId: string | null;
    snapshot: string | null;
    imported: number | null;
    device: string;
  },
  opts: { replay?: boolean; proof?: OwnMigrationRunRead } = {},
): AutoMigrationRun {
  // Every success output depends on one predicate: the switch proven
  // finished, on the read the caller's facts came from (or a fresh one).
  if (!switchProvenRead(opts.proof ?? ownMigrationRunRead(a.opts.configPath))) {
    return switchUnproven(
      a,
      w,
      "this machine's migration run state does not read back as done after the switch",
    );
  }
  a.opts.hooks?.atStep?.(AUTO_MIGRATION_STEP.successRecords);
  // Each output (the metrics row, the brain log line, the notice) is
  // marked on the attempt's record right after it is written, and a pass
  // that finishes the attempt later writes only the unmarked ones: one
  // that failed is retried on its own, none is written twice. A pass that
  // finishes an earlier one also looks for the row and the log line of
  // the run before it writes them, which covers a stop between an output
  // and its mark. The record is cleared once all three are written.
  const done = readAutoMigrationFailure(a.vault)?.written ?? {
    row: false,
    log: false,
    notice: false,
  };
  const replay = opts.replay === true && info.runId !== null;
  const step = (output: "row" | "log" | "notice", write: () => boolean): boolean => {
    if (done[output]) return true;
    if (!write()) return false;
    guarded(() => w.markWritten(output));
    return true;
  };
  const row = step("row", () => {
    if (replay && rowWritten(a, info.runId!)) return true;
    return recordRow(a, w, {
      outcome: AUTO_MIGRATION_OUTCOME.applied,
      ...(info.runId !== null ? { run_id: info.runId } : {}),
      ...(info.imported !== null ? { imported: info.imported } : {}),
    });
  });
  const log = step("log", () => {
    if (replay && logLineWritten(a, info.runId!)) return true;
    const agent = safeAgent(a.opts.configPath);
    // The log line lands in the store's `shared` partition once the
    // machine switched, which every machine receives: it names the run,
    // the device and the snapshot, never a local path.
    return guarded(() =>
      w.logEvent({
        timestamp: isoSecond(a.now),
        eventType: BRAIN_LOG_EVENT_KIND.storeMigrationDone,
        agent,
        body: {
          ...(info.runId !== null ? { run_id: info.runId } : {}),
          ...(info.snapshot !== null ? { snapshot: info.snapshot } : {}),
          ...(info.imported !== null ? { imported: String(info.imported) } : {}),
          device: info.device,
          agent,
        },
      }),
    );
  });
  const notice = step("notice", () =>
    guarded(() => w.notice({ snapshot: info.snapshot, runId: info.runId }, a.now)),
  );
  if (notice) a.opts.hooks?.atStep?.(AUTO_MIGRATION_STEP.noticeWritten);
  if (row && log && notice && guarded(() => w.clear())) {
    guarded(() => w.dropShownNotice());
  }
  a.progress("the brain moved to the brain store");
  return run(AUTO_MIGRATION_OUTCOME.applied, { imported: info.imported });
}

/** Whether the metrics row of the run `runId`'s success is there already. */
function rowWritten(a: Attempt, runId: string): boolean {
  try {
    return listMetrics(a.vault, { surface: AUTO_MIGRATION_SURFACE }).some(
      (r) =>
        r.payload["outcome"] === AUTO_MIGRATION_OUTCOME.applied && r.payload["run_id"] === runId,
    );
  } catch {
    return false;
  }
}

/** Whether the brain log line of the run `runId`'s success is in the store already. */
function logLineWritten(a: Attempt, runId: string): boolean {
  try {
    const root = resolveConfiguredStoreRoot(a.opts.configPath).root;
    return readPartition(join(root, "shared")).some((shard) =>
      shard.all.some((r) => {
        if (r.kind !== LOG_EVENT_KIND) return false;
        if (r.body["event_type"] !== BRAIN_LOG_EVENT_KIND.storeMigrationDone) return false;
        const body = r.body["body"];
        return (
          typeof body === "object" &&
          body !== null &&
          (body as Record<string, unknown>)["run_id"] === runId
        );
      }),
    );
  } catch {
    return false;
  }
}

function recordFailure(
  a: Attempt,
  w: ClaimedWrites,
  error: string,
  manualCommand: string,
  outcome: AutoMigrationOutcome,
): AutoMigrationRun {
  const text = reportableText(error);
  let consecutive: number | null = null;
  // When the record cannot be written, the attempt's own record (written
  // when it started, with this cooldown) stays and holds the next starts off.
  guarded(() => {
    consecutive = w.failure(text, { manualCommand, now: a.now }).consecutiveFailures;
  });
  recordRow(a, w, {
    outcome,
    ...(consecutive !== null && consecutive > 1 ? { consecutive_failures: consecutive } : {}),
  });
  return run(outcome, { error: text, manualCommand });
}

function recordRow(a: Attempt, w: ClaimedWrites, payload: Record<string, unknown>): boolean {
  return guarded(() =>
    w.metric({
      surface: AUTO_MIGRATION_SURFACE,
      runAt: isoSecond(a.now),
      payload: { duration_ms: Math.round(performance.now() - a.started), ...payload },
    }),
  );
}
