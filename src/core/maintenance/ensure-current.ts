/**
 * Hands-off post-upgrade maintenance. After the plugin is updated, the on-disk
 * state of an already-initialised vault can lag the running version and would
 * otherwise need manual commands (`o2b search reindex`, `o2b brain upgrade`).
 * `ensureVaultCurrent` brings it current automatically and is safe to call on
 * every startup: it NEVER throws, and in `background` mode never blocks the
 * caller on a slow reindex.
 *
 * It is STATE-DRIVEN, not version-stamped: each step keys off actual on-disk
 * state (search index `schema_version` and `chunker_version`, `_brain.yaml`
 * pending-changes plan). This is deliberate - the vault is often synced
 * across devices (e.g. Syncthing), so a stamp written into the vault would
 * let one device mark a migration done and make another skip its own
 * per-device work (the search index is per-device). The two index cells are
 * not such a stamp: they live in the per-device index and describe what it
 * holds. State checks are cheap reads and also handle interrupted
 * migrations and downgrades correctly.
 */
import { maintainDreamOwner } from "../brain/dream-owner/gate.ts";
import { isPathInsideResolved } from "../store/store-paths.ts";
import { existsSync, mkdirSync } from "node:fs";
import { beginWorkerLogAttempt, workerLogAttemptHeader } from "../store-migration/worker-log.ts";
import { dirname } from "node:path";
import {
  MigrationInProgressError,
  migrationGateRefuses,
  withGateJudge,
} from "../migration-gate.ts";
import { Database } from "bun:sqlite";

import { defaultConfigPath } from "../config.ts";
import { o2bCommand, spawnSelfDetached } from "./o2b-command.ts";
import { brainConfigPath } from "../brain/paths.ts";
import { resolveSearchConfig } from "../search/index.ts";
import { healIndex, owesRepairBeyondUpgrade, planIndexRepair } from "../search/self-heal.ts";
import { LAST_INDEXED_AT_STATE_KEY } from "../search/store/state.ts";
import { maybeFreshenIndex, type FreshenDecision } from "../search/freshen.ts";
import { isWriterLockHeld } from "../search/store/writer-lock.ts";
import {
  mintSelfHealRunId,
  recordSelfHealSpawn,
  SELF_HEAL_SPAWN,
  type SelfHealSpawnDecision,
} from "./self-heal-reindex.ts";
import { closeDatabase } from "../sqlite-close.ts";
import {
  runSelfHealUpgrade,
  SELF_HEAL_UPGRADE_OUTCOME,
  type SelfHealUpgradeOutcome,
} from "./self-heal-upgrade.ts";
import {
  claimSelfHealUpgradeLock,
  readSelfHealUpgradeFailure,
  releaseSelfHealUpgradeLock,
  selfHealUpgradeBackoffActive,
} from "./self-heal-upgrade-state.ts";
import { configuredStore } from "../store/read/store-entities.ts";
import { storeOnlyMode } from "../store/store-only.ts";
import {
  AUTO_MIGRATION_SELF_CLAIM,
  autoMigrationClaimUndecided,
  AUTO_MIGRATION_LOCK_JUDGE,
  autoMigrationWorkerLogPath,
  claimAutoMigrationLock,
  claimMutexBudgetMs,
  handAutoMigrationLock,
  type LostAutoMigrationWorker,
  recordAutoMigrationSpawnFailure,
  recordLostAutoMigrationWorker,
  releaseAutoMigrationLock,
  settleExitedAutoMigrationWorker,
  underOwnAutoMigrationClaim,
} from "../store-migration/auto-state.ts";
import type { GateNone } from "../store-migration/gate-decision.ts";
import { gatherGate } from "../store-migration/gate-state.ts";
import { runAutoStoreMigration } from "../store-migration/auto-worker.ts";
import { startAutoLegacyRemoval } from "../store-migration/auto-removal.ts";

/**
 * The flag that tells the child to record its own terminal outcome. It
 * takes the run id this run's rows pair on, so the child never has to
 * invent one the parent could not have written.
 */
const SELF_HEAL_FLAG = "--self-heal";

/**
 * The flag that tells `o2b brain migrate-store` to run as the automatic
 * migration worker, with the lock claim it was handed.
 */
const AUTO_MIGRATION_FLAG = "--auto";

/**
 * What a background run did about the Brain managed-file upgrade. The
 * worker's own outcome is recorded by the worker; see
 * `self-heal-upgrade.ts`.
 */
export const SELF_HEAL_UPGRADE_SPAWN = Object.freeze({
  /** A detached `o2b brain upgrade --self-heal` worker was started. */
  spawned: "spawned",
  /** A recorded failure's cooldown has not run out; nothing was started. */
  skippedBackoff: "skipped_backoff",
  /** Another worker holds this vault's lock; nothing was started. */
  skippedRunning: "skipped_running",
  /**
   * A migration of this vault holds the gate (running or stopped): nothing
   * was claimed or started, since the lock lives in the state it moves.
   */
  skippedMigrationGate: "skipped_migration_gate",
} as const);

export type SelfHealUpgradeSpawnDecision =
  (typeof SELF_HEAL_UPGRADE_SPAWN)[keyof typeof SELF_HEAL_UPGRADE_SPAWN];

/**
 * What a start did about a pending store migration (change
 * auto-store-migration, decision D1). The worker's own outcome is
 * recorded by the worker; the foreground mode runs the same worker logic
 * in this process and answers {@link AUTO_MIGRATION_SPAWN.foreground}.
 */
export const AUTO_MIGRATION_SPAWN = Object.freeze({
  /** A detached `o2b brain migrate-store --auto` worker was started. */
  spawned: "spawned",
  /** A recorded failure's cooldown has not run out; nothing was started. */
  skippedBackoff: "skipped_backoff",
  /** Another worker holds this vault's lock; nothing was started. */
  skippedRunning: "skipped_running",
  /**
   * The worker an earlier start spawned exited before it confirmed its
   * claim (it could not run): this start recorded that as a failed
   * attempt, which starts its cooldown, and started nothing.
   */
  workerLost: "worker_lost",
  /**
   * A live migration of ANOTHER vault holds this machine's gate: no
   * migration of this vault starts while it runs, and nothing of this
   * vault's is held back by it (its managed-file upgrade runs).
   */
  otherVaultRunning: "other_vault_running",
  /** The machine opted out; nothing was started. */
  disabled: "disabled",
  /** The migration probe found nothing to move. */
  notAvailable: "not_available",
  /** The operator rolled this machine back; it is not migrated again on its own. */
  rolledBack: "rolled_back",
  /**
   * This machine's migration run state cannot be read: nothing is
   * migrated until it can, and no worker runs, so the managed-file
   * upgrade is this start's.
   */
  runUnreadable: "run_unreadable",
  /**
   * This machine switched and its migration run state reads absent or
   * failed: the switch can never be proven finished on its own, so no
   * worker is started for it (`o2b brain migrate-store` ends the record).
   */
  switchUnproven: "switch_unproven",
  /**
   * A later machine waits for a store another device created to arrive by
   * sync (remembered by its last worker); nothing was started.
   */
  waiting: "waiting",
  /** The foreground mode ran the worker logic in this process. */
  foreground: "foreground",
} as const);

export type AutoMigrationSpawnDecision =
  (typeof AUTO_MIGRATION_SPAWN)[keyof typeof AUTO_MIGRATION_SPAWN];

export interface EnsureCurrentResult {
  /**
   * Vault-relative paths of Brain managed files migrated this run. Always
   * empty in `background` mode: the upgrade runs in a detached worker.
   */
  readonly brainUpgraded: ReadonlyArray<string>;
  /**
   * In `background` mode, what was done about the managed-file upgrade;
   * `null` in the foreground, where {@link brainUpgradeOutcome} answers,
   * when the vault was removed before a worker could be started, and when
   * the automatic store migration's worker was started or is running: that
   * worker runs the upgrade itself before it migrates.
   */
  readonly brainUpgradeSpawn: SelfHealUpgradeSpawnDecision | null;
  /** In the foreground, how the upgrade attempt ended; `null` in `background` mode. */
  readonly brainUpgradeOutcome: SelfHealUpgradeOutcome | null;
  /**
   * What was done about a pending store migration. `null` when the step
   * did not run at all: an uninitialised vault, or a store-only machine
   * (switched, or no legacy tree), where the migration is either moot or
   * the transition import's job.
   */
  readonly migrationSpawn: AutoMigrationSpawnDecision | null;
  /** A search reindex was started (background) or completed (foreground). */
  readonly reindexTriggered: boolean;
  /**
   * In the foreground, the index was on an older schema and was migrated
   * in place, keeping its stored embeddings, so no reindex was needed.
   */
  readonly indexUpgraded: boolean;
  /**
   * In `background` mode, what was done about a reindex this run found
   * necessary. `null` when none was needed, or when the run was in the
   * foreground and there was no child to decide about.
   */
  readonly reindexSpawn: SelfHealSpawnDecision | null;
  /**
   * Freshen on read at session start: whether a current index that has
   * gone stale got a background incremental run, or why not. Null when the
   * index needed a rebuild (self-heal owns it) or was not looked at.
   */
  readonly freshen: FreshenDecision | null;
  /** Non-empty when nothing ran, e.g. "not-initialized". */
  readonly skipped: string;
  /** Best-effort: per-step failures, never thrown. */
  readonly errors: ReadonlyArray<string>;
}

export interface EnsureCurrentOptions {
  /** When true (default for startup), a needed reindex runs detached and the
   * call returns immediately. When false, the reindex is awaited (used by
   * tests and explicit callers). */
  readonly background?: boolean;
  /** Plugin config path to resolve search settings from. Defaults to
   * `defaultConfigPath()`. Threading this ensures the index that is checked and
   * (re)built matches the one the caller's server actually uses, e.g. under
   * `o2b mcp --config <custom>`. */
  readonly configPath?: string;
  /** Test seam: replaces the detached spawn of a freshen-on-read run. */
  readonly freshenSpawn?: (argv: string[]) => void;
}

function message(e: unknown): string {
  return e instanceof Error ? (e.message ?? String(e)) : String(e);
}

/** The index's `last_indexed_at`, or null when it cannot be read. */
function readLastIndexedAt(dbPath: string): string | null {
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }
  try {
    return (
      db
        .query<{ value: string }, [string]>("SELECT value FROM index_state WHERE key = ? LIMIT 1")
        .get(LAST_INDEXED_AT_STATE_KEY)?.value ?? null
    );
  } catch {
    return null;
  } finally {
    closeDatabase(db);
  }
}

/**
 * Start the managed-file upgrade in a detached worker, unless a recorded
 * failure is cooling down or another worker has the vault.
 *
 * The lock is CLAIMED here, before the spawn, and the claim token handed
 * to the worker, which releases it when it ends: N sessions starting at
 * once make N exclusive creates, and only the one that wins spawns. The
 * worker plans on its own (planning alone reads every preference file,
 * hundreds of milliseconds on a large vault), so nothing here reads more
 * than the failure marker.
 *
 * Streams are ignored and the child is `unref`ed, as for the reindex; its
 * outcome goes to the failure marker and the `self_heal_upgrade` metrics
 * surface.
 */
function startSelfHealUpgrade(
  vault: string,
  configPath: string | undefined,
  now: Date,
): SelfHealUpgradeSpawnDecision | null {
  // The claim creates the lock's directory; a vault removed since the
  // caller's check is left alone and nothing is started.
  if (!existsSync(brainConfigPath(vault))) return null;
  if (migrationGateRefuses(vault)) return SELF_HEAL_UPGRADE_SPAWN.skippedMigrationGate;
  if (selfHealUpgradeBackoffActive(readSelfHealUpgradeFailure(vault), now)) {
    return SELF_HEAL_UPGRADE_SPAWN.skippedBackoff;
  }
  let token: string | null;
  try {
    // Claimed for the worker spawned below, which stamps its own pid.
    token = claimSelfHealUpgradeLock(vault, now, { handed: true });
  } catch (e) {
    // The gate closed after the check above: nothing claimed, nothing started.
    if (e instanceof MigrationInProgressError) return SELF_HEAL_UPGRADE_SPAWN.skippedMigrationGate;
    throw e;
  }
  if (token === null) return SELF_HEAL_UPGRADE_SPAWN.skippedRunning;
  try {
    // The live environment (`spawnSelfDetached`); the config path
    // travels the way every brain verb reads it.
    spawnSelfDetached(
      [...o2bCommand(), "brain", "upgrade", "--vault", vault, SELF_HEAL_FLAG, token],
      {
        env: {
          ...process.env,
          ...(configPath !== undefined ? { OPEN_SECOND_BRAIN_CONFIG: configPath } : {}),
        },
      },
    );
  } catch (e) {
    // Nothing was started, so nothing else will release the claim.
    releaseSelfHealUpgradeLock(vault, token);
    throw e;
  }
  return SELF_HEAL_UPGRADE_SPAWN.spawned;
}

/**
 * Start the automatic store migration in a detached worker, unless the
 * machine opted out, a recorded failure is cooling down, or another
 * worker has the vault (change auto-store-migration, decision D1).
 *
 * The probe is `migrationAvailability()`, the same read the doctor and
 * the status block pay: one directory walk of the legacy tree, the store
 * identity files, and this device's own `settings` shards. When nothing
 * is to do it is the whole cost of the step - no lock is claimed, no
 * directory is created, and a hung or slow worker can never delay the
 * start, because nothing here waits for one: the claim is an exclusive
 * create, the child is detached with its streams ignored, and the claim
 * is released by the worker when it ends, on the self-heal upgrade
 * worker's pattern (`self-heal-upgrade.ts`).
 */
function startAutoMigration(
  vault: string,
  configPath: string | undefined,
  now: Date,
): AutoMigrationSpawnDecision {
  const plan = planLegacyStart(vault, configPath, now);
  return plan === AUTO_MIGRATION_START ? spawnAutoMigrationWorker(vault, configPath, now) : plan;
}

/** What {@link planAutoMigrationStart} answers when a worker is to be started. */
export const AUTO_MIGRATION_START = "start";

/**
 * What a start decides about the automatic store migration, without
 * spawning anything: {@link AUTO_MIGRATION_START} when a worker is to run,
 * the decision that starts nothing otherwise, or null on a switched
 * machine with nothing left to finish. `switched` is the start's own
 * store-only answer (`device-switched`). The decision is `decideGate`'s
 * (`gate-decision.ts`), the one the worker takes again under its claim;
 * the start gathers its state cheaply (the pid alone, never an identity
 * query; the legacy tree walk only when the cheap reads do not decide).
 * Exported so a test can follow exactly what a start would do and run the
 * worker in its own process.
 */
export function planAutoMigrationStart(
  vault: string,
  configPath: string | undefined,
  now: Date,
  switched: boolean,
): AutoMigrationSpawnDecision | typeof AUTO_MIGRATION_START | null {
  const { decision } = gatherGate({ vault, configPath, asker: "start", now, switched });
  if (decision.act === "spawn") return AUTO_MIGRATION_START;
  if (decision.act !== "none") {
    // The start's decision is only ever spawn or none (or gather, which
    // the gatherer resolves): anything else is a defect, met safely.
    return AUTO_MIGRATION_SPAWN.skippedRunning;
  }
  return startDecisionOf(decision.why);
}

/** What a start reports for the gate decision's "nothing" (null: nothing left, nothing said). */
export function startDecisionOf(why: GateNone): AutoMigrationSpawnDecision | null {
  switch (why) {
    case "nothing-left":
      return null;
    case "disabled":
    case "skipped":
      return AUTO_MIGRATION_SPAWN.disabled;
    case "not-available":
      return AUTO_MIGRATION_SPAWN.notAvailable;
    case "rolled-back":
      return AUTO_MIGRATION_SPAWN.rolledBack;
    case "waiting":
      return AUTO_MIGRATION_SPAWN.waiting;
    case "backoff":
      return AUTO_MIGRATION_SPAWN.skippedBackoff;
    case "other-vault-running":
      return AUTO_MIGRATION_SPAWN.otherVaultRunning;
    case "run-unreadable":
      return AUTO_MIGRATION_SPAWN.runUnreadable;
    case "switch-unproven":
      return AUTO_MIGRATION_SPAWN.switchUnproven;
    case "running":
      return AUTO_MIGRATION_SPAWN.skippedRunning;
  }
}

/**
 * Whether a start's migration answer leaves the managed-file upgrade to a
 * migration worker: one it just started, or one that runs (its gate
 * refuses the upgrade's writes). Every other answer starts no worker, so
 * the start runs the upgrade itself.
 */
/**
 * Whether an index at `dbPath` would be built into `vault` itself: the
 * legacy device-local folder, where a machine keeps it until it switches to
 * the brain store. A switched machine's index lives in device-local state
 * outside the vault, and is never skipped for this.
 */
export function rebuildsIntoLegacyFolder(vault: string, dbPath: string): boolean {
  return isPathInsideResolved(dbPath, vault, process.platform);
}

export function migrationOwnsUpgrade(spawn: AutoMigrationSpawnDecision | null): boolean {
  return spawn === AUTO_MIGRATION_SPAWN.spawned || spawn === AUTO_MIGRATION_SPAWN.skippedRunning;
}

function planLegacyStart(
  vault: string,
  configPath: string | undefined,
  now: Date,
): AutoMigrationSpawnDecision | typeof AUTO_MIGRATION_START {
  return planAutoMigrationStart(vault, configPath, now, false) ?? AUTO_MIGRATION_SPAWN.notAvailable;
}

/**
 * On a switched machine: whether the automatic path has something left to
 * finish (change auto-store-migration). Its own run stopped after the
 * `device-switched` record, an automatic attempt switched it without
 * writing its success records (or left a state record now moot), or a
 * stopped run's gate is left on this vault. The cost when nothing is left
 * is the store's identity files, one small JSON file, one `stat` and the
 * gate file: no lock, no directory, no process.
 */
function startSwitchFinish(
  vault: string,
  configPath: string | undefined,
  now: Date,
): AutoMigrationSpawnDecision | null {
  const plan = planAutoMigrationStart(vault, configPath, now, true);
  return plan === AUTO_MIGRATION_START ? spawnAutoMigrationWorker(vault, configPath, now) : plan;
}

function spawnAutoMigrationWorker(
  vault: string,
  configPath: string | undefined,
  now: Date,
): AutoMigrationSpawnDecision {
  // Judged without an identity query: a start never waits on a subprocess.
  let lost: LostAutoMigrationWorker | null = null;
  const token = claimAutoMigrationLock(vault, now, {
    judge: AUTO_MIGRATION_LOCK_JUDGE.cheap,
    onLostWorker: (worker) => {
      lost = worker;
    },
  });
  if (token === null) {
    // A live pid holds the claim, older than a running worker is trusted
    // for: hung, or a later process that reuses the pid. Only an identity
    // query tells, which a start never runs: a worker that claims with the
    // exact judge decides (and answers that it is not its turn when the
    // holder still runs).
    if (!autoMigrationClaimUndecided(vault, now)) return AUTO_MIGRATION_SPAWN.skippedRunning;
    spawnWorker(vault, configPath, AUTO_MIGRATION_SELF_CLAIM);
    return AUTO_MIGRATION_SPAWN.spawned;
  }
  const lostWorker: LostAutoMigrationWorker | null = lost;
  if (lostWorker !== null) {
    // The worker an earlier start handed this claim to never confirmed it:
    // it could not run. Recorded as a failed attempt under this claim (its
    // cooldown holds the next starts off), and nothing is started now.
    try {
      underOwnAutoMigrationClaim(
        vault,
        token,
        () => recordLostAutoMigrationWorker(vault, lostWorker, now),
        claimMutexBudgetMs(AUTO_MIGRATION_LOCK_JUDGE.cheap),
      );
    } finally {
      releaseAutoMigrationLock(vault, token);
    }
    return AUTO_MIGRATION_SPAWN.workerLost;
  }
  startOnClaim({
    start: () => {
      const proc = spawnWorker(vault, configPath, token);
      watchWorker(vault, token, proc);
      return proc.pid;
    },
    // The claim now names the worker, so it stays live after this start's
    // process ends and goes stale the moment the worker is gone. Its start
    // identity is the worker's to stamp: reading it here could cost an
    // external query (Windows) on the start's path.
    handOver: (pid) => void handAutoMigrationLock(vault, token, pid, null),
    release: () => releaseAutoMigrationLock(vault, token),
    failed: (e) =>
      underOwnAutoMigrationClaim(
        vault,
        token,
        () => recordAutoMigrationSpawnFailure(vault, message(e), now),
        claimMutexBudgetMs(AUTO_MIGRATION_LOCK_JUDGE.cheap),
      ),
  });
  return AUTO_MIGRATION_SPAWN.spawned;
}

/**
 * While this process lives, watch the worker it spawned: when it exits
 * before it confirmed its claim, its failure is recorded at once (with its
 * exit and its error output) instead of at the next start. The watch never
 * keeps this process alive and never waits for the claim's mutex; a start
 * that ends first leaves the record to the next start.
 */
function watchWorker(vault: string, token: string, proc: ReturnType<typeof Bun.spawn>): void {
  const pid = proc.pid;
  void proc.exited.then(
    (code) => {
      const exit =
        proc.signalCode !== null && proc.signalCode !== undefined
          ? `signal ${proc.signalCode}`
          : `exit code ${code}`;
      settleExitedAutoMigrationWorker(vault, token, pid, exit);
    },
    () => {},
  );
}

/**
 * Start a worker on a claim this start made: the claim is released only
 * when no worker started (`start` threw). Once a worker runs, the claim is
 * left for it whatever happens next: a hand-over that fails (a write that
 * fails) leaves the claim under this start's name and the worker's token,
 * which the worker stamps with its own pid when it begins; releasing it
 * here could remove the claim the worker already stamped, and a later
 * start would spawn a second worker beside it.
 */
export function startOnClaim(steps: {
  readonly start: () => number;
  readonly handOver: (pid: number) => void;
  readonly release: () => void;
  /** Records why no worker could be started, under the claim, before it is released. */
  readonly failed?: (e: unknown) => void;
}): void {
  let pid: number;
  try {
    pid = steps.start();
  } catch (e) {
    try {
      steps.failed?.(e);
    } catch {
      // The record is best effort; the error still reaches the caller.
    }
    // Nothing was started, so nothing else will release the claim.
    steps.release();
    throw e;
  }
  try {
    steps.handOver(pid);
  } catch {
    // The worker started: it holds the claim through its token.
  }
}

/** Start the detached worker for `vault` on the claim `token` (or its own). */
function spawnWorker(
  vault: string,
  configPath: string | undefined,
  token: string,
): ReturnType<typeof Bun.spawn> {
  // The live environment (`spawnSelfDetached`); the config path travels
  // the way every brain verb reads it. The worker's error output goes to a
  // small device-local log that a failure names. Each spawn opens a new
  // attempt in it and keeps the last few before it (`worker-log.ts`): a
  // worker started after a killed one keeps what the killed run wrote.
  const log = autoMigrationWorkerLogPath(vault);
  try {
    mkdirSync(dirname(log), { recursive: true });
  } catch {
    // the spawn's own open says so
  }
  beginWorkerLogAttempt(
    log,
    workerLogAttemptHeader(new Date(), `started by process ${process.pid}`),
  );
  return spawnSelfDetached(
    [...o2bCommand(), "brain", "migrate-store", "--vault", vault, AUTO_MIGRATION_FLAG, token],
    {
      env: {
        ...process.env,
        ...(configPath !== undefined ? { OPEN_SECOND_BRAIN_CONFIG: configPath } : {}),
      },
      stderrLog: log,
      appendStderrLog: true,
    },
  );
}

/**
 * Start a reindex without blocking, unless the writer lock is already held.
 *
 * Spawns a detached `o2b search reindex` so the rebuild survives a
 * short-lived caller (a SessionStart hook process) and does not tie up a
 * long-lived one (the MCP server).
 *
 * ## The probe is advisory, and this is not mutual exclusion
 *
 * A schema bump makes every session that starts afterwards find the index
 * stale at once, so N sessions used to spawn N children; one took the lock
 * and the rest spun three seconds and died with their stderr pointed at
 * nothing. {@link isWriterLockHeld} is checked FIRST so a child that can
 * already be seen to lose is never started.
 *
 * That check is a read of an instant, not a claim on it. Two callers can
 * both find the lock free and both spawn - the window between the probe and
 * the child's own `acquireWriterLock` is not closed by anything here, and
 * closing it would mean holding the lock across a spawn, which would hand a
 * detached child a lock its parent owns. `reindexVault`'s lock remains the
 * only exclusion in the system; this only thins the herd, and the loser of
 * a real race now records why it lost.
 *
 * ## How wide that window is, measured, and what the probe therefore buys
 *
 * The window is a cold Bun start plus module load, flag parse and config
 * resolution before `reindexVault` reaches its lock. Measured on a 400-note
 * vault, spawn to lock-held was 710, 753, 723, 737, 710 ms over five runs.
 * So the probe thins NOTHING among callers that probe inside those ~0.7 s:
 * four parents released from one barrier all found the lock free and all
 * spawned (measured 4/4).
 *
 * What it does buy is every caller that arrives AFTER a child has the lock,
 * and on a real vault that is most of them: a rebuild that takes minutes is
 * a minutes-long window in which each new `SessionStart` / `PostCompact`
 * hook is a caller that now starts nothing (measured: a parent 1.5 s behind
 * the first records `skipped_writer_lock`). The simultaneous burst this
 * module's opening paragraph describes is exactly the case it does not
 * help; closing that one needs a claim the parent can make before the
 * spawn, which is a lock with its own staleness policy, not a probe.
 * `tests/core/maintenance/self-heal-reindex.test.ts` pins both halves.
 *
 * The child's streams stay ignored: it is detached and there is no terminal
 * to write to. Its terminal outcome goes to the `self_heal_reindex` metrics
 * surface instead, which `--self-heal <run-id>` arms - the same run id this
 * function records on the spawn row, so the two rows pair without a pid;
 * see `self-heal-reindex.ts` for why the parent cannot record the outcome.
 */
export function startSelfHealReindex(
  vault: string,
  configPath: string,
  dbPath: string,
  errors: string[],
): SelfHealSpawnDecision {
  let lockHeld = false;
  try {
    lockHeld = isWriterLockHeld(dbPath);
  } catch (e) {
    // The probe could not answer. That is reported, not swallowed - and
    // the spawn goes ahead anyway: declining to self-heal because a stat
    // failed would leave a stale index behind with nobody told, while a
    // child that turns out to lose the race now records why.
    errors.push(`writer-lock-probe: ${message(e)}`);
  }
  if (lockHeld) {
    recordSelfHealSpawn(vault, SELF_HEAL_SPAWN.skippedWriterLock);
    return SELF_HEAL_SPAWN.skippedWriterLock;
  }
  // Minted BEFORE the spawn: it is what the child is told to write on its
  // own terminal row, so the pair exists whichever process writes first.
  const runId = mintSelfHealRunId();
  // Detached on every platform, with the live environment
  // (`spawnSelfDetached`): on Windows a child that is not detached is
  // ended together with its parent, so a rebuild started by a short-lived
  // hook process died the moment the hook exited and never recorded an
  // outcome; and Bun hands a child spawned without `env` the environment
  // this process STARTED with, so a config the process selected after
  // start (`--config`, an embedding host, the test preload) would be
  // invisible to the rebuild, which would resolve the default config
  // instead - another vault, and on a first run a device id minted into a
  // config file nobody asked for.
  spawnSelfDetached([
    ...o2bCommand(),
    "search",
    "reindex",
    "--vault",
    vault,
    "--config",
    configPath,
    SELF_HEAL_FLAG,
    runId,
  ]);
  recordSelfHealSpawn(vault, SELF_HEAL_SPAWN.spawned, runId);
  return SELF_HEAL_SPAWN.spawned;
}

export async function ensureVaultCurrent(
  vault: string,
  opts: EnsureCurrentOptions = {},
): Promise<EnsureCurrentResult> {
  // A start never queries a process identity, also not to word the refusal
  // of a write the gate turns away on its way (a metrics row).
  return withGateJudge("cheap", () => ensureVaultCurrentJudged(vault, opts));
}

async function ensureVaultCurrentJudged(
  vault: string,
  opts: EnsureCurrentOptions,
): Promise<EnsureCurrentResult> {
  const background = opts.background ?? true;
  if (background) {
    // Yield first: callers start this and go straight on to serving
    // (`void ensureVaultCurrent(...)`), and everything below up to the
    // first `await` would otherwise run before they do.
    await new Promise<void>((resolveYield) => setImmediate(resolveYield));
  }
  const errors: string[] = [];
  let brainUpgraded: ReadonlyArray<string> = [];
  let brainUpgradeSpawn: SelfHealUpgradeSpawnDecision | null = null;
  let brainUpgradeOutcome: SelfHealUpgradeOutcome | null = null;
  let migrationSpawn: AutoMigrationSpawnDecision | null = null;
  let reindexTriggered = false;
  let indexUpgraded = false;
  let reindexSpawn: SelfHealSpawnDecision | null = null;
  let freshen: FreshenDecision | null = null;

  // A store-only machine (switched, or a vault with no legacy tree) writes
  // no byte under `Brain/` (design D14 item 1): there is no managed-file
  // upgrade to run, and creating `Brain/` would send it back to the legacy
  // layout. Its index steps still run once a store is set up.
  const mode = storeOnlyMode({
    vault,
    ...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}),
  });
  const switched = mode.storeOnly;

  // Only an already-initialised vault is a target: `_brain.yaml`, or a
  // configured store on a store-only machine. Either is enough: a switched
  // machine whose store cannot be read for a moment (sync removed or has
  // not delivered a partition) still keeps its search index current, as
  // its legacy `_brain.yaml` says it was set up. Anything else is "not set
  // up yet" - that is `o2b init`'s job, not ours.
  const initialized =
    existsSync(brainConfigPath(vault)) || (switched && configuredStore(opts.configPath) !== null);
  if (!initialized) {
    return {
      brainUpgraded: [],
      brainUpgradeSpawn: null,
      brainUpgradeOutcome: null,
      migrationSpawn: null,
      reindexTriggered: false,
      indexUpgraded: false,
      reindexSpawn: null,
      freshen: null,
      skipped: "not-initialized",
      errors: [],
    };
  }

  // A store 2.0.0 left at the per-user default outside the vault is never
  // moved from here: a person runs `o2b store move-into-vault` with the
  // agent sessions closed (`store-migration/move-into-vault.ts`), and the
  // session line says so once a day (`runtime-notices.ts`).

  // 1. Brain managed-file upgrade - idempotent; only when changes are pending
  //    and the plan is clean (a half-mergeable plan is left for the operator).
  //    In the background it runs in a detached worker; a failure is recorded
  //    by the worker and backs off the next automatic attempt.
  if (!switched) {
    // 1a. The store migration (change auto-store-migration, decision D1)
    //     is decided first: when this machine has not migrated its brain
    //     and has not opted out, the migration runs in a detached worker,
    //     and that worker runs the managed-file upgrade below before it
    //     migrates. The step is a cheap read when nothing is to do, and it
    //     never runs inside the hook or the server process; in the
    //     foreground mode (explicit callers, `o2b update`) the same worker
    //     logic runs in this process, after the upgrade.
    if (background) {
      try {
        migrationSpawn = startAutoMigration(vault, opts.configPath, new Date());
      } catch (e) {
        errors.push(`store-migration: ${message(e)}`);
      }
    }
    // 1b. The managed-file upgrade. A start whose migration worker runs (or
    //     was just started) leaves it to that worker: a second worker would
    //     race it into the migration gate, which refuses its writes.
    try {
      if (background) {
        if (!migrationOwnsUpgrade(migrationSpawn)) {
          brainUpgradeSpawn = startSelfHealUpgrade(vault, opts.configPath, new Date());
        }
      } else {
        // The same machine config this run judged store-only mode by.
        const upgrade = runSelfHealUpgrade(
          vault,
          opts.configPath !== undefined ? { configPath: opts.configPath } : {},
        );
        brainUpgradeOutcome = upgrade.outcome;
        brainUpgraded = upgrade.filesUpdated;
        if (upgrade.outcome === SELF_HEAL_UPGRADE_OUTCOME.failed) {
          errors.push(`brain-upgrade: ${upgrade.error ?? "failed"}`);
        }
      }
    } catch (e) {
      errors.push(`brain-upgrade: ${message(e)}`);
    }
    if (!background) {
      try {
        runAutoStoreMigration(
          vault,
          opts.configPath !== undefined ? { configPath: opts.configPath } : {},
        );
        migrationSpawn = AUTO_MIGRATION_SPAWN.foreground;
      } catch (e) {
        errors.push(`store-migration: ${message(e)}`);
      }
    }
  }

  // 1c. A switched machine whose switch, or whose automatic attempt's
  //     success records, did not finish (change auto-store-migration): the
  //     same worker finishes them. Nothing else on a switched machine.
  if (switched && mode.reason === "device-switched") {
    try {
      if (background) {
        migrationSpawn = startSwitchFinish(vault, opts.configPath, new Date());
        // 1d. Nothing left to finish: the legacy tree leaves the vault once
        //     the cohort allows (`auto-removal.ts`), in its own worker.
        if (migrationSpawn === null) {
          startAutoLegacyRemoval(vault, opts.configPath, new Date());
        }
      } else {
        runAutoStoreMigration(
          vault,
          opts.configPath !== undefined ? { configPath: opts.configPath } : {},
        );
        migrationSpawn = AUTO_MIGRATION_SPAWN.foreground;
      }
    } catch (e) {
      errors.push(`store-migration: ${message(e)}`);
    }
  }

  // 2. Search index - an older schema is migrated in place (the stored
  //    embeddings survive); an absent, unreadable or newer index, or one
  //    chunked by older rules, is rebuilt (#256). In the background the
  //    detached self-heal child applies the same policy.
  try {
    const configPath = opts.configPath ?? defaultConfigPath();
    const config = resolveSearchConfig({ vault, configPath });
    // 3. A current index that has gone stale: catch it up in the
    //    background so the session's first read is not the one that pays.
    const freshenIfStale = (): void => {
      freshen = maybeFreshenIndex(config, {
        lastIndexedAt: readLastIndexedAt(config.dbPath),
        ...(opts.freshenSpawn !== undefined ? { spawn: opts.freshenSpawn } : {}),
      });
    };
    // ONE decision about what a stale index needs (`planIndexRepair`),
    // the same one the read path takes: an older schema is upgraded in
    // place, and only an index no upgrade can repair is rebuilt.
    const plan = planIndexRepair(config);
    if (plan.kind !== "current") {
      if (
        background &&
        migrationOwnsUpgrade(migrationSpawn) &&
        rebuildsIntoLegacyFolder(vault, config.dbPath)
      ) {
        // The migration worker this start left the vault to switches this
        // machine to the brain store, where the index lives in device-local
        // state and is built anew: a rebuild here would write a whole index
        // into the vault's legacy folder (hundreds of MB on a large vault)
        // that nothing reads after the switch and that stays behind in the
        // vault. The first start after the switch builds the new one.
        reindexSpawn = SELF_HEAL_SPAWN.skippedMigration;
      } else if (background) {
        // An older schema is left to the read that meets it: the read path
        // upgrades it in place, and a background job would take the writer
        // lock that upgrade needs and race it for it. The command line and
        // the MCP server therefore meet an old index the same way - one
        // decision, one repair, whichever surface the read came from.
        //
        // Unless the index owes a repair BEYOND that upgrade - entity rows
        // of the older rule, chunks of older rules. The reader that
        // upgrades the schema answers from the index it upgraded and does
        // not repair it; the background heal does, and it re-plans after
        // the upgrade, so it ends current on both counts.
        if (plan.kind !== "upgrade-in-place" || owesRepairBeyondUpgrade(config)) {
          reindexSpawn = startSelfHealReindex(vault, configPath, config.dbPath, errors);
          // A run that declined to spawn started nothing, and saying it did
          // would report a rebuild that is not this run's.
          reindexTriggered = reindexSpawn === SELF_HEAL_SPAWN.spawned;
        }
      } else {
        const healed = await healIndex(config);
        reindexTriggered = healed.kind === "rebuilt";
        indexUpgraded = healed.kind === "migrated";
        // An in-place upgrade (or a heal another process finished) touches
        // no document, so files changed since the last index run are still
        // stale - the full rebuild this replaced used to pick them up.
        if (!reindexTriggered) freshenIfStale();
      }
    } else {
      freshenIfStale();
    }
  } catch (e) {
    errors.push(`search-reindex: ${message(e)}`);
  }

  // 4. The dream owner's device hands a pending transfer over, and notes
  //    its own fresh claim (change agent-neutral-dream, design D3): a few
  //    settings records read, and a release written only on the owner's
  //    device under its pass lock, so a pass in progress is never cut.
  try {
    maintainDreamOwner(vault, opts.configPath);
  } catch (e) {
    errors.push(`dream-owner: ${message(e)}`);
  }

  return {
    brainUpgraded,
    brainUpgradeSpawn,
    brainUpgradeOutcome,
    migrationSpawn,
    reindexTriggered,
    indexUpgraded,
    reindexSpawn,
    freshen,
    skipped: "",
    errors,
  };
}
