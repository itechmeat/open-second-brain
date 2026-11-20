/**
 * The automatic store migration's device-local state (change
 * auto-store-migration, design D2). The worker that
 * `ensureVaultCurrent` starts (`auto-worker.ts`) and the reporting
 * surfaces (`auto-report.ts`, the doctor, the store status block) read
 * and write it; nothing else does.
 *
 * Three files, one folder per vault per machine:
 * `<state base>/open-second-brain/stores/auto-migration/<vault key>/`, the
 * device-local folder of all stores (`storesStateDir`), which exists
 * before any store does, is never inside a vault and is never synced. The
 * folder does not move when the machine switches or rolls back, so the
 * attempt that claims the lock, records a failure or writes the notice
 * releases and clears the same files whichever layout it ends on, and a
 * rollback never brings an old record back.
 *
 *  - the WORKER LOCK, `auto-store-migration.lock`, so N starts at once
 *    start one worker. The claim is an exclusive create holding a JSON
 *    record with the claim token, the holder's pid and start identity,
 *    and the claim time, so the report can say since when and which
 *    process. The parent claims before it spawns, hands the claim to the
 *    child's pid, and the worker stamps its own start identity on it;
 *    the worker releases when it ends. Every claim, takeover, hand-over
 *    and release runs under a short device-local mutex beside the file,
 *    so a takeover can never leave two holders. A claim is stale when its
 *    holder is provably not running (the pid is gone, or now names
 *    another process: the rule of the migration gate, `quiesce.ts`); a
 *    provably running holder keeps it however long the run takes. When
 *    the holder cannot be told (no identity recorded or readable), the
 *    one-hour age rule of the other workers applies, and an mtime in the
 *    future counts as stale. That is the EXACT judgement, for the worker,
 *    the manual verb and the doctor. A session start and the runtime
 *    notices use the CHEAP one ({@link AUTO_MIGRATION_LOCK_JUDGE}): the pid
 *    alone, never an identity query, which can be a subprocess on Windows
 *    and macOS. The cheap judge never takes over a live pid's claim; past
 *    the age a holder is trusted for, the start leaves the claim to a
 *    worker that judges exactly ({@link autoMigrationClaimUndecided}).
 *    A claim file that cannot be read is never taken over. Every one of
 *    these answers is {@link decideClaim}'s, a pure function the callers
 *    gather the state for.
 *  - the STATE FILE, `auto-store-migration.json`: the last FAILED
 *    attempt (reason, consecutive count, manual command, and the
 *    cooldown's end, which doubles per consecutive failure) or the
 *    WAITING state of a later machine whose first machine's cut has not
 *    arrived. Waiting starts no cooldown: it is not a failure. Both are
 *    cleared by the attempt that succeeds.
 *  - the NOTICE, `store-migration-notice.json`: written once on success
 *    (the snapshot), shown once at a session start (with the rollback
 *    command), then cleared.
 *
 * A failure is a property of the device (a full disk, an unmapped file,
 * a store root inside the vault), so the state is device-local and never
 * synced; a peer migrates on its own answer.
 *
 * Leaf module on purpose: the doctor and the status block read the state
 * without pulling the worker in.
 */

import { latestWorkerLogAttempt } from "./worker-log.ts";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { canonicalVault } from "../migration-gate.ts";
// The cooldown math and the age rule are the self-heal upgrade's, reused:
// same base, same ceiling, same doubling rule, same one-hour takeover.
// Its module imports nothing from here.
import {
  SELF_HEAL_UPGRADE_LOCK_STALE_MS,
  SELF_HEAL_UPGRADE_MAX_COOLDOWN_MS,
  selfHealUpgradeCooldownMs,
} from "../maintenance/self-heal-upgrade-state.ts";
import { processDirsEnv } from "../platform-dirs.ts";
import { vaultKey } from "../state/machine-state.ts";
import { isLockContention, withLocalLock } from "../store/local-lock.ts";
import { storesStateDir } from "../store/store-paths.ts";
import { holderLiveness, processAlive } from "./holder-liveness.ts";
import { processStartIdentity } from "./process-identity.ts";

/**
 * Suffix of the device-local file beside a vault's state folder that the
 * worker's output goes to (a new attempt at every spawn, the last few kept). Beside the
 * folder, not in it, so the folder still goes when its last record does.
 */
export const AUTO_MIGRATION_WORKER_LOG_SUFFIX = ".worker.log";

/** At most this much of the worker's error output goes into a failure reason. */
const WORKER_LOG_TAIL_CHARS = 600;

/** Folder (in the folder of all stores) of the per-vault automatic migration state. */
export const AUTO_MIGRATION_STATE_DIR = "auto-migration";

/** Worker lock file name. */
export const AUTO_MIGRATION_LOCK_FILE = "auto-store-migration.lock";

/** Failure / waiting state file name. */
export const AUTO_MIGRATION_STATE_FILE = "auto-store-migration.json";

/** One-time success notice file name. */
export const AUTO_MIGRATION_NOTICE_FILE = "store-migration-notice.json";

/**
 * The command the doctor, the status block and the notices name for a
 * failed automatic migration.
 */
export const AUTO_MIGRATION_MANUAL_COMMAND = "o2b brain migrate-store";

/** How the automatic migration rolls back, for the surfaces that say so. */
export const AUTO_MIGRATION_ROLLBACK_COMMAND = "o2b brain migrate-store --rollback";

/**
 * How long a lock file that cannot be read (a claim being written right
 * now, or a damaged file) holds before it is taken over.
 */
export const AUTO_MIGRATION_UNREADABLE_LOCK_GRACE_MS = 10_000;

/**
 * How far in the future a lock's mtime may be before it counts as stale:
 * file times and the clock are read at different resolutions, so a claim
 * written a moment ago can look a fraction of a second ahead.
 */
const FUTURE_MTIME_TOLERANCE_MS = 60_000;

/**
 * How a claim's holder is judged.
 *
 *  - `exact`: the pid and, when one was recorded, its start identity
 *    (`holderLiveness`). Reading an identity can cost an external query
 *    (PowerShell on Windows, `ps` on macOS), up to a second or more: for
 *    the worker, the manual verb and the doctor, which can afford it.
 *  - `cheap`: the pid alone (one signal probe) and the claim's age, never
 *    an identity query, not even of this process: for a session start and
 *    the runtime notices, which must never wait on a subprocess. A live
 *    pid holds for {@link AUTO_MIGRATION_LIVE_PID_CEILING_MS} when an
 *    identity was recorded (a stamped worker), else by the one-hour age
 *    rule, as the exact judgement does for a holder it cannot tell apart.
 */
export const AUTO_MIGRATION_LOCK_JUDGE = Object.freeze({
  exact: "exact",
  cheap: "cheap",
} as const);

export type AutoMigrationLockJudge =
  (typeof AUTO_MIGRATION_LOCK_JUDGE)[keyof typeof AUTO_MIGRATION_LOCK_JUDGE];

export interface AutoMigrationLockOptions {
  /**
   * Told the worker a replaced claim was handed to when that worker never
   * confirmed it ({@link LostAutoMigrationWorker}): the claimer records it.
   */
  readonly onLostWorker?: (worker: LostAutoMigrationWorker) => void;
  /** How the holder of an existing claim is judged; `cheap` by default. */
  readonly judge?: AutoMigrationLockJudge;
}

/**
 * How long the cheap judgement lets a live pid with a recorded identity
 * hold a claim without checking that identity: a day, the longest
 * cooldown. Past it the claim is the worker's to judge exactly, so a pid
 * reused by an unrelated long-lived process cannot hold the migration off
 * for longer than that.
 */
export const AUTO_MIGRATION_LIVE_PID_CEILING_MS = SELF_HEAL_UPGRADE_MAX_COOLDOWN_MS;

/** How long a claim, takeover or release waits for the lock's mutex. */
const LOCK_MUTEX_BUDGET_MS = 2000;

/**
 * How long a claim of `judge` waits for the lock's mutex: the cheap one (a
 * session start) never waits, because the holder may be an exact claimer
 * querying a start identity (a subprocess on Windows and macOS); a busy
 * mutex is a claim being made, so the start starts nothing. Everyone else
 * waits the short budget.
 */
export function claimMutexBudgetMs(judge: AutoMigrationLockJudge): number {
  return judge === AUTO_MIGRATION_LOCK_JUDGE.cheap ? 0 : LOCK_MUTEX_BUDGET_MS;
}

export { selfHealUpgradeCooldownMs as selfHealMigrationCooldownMs };

/**
 * The folder of the automatic migration state of `vault` on this machine.
 * Independent of the layout: it is the same before the switch, after it,
 * and after a rollback. Keyed by the vault's canonical path (links
 * resolved, case folded on Windows: the form the migration gate compares
 * by), so every spelling of one vault shares one worker lock. No release
 * kept these folders under another spelling, so none is carried over.
 */
export function autoMigrationStateDir(vault: string): string {
  return join(
    storesStateDir(processDirsEnv()),
    AUTO_MIGRATION_STATE_DIR,
    vaultKey(canonicalVault(vault)),
  );
}

/** The worker's error output log for `vault` ({@link AUTO_MIGRATION_WORKER_LOG_SUFFIX}). */
export function autoMigrationWorkerLogPath(vault: string): string {
  return `${autoMigrationStateDir(vault)}${AUTO_MIGRATION_WORKER_LOG_SUFFIX}`;
}

/**
 * The last part of the worker's error output, reduced for the surfaces it
 * reaches, or null when there is none (or it cannot be read).
 */
export function readAutoMigrationWorkerLogTail(vault: string): string | null {
  let text: string;
  try {
    text = readFileSync(autoMigrationWorkerLogPath(vault), "utf8");
  } catch {
    return null;
  }
  // Only what the latest attempt wrote: the log keeps the attempts before
  // it too (`worker-log.ts`), and a lost worker is judged by its own output.
  const trimmed = latestWorkerLogAttempt(text).trim();
  if (trimmed.length === 0) return null;
  const tail =
    trimmed.length <= WORKER_LOG_TAIL_CHARS
      ? trimmed
      : `...${trimmed.slice(trimmed.length - WORKER_LOG_TAIL_CHARS + 3)}`;
  return printable(tail).replace(/\s+/g, " ");
}

export function autoMigrationLockPath(vault: string): string {
  return join(autoMigrationStateDir(vault), AUTO_MIGRATION_LOCK_FILE);
}

export function autoMigrationStatePath(vault: string): string {
  return join(autoMigrationStateDir(vault), AUTO_MIGRATION_STATE_FILE);
}

export function autoMigrationNoticePath(vault: string): string {
  return join(autoMigrationStateDir(vault), AUTO_MIGRATION_NOTICE_FILE);
}

/**
 * Remove the vault's state folder once it is empty: the last of its files
 * (the lock, the state record, the notice) was just dropped. A folder that
 * still holds anything stays. Never throws.
 */
function pruneAutoMigrationStateDir(vault: string): void {
  try {
    rmdirSync(autoMigrationStateDir(vault));
  } catch {
    // not empty, already gone, or held open for a moment: left as it is
  }
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/**
 * Write one of the folder's files. The folder is removed when its last
 * file goes ({@link pruneAutoMigrationStateDir}), so a write that loses
 * that race makes the folder again once.
 */
function writeStateFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  try {
    atomicWriteFileSync(path, text);
  } catch (err) {
    if (!isMissing(err)) throw err;
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteFileSync(path, text);
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ----- Worker lock ---------------------------------------------------------

/** What a live claim on the worker lock says. */
export interface AutoMigrationRunning {
  /** The holder's pid; null when the claim cannot be read (being written, or a read error). */
  readonly pid: number | null;
  /** ISO-8601 instant the claim was made; null when the claim cannot be read. */
  readonly since: string | null;
}

/**
 * Whether a claim was handed to a spawned worker: `awaited` once the start
 * that spawned it handed the claim to its pid, `confirmed` once the worker
 * stamped the claim itself, null for a claim no start handed over (a
 * start's own, a self-claiming worker's, the manual verb's).
 */
export type ClaimWorker = "awaited" | "confirmed" | null;

interface LockRecord {
  token: string;
  pid: number;
  /** The holder's start identity (`process-identity.ts`), or null when not known. */
  started: string | null;
  since: string;
  worker: ClaimWorker;
}

function parseLockRecord(text: string): LockRecord | null {
  try {
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== "object" || raw === null) return null;
    const r = raw as Record<string, unknown>;
    if (typeof r["token"] !== "string") return null;
    return {
      token: r["token"],
      pid: typeof r["pid"] === "number" ? r["pid"] : 0,
      started: typeof r["started"] === "string" ? r["started"] : null,
      since: typeof r["since"] === "string" ? r["since"] : new Date(0).toISOString(),
      worker: r["worker"] === "awaited" || r["worker"] === "confirmed" ? r["worker"] : null,
    };
  } catch {
    return null;
  }
}

/**
 * The claim file as one look at it found it. `ageMs` is the time since its
 * mtime (negative when the mtime is in the future).
 *
 *  - `absent`: no claim;
 *  - `unreadable`: it is there, and reading it failed for a reason other
 *    than its absence (a permission, an I/O error): nothing is known of
 *    its holder;
 *  - `torn`: it was read and holds no claim record (empty, a claim being
 *    written right now, or damaged);
 *  - `valid`: a claim record.
 */
export type ClaimFile =
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable"; readonly ageMs: number | null }
  | { readonly kind: "torn"; readonly ageMs: number }
  | {
      readonly kind: "valid";
      readonly ageMs: number;
      readonly token: string;
      readonly pid: number;
      readonly started: string | null;
      readonly since: string;
      readonly worker: ClaimWorker;
    };

/**
 * What the asker can tell of a valid claim's holder: the cheap judgement
 * sees only whether the pid is alive (`dead`, or `unknown` for a live
 * pid); the exact one also compares the start identity (`dead` when the
 * pid now names another process, `alive` when it is the recorded one,
 * `unknown` when no identity was recorded or none can be read).
 */
export type ClaimHolderSeen = "dead" | "alive" | "unknown";

/** Who asks about the claim, with what it brings. */
export type ClaimAsker =
  /** A session start claiming before it spawns a worker (cheap). */
  | { readonly who: "start" }
  /** A worker, or the manual verb's own claim, claiming with the exact judgement. */
  | { readonly who: "claim" }
  /**
   * A parent handing its claim to the worker's pid, or the worker stamping
   * itself (`confirms`: the worker's own stamp, which confirms that it
   * started).
   */
  | {
      readonly who: "hand-over";
      readonly token: string;
      readonly pid: number;
      readonly started: string | null;
      readonly confirms: boolean;
    }
  /** The start that spawned worker `pid` on its claim `token` saw that process exit. */
  | { readonly who: "exited"; readonly token: string; readonly pid: number }
  /** The holder of `token` releasing it. */
  | { readonly who: "release"; readonly token: string }
  /**
   * Reading whether a worker runs: the manual verb, the doctor and the
   * report judge exactly, the runtime notices cheaply.
   */
  | { readonly who: "read"; readonly judge: AutoMigrationLockJudge };

/** The whole state one claim decision is taken on. */
export interface ClaimState {
  readonly file: ClaimFile;
  /** The holder as the asker's judgement sees it; asked only of a valid claim. */
  readonly holder: ClaimHolderSeen;
  /** Whether the claim's device-local mutex could be taken. */
  readonly mutex: "free" | "busy";
  readonly asker: ClaimAsker;
}

/**
 * A worker a start spawned and handed its claim to, gone without ever
 * confirming the claim: it could not run, or died before its first state
 * record.
 */
export interface LostAutoMigrationWorker {
  readonly pid: number;
  /** ISO-8601 instant the start claimed the lock for it. */
  readonly since: string;
}

/** What one claim decision answers. */
export type ClaimDecision =
  /**
   * Make a new claim: remove the one there first (`replace`), then an
   * exclusive create. `lost` names the worker the replaced claim was
   * handed to when that worker never confirmed it: the claimer records it.
   */
  | {
      readonly act: "claim";
      readonly replace: boolean;
      readonly lost: LostAutoMigrationWorker | null;
    }
  /**
   * The claim was handed to a worker that is gone and never confirmed it:
   * a reader reports it; the start that spawned it (`exited`) records it
   * and removes the claim.
   */
  | { readonly act: "worker-lost"; readonly pid: number; readonly since: string }
  /** The claim holds; nothing is changed. */
  | { readonly act: "held" }
  /**
   * The cheap judgement cannot decide a live pid's claim past the age a
   * holder is trusted for: a worker that judges exactly is to decide.
   */
  | { readonly act: "undecided" }
  /** The mutex is busy: nothing is changed and nothing is claimed. */
  | { readonly act: "busy" }
  /**
   * Hand-over: write the claim in the name of the given process, with the
   * start identity `started` (the asker's, or the one the claim already
   * records for that pid when the asker brings none).
   */
  | { readonly act: "stamp"; readonly started: string | null }
  /** Hand-over: the claim is the asker's and already names it with an identity: kept. */
  | { readonly act: "kept" }
  /** Hand-over: the claim is no longer the asker's; nothing is changed. */
  | { readonly act: "lost" }
  /** Release: remove the asker's own claim. */
  | { readonly act: "remove" }
  /** Release: not the asker's claim (or the mutex is busy): left as it is. */
  | { readonly act: "leave" }
  /** Read: a worker runs (`pid` and `since` when the claim names them). */
  | { readonly act: "running"; readonly pid: number | null; readonly since: string | null }
  /** Read: no worker runs. */
  | { readonly act: "idle" };

/**
 * Who may hold, take over, hand over and release the worker claim: one
 * pure function of the claim file, its holder as the asker sees it, the
 * mutex and the asker (see the module header for the rules). No file is
 * read and no process is asked here; the callers gather the state.
 */
export function decideClaim(state: ClaimState): ClaimDecision {
  const { file, holder, asker } = state;
  if (asker.who === "hand-over") {
    if (state.mutex === "busy" || file.kind !== "valid" || file.token !== asker.token) {
      return { act: "lost" };
    }
    // The worker may have stamped itself before its parent hands over:
    // its own identity is never replaced by an unknown one, and its
    // confirmation never by the parent's "awaited".
    const samePid = file.pid === asker.pid;
    if (asker.confirms) {
      const already =
        samePid &&
        file.worker === "confirmed" &&
        (asker.started === null || asker.started === file.started);
      if (already) return { act: "kept" };
    } else if (
      samePid &&
      ((file.started !== null && asker.started === null) || file.worker === "confirmed")
    ) {
      return { act: "kept" };
    }
    return { act: "stamp", started: asker.started ?? (samePid ? file.started : null) };
  }
  if (asker.who === "exited") {
    if (state.mutex === "busy") return { act: "leave" };
    return file.kind === "valid" &&
      file.token === asker.token &&
      file.pid === asker.pid &&
      file.worker === "awaited"
      ? { act: "worker-lost", pid: file.pid, since: file.since }
      : { act: "leave" };
  }
  if (asker.who === "release") {
    if (state.mutex === "busy") return { act: "leave" };
    return file.kind === "valid" && file.token === asker.token
      ? { act: "remove" }
      : { act: "leave" };
  }
  const judge =
    asker.who === "read"
      ? asker.judge
      : asker.who === "start"
        ? AUTO_MIGRATION_LOCK_JUDGE.cheap
        : AUTO_MIGRATION_LOCK_JUDGE.exact;
  const stale = claimStale(file, holder, judge);
  // A claim handed to a worker that never confirmed it, and whose process
  // is gone: that worker never ran its attempt.
  const lost: LostAutoMigrationWorker | null =
    stale === true && file.kind === "valid" && file.worker === "awaited" && holder === "dead"
      ? { pid: file.pid, since: file.since }
      : null;
  if (asker.who === "read") {
    // What the claimer of the same judgement leaves, a worker may hold: a
    // claim being written or one that cannot be read names no process.
    if (lost !== null) return { act: "worker-lost", ...lost };
    if (stale === true) return { act: "idle" };
    return file.kind === "valid"
      ? { act: "running", pid: file.pid, since: file.since }
      : { act: "running", pid: null, since: null };
  }
  if (state.mutex === "busy") return { act: "busy" };
  if (stale === "undecided") return { act: "undecided" };
  if (!stale) return { act: "held" };
  return { act: "claim", replace: file.kind !== "absent", lost };
}

/**
 * Whether a claim may be replaced: true, false, or `undecided` for a
 * live pid's claim the cheap judgement keeps past the age it trusts it
 * for.
 */
function claimStale(
  file: ClaimFile,
  holder: ClaimHolderSeen,
  judge: AutoMigrationLockJudge,
): boolean | "undecided" {
  if (file.kind === "absent") return true;
  // A claim that cannot be read says nothing of its holder: it is never
  // taken over (a permission or an I/O error is not a damaged claim).
  if (file.kind === "unreadable") return false;
  if (file.kind === "torn") {
    return (
      file.ageMs < -FUTURE_MTIME_TOLERANCE_MS ||
      file.ageMs > AUTO_MIGRATION_UNREADABLE_LOCK_GRACE_MS
    );
  }
  const future = file.ageMs < -FUTURE_MTIME_TOLERANCE_MS;
  if (judge === AUTO_MIGRATION_LOCK_JUDGE.cheap) {
    // A live pid's claim is never taken over without an identity check,
    // however old: past the ceiling it is undecided, and the start leaves
    // it to a worker that judges exactly.
    if (holder === "dead") return true;
    const ceiling =
      file.started !== null ? AUTO_MIGRATION_LIVE_PID_CEILING_MS : SELF_HEAL_UPGRADE_LOCK_STALE_MS;
    return future || file.ageMs > ceiling ? "undecided" : false;
  }
  if (holder === "dead") return true;
  if (holder === "alive") return false;
  return future || file.ageMs > SELF_HEAL_UPGRADE_LOCK_STALE_MS;
}

/** The claim file at `path` as it is now ({@link ClaimFile}). */
function claimFileAt(path: string, now: Date): ClaimFile {
  let stat: Stats;
  try {
    stat = statSync(path);
  } catch (err) {
    if (isMissing(err)) return { kind: "absent" };
    return { kind: "unreadable", ageMs: null };
  }
  const ageMs = now.getTime() - stat.mtimeMs;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (isMissing(err)) return { kind: "absent" };
    return { kind: "unreadable", ageMs };
  }
  const record = parseLockRecord(text);
  return record === null ? { kind: "torn", ageMs } : { kind: "valid", ageMs, ...record };
}

/**
 * The holder of a valid claim as `judge` sees it: the cheap judgement
 * asks only whether the pid is alive, the exact one its start identity
 * too (an external query on some platforms).
 */
function claimHolderSeen(file: ClaimFile, judge: AutoMigrationLockJudge): ClaimHolderSeen {
  if (file.kind !== "valid") return "unknown";
  if (judge === AUTO_MIGRATION_LOCK_JUDGE.cheap) {
    return processAlive(file.pid) ? "unknown" : "dead";
  }
  return holderLiveness(file.pid, file.started);
}

/** The decision of `asker` on the claim at `path`, under the mutex when `mutex` is free. */
function claimStateAt(
  path: string,
  now: Date,
  asker: ClaimAsker,
  mutex: "free" | "busy",
): ClaimState {
  const file = claimFileAt(path, now);
  const judge =
    asker.who === "read"
      ? asker.judge
      : asker.who === "start"
        ? AUTO_MIGRATION_LOCK_JUDGE.cheap
        : AUTO_MIGRATION_LOCK_JUDGE.exact;
  // The holder is judged only where the decision reads it: a valid claim
  // a start, a claimer or a reader looks at.
  const judged =
    file.kind === "valid" &&
    asker.who !== "hand-over" &&
    asker.who !== "release" &&
    asker.who !== "exited";
  return { file, holder: judged ? claimHolderSeen(file, judge) : "unknown", mutex, asker };
}

function judgeOf(opts: AutoMigrationLockOptions): AutoMigrationLockJudge {
  return opts.judge ?? AUTO_MIGRATION_LOCK_JUDGE.cheap;
}

/**
 * Run `fn` under the lock's device-local mutex. Returns `fallback` when
 * another process holds the mutex past the short budget.
 */
function underMutex<T>(
  path: string,
  fn: () => T,
  fallback: T,
  budgetMs: number = LOCK_MUTEX_BUDGET_MS,
): T {
  try {
    return withLocalLock(path, fn, budgetMs);
  } catch (err) {
    if (isLockContention(err, path)) return fallback;
    throw err;
  }
}

/**
 * Claim the worker lock without waiting long: under the mutex, the claim
 * there is judged ({@link decideClaim}), a stale one removed and an
 * exclusive create writes the new one. Returns the token, or null when a
 * live claim exists (or another claim is being made right now).
 */
export function claimAutoMigrationLock(
  vault: string,
  now: Date,
  opts: AutoMigrationLockOptions = {},
): string | null {
  const judge = judgeOf(opts);
  const path = autoMigrationLockPath(vault);
  mkdirSync(dirname(path), { recursive: true });
  // The cheap claim records no identity: reading even this process's own
  // can be an external query. A worker stamps its own when it starts.
  const started =
    judge === AUTO_MIGRATION_LOCK_JUDGE.exact ? processStartIdentity(process.pid) : null;
  const asker: ClaimAsker =
    judge === AUTO_MIGRATION_LOCK_JUDGE.cheap ? { who: "start" } : { who: "claim" };
  let lost: LostAutoMigrationWorker | null = null;
  const claim = (): string | null =>
    underMutex(
      path,
      (): string | null => {
        const decision = decideClaim(claimStateAt(path, now, asker, "free"));
        if (decision.act !== "claim") return null;
        lost = decision.lost;
        if (decision.replace) {
          try {
            unlinkSync(path);
          } catch (err) {
            if (!isMissing(err)) throw err;
          }
        }
        const token = randomBytes(16).toString("hex");
        const record: LockRecord = {
          token,
          pid: process.pid,
          started,
          since: now.toISOString(),
          worker: null,
        };
        writeFileSync(path, JSON.stringify(record), { flag: "wx" });
        return token;
      },
      null,
      claimMutexBudgetMs(judge),
    );
  let token: string | null;
  try {
    token = claim();
  } catch (err) {
    // The folder was pruned between its creation and the claim: once more.
    if (!isMissing(err)) throw err;
    mkdirSync(dirname(path), { recursive: true });
    token = claim();
  }
  if (token !== null && lost !== null) opts.onLostWorker?.(lost);
  return token;
}

/**
 * Whether `token` is the claim on the worker lock right now: `owned`,
 * `lost` (no claim, or another one), or `unreadable` (the claim file is
 * there and cannot be read, which says nothing of whose it is).
 */
export function autoMigrationClaimOwnership(
  vault: string,
  token: string,
): "owned" | "lost" | "unreadable" {
  const file = claimFileAt(autoMigrationLockPath(vault), new Date());
  if (file.kind === "unreadable") return "unreadable";
  return file.kind === "valid" && file.token === token ? "owned" : "lost";
}

/** A write under the worker claim refused: the claim is not the writer's (or cannot be told). */
export class AutoMigrationClaimLostError extends Error {
  constructor(readonly ownership: "lost" | "unreadable" | "busy") {
    super(
      ownership === "busy"
        ? "the worker claim's mutex stayed busy, so this worker cannot tell that it still holds it"
        : ownership === "unreadable"
          ? "the worker claim cannot be read, so this worker cannot tell that it still holds it"
          : "the worker claim was taken over; this worker writes nothing more",
    );
    this.name = "AutoMigrationClaimLostError";
  }
}

/**
 * Run `write` only while `token` is the claim on the worker lock: the
 * check and the write are one step under the claim's mutex, which every
 * claim and takeover also takes, so a worker whose claim was taken over
 * can never write after the takeover. Throws
 * {@link AutoMigrationClaimLostError} (and writes nothing) otherwise.
 */
export function underOwnAutoMigrationClaim<T>(
  vault: string,
  token: string,
  write: () => T,
  budgetMs: number = LOCK_MUTEX_BUDGET_MS,
): T {
  const path = autoMigrationLockPath(vault);
  let refused: "lost" | "unreadable" | "busy" = "busy";
  let done = false;
  let result: T | undefined;
  underMutex(
    path,
    (): boolean => {
      const ownership = autoMigrationClaimOwnership(vault, token);
      if (ownership !== "owned") {
        refused = ownership;
        return false;
      }
      result = write();
      done = true;
      return true;
    },
    false,
    budgetMs,
  );
  if (!done) throw new AutoMigrationClaimLostError(refused);
  return result as T;
}

/** Whether `token` is the claim on the worker lock right now ({@link autoMigrationClaimOwnership}). */
export function ownsAutoMigrationLock(vault: string, token: string): boolean {
  return autoMigrationClaimOwnership(vault, token) === "owned";
}

/**
 * Put the claim `token` in the name of process `pid` (start identity
 * `started`, or null when not known): the parent hands its claim to the
 * worker it spawned (the claim then awaits the worker's confirmation),
 * and the worker stamps its own identity on it (`confirms`), which
 * confirms that it started. Returns whether the claim was still
 * `token`'s; a claim taken over meanwhile is left alone
 * ({@link decideClaim}).
 */
export function handAutoMigrationLock(
  vault: string,
  token: string,
  pid: number,
  started: string | null,
  confirms = false,
): boolean {
  const path = autoMigrationLockPath(vault);
  return underMutex(
    path,
    (): boolean => {
      const state = claimStateAt(
        path,
        new Date(),
        { who: "hand-over", token, pid, started, confirms },
        "free",
      );
      const decision = decideClaim(state);
      if (decision.act === "lost") return false;
      if (decision.act === "stamp" && state.file.kind === "valid") {
        const { token: t, since } = state.file;
        const record: LockRecord = {
          token: t,
          pid,
          started: decision.started,
          since,
          worker: confirms ? "confirmed" : "awaited",
        };
        atomicWriteFileSync(path, JSON.stringify(record));
      }
      return true;
    },
    false,
  );
}

/**
 * The start that spawned worker `pid` on its claim `token` saw it exit:
 * when the worker never confirmed the claim ({@link decideClaim}'s
 * `worker-lost`), its failure is recorded ({@link recordLostAutoMigrationWorker})
 * and the claim removed, so the next starts back off and every surface
 * names it. Never waits for the mutex; never throws. Returns whether it
 * recorded the worker as lost.
 */
export function settleExitedAutoMigrationWorker(
  vault: string,
  token: string,
  pid: number,
  exit: string,
  now: Date = new Date(),
): boolean {
  const path = autoMigrationLockPath(vault);
  try {
    return underMutex(
      path,
      (): boolean => {
        const decision = decideClaim(
          claimStateAt(path, now, { who: "exited", token, pid }, "free"),
        );
        if (decision.act !== "worker-lost") return false;
        recordLostAutoMigrationWorker(vault, decision, now, exit);
        try {
          unlinkSync(path);
        } catch {
          // already gone
        }
        return true;
      },
      false,
      0,
    );
  } catch {
    return false;
  }
}

/** The lost worker a reader sees on the claim, or null ({@link decideClaim}'s `worker-lost`). */
export function readLostAutoMigrationWorker(
  vault: string,
  now: Date = new Date(),
  opts: AutoMigrationLockOptions = {},
): LostAutoMigrationWorker | null {
  const path = autoMigrationLockPath(vault);
  const decision = decideClaim(
    claimStateAt(path, now, { who: "read", judge: judgeOf(opts) }, "free"),
  );
  return decision.act === "worker-lost" ? { pid: decision.pid, since: decision.since } : null;
}

/**
 * The reason a lost worker is recorded with: what became of it, its exit
 * when the start saw it, the tail of its error output, and the log that
 * holds the whole of it.
 */
export function describeLostAutoMigrationWorker(
  vault: string,
  worker: LostAutoMigrationWorker,
  exit: string | null,
): string {
  const tail = readAutoMigrationWorkerLogTail(vault);
  return (
    `the automatic migration worker (process ${worker.pid}, started at ${worker.since}) ` +
    `exited before it started${exit !== null ? ` (${exit})` : ""}` +
    (tail !== null ? `; its error output: ${tail}` : "; it wrote no error output") +
    ` (log: ${autoMigrationWorkerLogPath(vault)})`
  );
}

/**
 * Release the claim `token` made. A lock that is no longer ours (taken
 * over as stale by another process) is left alone. Never throws.
 *
 * The check and the removal are one step under the mutex. When the mutex
 * stays busy the claim is left: a takeover may be replacing it right now
 * (the exact judge takes over a holder whose identity cannot be read past
 * the age rule), and an unlocked removal could delete the successor's
 * claim. The claim left
 * behind is stale once this process ends.
 */
export function releaseAutoMigrationLock(vault: string, token: string): void {
  const path = autoMigrationLockPath(vault);
  const release = (): void => {
    const decision = decideClaim(claimStateAt(path, new Date(), { who: "release", token }, "free"));
    if (decision.act !== "remove") return;
    try {
      unlinkSync(path);
    } catch {
      // already gone
    }
  };
  try {
    underMutex(path, () => (release(), true), false);
  } catch {
    // Nothing left to do: a claim left behind is stale once this process ends.
  }
  pruneAutoMigrationStateDir(vault);
}

/**
 * The `--auto` value of a worker started with no claim of its own: it
 * claims the lock itself with the exact judge. Claim tokens are 32 hex
 * characters, so it is never one.
 */
export const AUTO_MIGRATION_SELF_CLAIM = "self";

/**
 * Whether a claim the cheap judge keeps (its pid is alive) is past the age
 * a running holder is trusted for without an identity check: the pid may
 * be the worker, hung or slow, or a later process that reuses it. A start
 * cannot tell them apart, so it starts a worker that claims with the exact
 * judge, which takes the claim over only from a holder that is gone.
 */
export function autoMigrationClaimUndecided(vault: string, now: Date): boolean {
  const path = autoMigrationLockPath(vault);
  return decideClaim(claimStateAt(path, now, { who: "start" }, "free")).act === "undecided";
}

/** "process <pid>, since <time>", or what a claim that cannot be read leaves to say. */
export function describeAutoMigrationRunning(running: AutoMigrationRunning): string {
  return running.pid !== null && running.since !== null
    ? `process ${running.pid}, since ${running.since}`
    : "its claim on this vault cannot be read right now";
}

/** What a live (not stale) claim says, for the reporting surfaces. */
export function readAutoMigrationRunning(
  vault: string,
  now: Date = new Date(),
  opts: AutoMigrationLockOptions = {},
): AutoMigrationRunning | null {
  const path = autoMigrationLockPath(vault);
  const decision = decideClaim(
    claimStateAt(path, now, { who: "read", judge: judgeOf(opts) }, "free"),
  );
  return decision.act === "running" ? { pid: decision.pid, since: decision.since } : null;
}

// ----- Failure and waiting state ------------------------------------------

/** One recorded failed attempt of the automatic migration. */
export interface AutoMigrationFailure {
  readonly state: "failed";
  /** ISO-8601 instant of the last failed attempt. */
  readonly failedAt: string;
  /** The failure, as the attempt reported it. */
  readonly error: string;
  /** Attempts in a row that failed, this one included. At least 1. */
  readonly consecutiveFailures: number;
  /** ISO-8601 instant from which an automatic attempt is due again. */
  readonly retryAfter: string;
  /** The command the operator can run instead of waiting. */
  readonly manualCommand: string;
  /**
   * True for the record an attempt writes BEFORE it starts
   * ({@link recordAutoMigrationAttempt}): the attempt has not reported
   * how it ended (it runs, it was killed, or it could not write its
   * outcome). It already carries the cooldown a failure would start, so
   * an attempt that cannot record its failure still holds the next ones
   * off.
   */
  readonly attempt: boolean;
  /**
   * The success outputs this attempt already wrote (the metrics row, the
   * brain log line, the one-time notice), each marked right after it was
   * written: a pass that finishes the attempt later writes only the ones
   * not marked, so an output that failed is retried on its own and none
   * is written twice.
   */
  readonly written: AutoMigrationSuccessWritten;
  /**
   * The run id of the stopped migration run's gate this attempt should
   * have opened and could not ({@link recordAutoMigrationGateOwed}), or
   * null: the next start opens it before anything else.
   */
  readonly gateOwed: string | null;
}

/** Which success outputs an attempt wrote (see {@link AutoMigrationFailure.written}). */
export interface AutoMigrationSuccessWritten {
  readonly row: boolean;
  readonly log: boolean;
  readonly notice: boolean;
}

/** The success outputs, by the key each is marked under. */
export type AutoMigrationSuccessOutput = keyof AutoMigrationSuccessWritten;

const NOTHING_WRITTEN: AutoMigrationSuccessWritten = Object.freeze({
  row: false,
  log: false,
  notice: false,
});

function writtenOf(raw: unknown): AutoMigrationSuccessWritten {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return NOTHING_WRITTEN;
  const r = raw as Record<string, unknown>;
  return { row: r["row"] === true, log: r["log"] === true, notice: r["notice"] === true };
}

/** A later machine whose first machine's cut has not arrived. */
export interface AutoMigrationWaiting {
  readonly state: "waiting";
  /** ISO-8601 instant the waiting state was last recorded. */
  readonly since: string;
  /** `<partition>/<shard>` entries the local store does not hold yet. */
  readonly missing: ReadonlyArray<string>;
  /** Devices whose completion record this machine waits on. */
  readonly firstMachines: ReadonlyArray<string>;
  /** What this machine waits for, in one operator sentence, when it is not a cut. */
  readonly reason: string | null;
  /**
   * It waits for a store another device created for this vault to arrive
   * (no store here yet): a start starts no worker for it until a store is
   * there, or until {@link AUTO_MIGRATION_WAIT_RECHECK_MS} after `since`.
   */
  readonly awaitsStore: boolean;
}

/**
 * How long a start trusts a remembered "waits for another device's store"
 * before a worker looks at the synced log again.
 */
export const AUTO_MIGRATION_WAIT_RECHECK_MS = 24 * 60 * 60_000;

/**
 * Whether a start still trusts the remembered wait for another device's
 * store at `now`: recorded less than a day ago (and not in the future).
 */
export function autoMigrationWaitStillFresh(waiting: AutoMigrationWaiting, now: Date): boolean {
  if (!waiting.awaitsStore) return false;
  const since = Date.parse(waiting.since);
  if (!Number.isFinite(since) || since > now.getTime() + 60_000) return false;
  return now.getTime() - since < AUTO_MIGRATION_WAIT_RECHECK_MS;
}

export type AutoMigrationState = AutoMigrationFailure | AutoMigrationWaiting;

function readStateRecord(vault: string): AutoMigrationState | null {
  const path = autoMigrationStatePath(vault);
  try {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      // Only an absent file is no record; a folder or file that cannot be
      // read is the damaged record below.
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      throw err;
    }
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== "object" || raw === null) throw new Error("not a JSON object");
    const r = raw as Record<string, unknown>;
    if (r["state"] === "waiting") {
      const missing = Array.isArray(r["missing"])
        ? r["missing"].filter((m): m is string => typeof m === "string")
        : [];
      const firstMachines = Array.isArray(r["first_machines"])
        ? r["first_machines"].filter((m): m is string => typeof m === "string")
        : [];
      return {
        state: "waiting",
        since: typeof r["since"] === "string" ? r["since"] : new Date(0).toISOString(),
        missing,
        firstMachines,
        reason: typeof r["reason"] === "string" ? r["reason"] : null,
        awaitsStore: r["awaits_store"] === true,
      };
    }
    if (r["state"] === "failed" && typeof r["error"] === "string") {
      const consecutive =
        typeof r["consecutive_failures"] === "number" && r["consecutive_failures"] >= 1
          ? Math.floor(r["consecutive_failures"])
          : 1;
      return {
        state: "failed",
        failedAt: typeof r["failed_at"] === "string" ? r["failed_at"] : new Date(0).toISOString(),
        error: r["error"],
        consecutiveFailures: consecutive,
        retryAfter:
          typeof r["retry_after"] === "string" ? r["retry_after"] : new Date(0).toISOString(),
        manualCommand:
          typeof r["manual_command"] === "string"
            ? r["manual_command"]
            : AUTO_MIGRATION_MANUAL_COMMAND,
        attempt: r["attempt"] === true,
        written: writtenOf(r["written"]),
        gateOwed: typeof r["gate_owed"] === "string" ? r["gate_owed"] : null,
      };
    }
    return null;
  } catch (err) {
    // A damaged record says a failure happened but not which: report it
    // as one, dated at the epoch, so it never blocks a retry either.
    return {
      state: "failed",
      failedAt: new Date(0).toISOString(),
      error: `unreadable automatic migration state (${messageOf(err)})`,
      consecutiveFailures: 1,
      retryAfter: new Date(0).toISOString(),
      manualCommand: AUTO_MIGRATION_MANUAL_COMMAND,
      attempt: false,
      written: NOTHING_WRITTEN,
      gateOwed: null,
    };
  }
}

/** The recorded failure, or null when none (or a waiting state) is recorded. */
export function readAutoMigrationFailure(vault: string): AutoMigrationFailure | null {
  const state = readStateRecord(vault);
  return state?.state === "failed" ? state : null;
}

/** The recorded waiting state, or null when none (or a failure) is recorded. */
export function readAutoMigrationWaiting(vault: string): AutoMigrationWaiting | null {
  const state = readStateRecord(vault);
  return state?.state === "waiting" ? state : null;
}

/**
 * Whether an automatic attempt must wait: a failure is recorded and its
 * cooldown has not run out at `now`. The same rule as the other workers
 * (`selfHealUpgradeBackoffActive`), on this state file's shape: a marker
 * this build did not write (dated in the future) never holds the
 * attempt off, and a cooldown longer than the longest one never applies.
 */
export function autoMigrationBackoffActive(
  failure: AutoMigrationFailure | null,
  now: Date,
): boolean {
  if (failure === null) return false;
  const until = Date.parse(failure.retryAfter);
  if (!Number.isFinite(until)) return false;
  const failedAt = Date.parse(failure.failedAt);
  if (!Number.isFinite(failedAt) || failedAt > now.getTime()) return false;
  return now.getTime() < Math.min(until, failedAt + SELF_HEAL_UPGRADE_MAX_COOLDOWN_MS);
}

function writeFailure(
  vault: string,
  error: string,
  opts: {
    manualCommand: string;
    now: Date;
    attempt: boolean;
    consecutiveFailures: number;
    gateOwed?: string;
    written?: AutoMigrationSuccessWritten;
  },
): AutoMigrationFailure {
  const written = opts.written ?? NOTHING_WRITTEN;
  const anyWritten = written.row || written.log || written.notice;
  const retryAfter = new Date(
    opts.now.getTime() + selfHealUpgradeCooldownMs(opts.consecutiveFailures),
  );
  const text = reportableText(error);
  const record = {
    state: "failed",
    failed_at: opts.now.toISOString(),
    error: text,
    consecutive_failures: opts.consecutiveFailures,
    retry_after: retryAfter.toISOString(),
    manual_command: opts.manualCommand,
    ...(opts.attempt ? { attempt: true } : {}),
    ...(opts.gateOwed !== undefined ? { gate_owed: opts.gateOwed } : {}),
    ...(anyWritten ? { written } : {}),
  };
  const path = autoMigrationStatePath(vault);
  writeStateFile(path, JSON.stringify(record, null, 2) + "\n");
  return {
    state: "failed",
    failedAt: record.failed_at,
    error: text,
    consecutiveFailures: opts.consecutiveFailures,
    retryAfter: record.retry_after,
    manualCommand: opts.manualCommand,
    attempt: opts.attempt,
    written,
    gateOwed: opts.gateOwed ?? null,
  };
}

/**
 * Record a failure a START saw (a worker that could not be started, or
 * that exited before it confirmed its claim), under the claim it holds,
 * with the same count and cooldown as any failure. A record an earlier
 * attempt left keeps what it says beyond its reason (that it is an
 * attempt's, the gate it owes, the success outputs it wrote), so what
 * the next start finishes is unchanged.
 */
function recordStartSeenFailure(vault: string, reason: string, now: Date): AutoMigrationFailure {
  const previous = readAutoMigrationFailure(vault);
  return writeFailure(vault, reason, {
    manualCommand: AUTO_MIGRATION_MANUAL_COMMAND,
    now,
    attempt: previous?.attempt === true,
    consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
    ...(previous?.gateOwed != null ? { gateOwed: previous.gateOwed } : {}),
    written: previous?.written ?? NOTHING_WRITTEN,
  });
}

/**
 * Record that the worker a start spawned exited before it confirmed its
 * claim ({@link describeLostAutoMigrationWorker}). The caller holds the
 * claim (or its mutex).
 */
export function recordLostAutoMigrationWorker(
  vault: string,
  worker: LostAutoMigrationWorker,
  now: Date,
  exit: string | null = null,
): AutoMigrationFailure {
  return recordStartSeenFailure(vault, describeLostAutoMigrationWorker(vault, worker, exit), now);
}

/** Record that a start could not start the worker at all. The caller holds the claim. */
export function recordAutoMigrationSpawnFailure(
  vault: string,
  error: string,
  now: Date,
): AutoMigrationFailure {
  return recordStartSeenFailure(
    vault,
    `the automatic migration worker could not be started: ${error}`,
    now,
  );
}

/**
 * The consecutive count a new failure continues: a recorded failure's
 * count, including the one an unfinished attempt left (it counted itself
 * when it started), never an attempt's own record twice.
 */
function previousFailures(vault: string, replacingAttempt: boolean): number {
  const previous = readAutoMigrationFailure(vault);
  if (previous === null) return 0;
  // The record this attempt wrote when it started already counts it.
  if (replacingAttempt && previous.attempt) return previous.consecutiveFailures - 1;
  return previous.consecutiveFailures;
}

/**
 * Record a failed attempt; the cooldown doubles with each consecutive
 * failure. The reason is reduced for the surfaces it reaches
 * ({@link reportableText}).
 */
export function recordAutoMigrationFailure(
  vault: string,
  error: string,
  opts: { manualCommand: string; now: Date },
): AutoMigrationFailure {
  return writeFailure(vault, error, {
    ...opts,
    attempt: false,
    consecutiveFailures: previousFailures(vault, true) + 1,
  });
}

/**
 * Record, before an attempt starts, that it has not reported how it
 * ended yet: a failure record with the cooldown the attempt would start
 * if it failed. The attempt replaces it with its real outcome (cleared on
 * success, a waiting state, or the failure with its reason). When the
 * attempt is killed, or cannot write its outcome (a full disk), this
 * record stays: the next starts do not spawn a worker each, and the
 * doctor names an attempt that did not finish. Throws when it cannot be
 * written; the caller then starts nothing.
 */
export function recordAutoMigrationAttempt(vault: string, now: Date): AutoMigrationFailure {
  return writeFailure(
    vault,
    `the automatic attempt that started at ${now.toISOString()} did not report how it ended ` +
      "(the worker stopped, or could not write its outcome)",
    {
      manualCommand: AUTO_MIGRATION_MANUAL_COMMAND,
      now,
      attempt: true,
      consecutiveFailures: previousFailures(vault, false) + 1,
    },
  );
}

/**
 * Record that an attempt switched this machine and then failed before
 * its last steps (or its success records): the record stays an attempt's,
 * so the next start finishes the switch at once instead of waiting out a
 * cooldown, and names the reason meanwhile.
 */
export function recordAutoMigrationUnfinishedSwitch(
  vault: string,
  reason: string,
  now: Date,
): AutoMigrationFailure {
  return writeFailure(vault, `the switch to the brain store did not finish: ${reason}`, {
    manualCommand: AUTO_MIGRATION_MANUAL_COMMAND,
    now,
    attempt: true,
    consecutiveFailures: previousFailures(vault, true) + 1,
  });
}

/**
 * Record that the gate a stopped run (`runId`) left on this vault could
 * not be opened: the attempt's outcome (a refusal, a wait) would let the
 * next start honour the opt-out or a cooldown while that gate still
 * refuses every content write. The record stays an attempt's, so the next
 * start recovers it at once (`attemptMustBeRecovered`), until a pass sees
 * the gate gone. The count the record carries is kept.
 */
export function recordAutoMigrationGateOwed(
  vault: string,
  runId: string,
  reason: string,
  now: Date,
): AutoMigrationFailure {
  return writeFailure(
    vault,
    `the migration gate run ${runId} left on this vault could not be opened yet (${reason}); ` +
      "the next start opens it",
    {
      manualCommand: AUTO_MIGRATION_MANUAL_COMMAND,
      now,
      attempt: true,
      consecutiveFailures: Math.max(1, previousFailures(vault, false)),
      gateOwed: runId,
    },
  );
}

/**
 * The gate an attempt owed (run `runId`) is gone: its record becomes the
 * failure it stands for, its cooldown kept, no longer an attempt that owes
 * a gate. Any other record is left as it is.
 */
export function settleAutoMigrationGateOwed(vault: string, runId: string): void {
  const path = autoMigrationStatePath(vault);
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;
  const record = { ...(raw as Record<string, unknown>) };
  if (record["gate_owed"] !== runId) return;
  delete record["gate_owed"];
  delete record["attempt"];
  writeStateFile(path, JSON.stringify(record, null, 2) + "\n");
}

/** Record (or refresh) the waiting state of a later machine. No cooldown. */
export function recordAutoMigrationWaiting(
  vault: string,
  wait: {
    missing: ReadonlyArray<string>;
    firstMachines: ReadonlyArray<string>;
    reason?: string | null;
    awaitsStore?: boolean;
  },
  now: Date,
): AutoMigrationWaiting {
  const reason = wait.reason === undefined || wait.reason === null ? null : wait.reason;
  const record = {
    state: "waiting",
    since: now.toISOString(),
    missing: [...wait.missing],
    first_machines: [...wait.firstMachines],
    ...(reason !== null ? { reason: reportableText(reason) } : {}),
    ...(wait.awaitsStore === true ? { awaits_store: true } : {}),
  };
  const path = autoMigrationStatePath(vault);
  writeStateFile(path, JSON.stringify(record, null, 2) + "\n");
  return {
    state: "waiting",
    since: record.since,
    missing: record.missing,
    firstMachines: record.first_machines,
    reason: record.reason ?? null,
    awaitsStore: wait.awaitsStore === true,
  };
}

/**
 * Mark on the attempt's record that the success output `output` was
 * written ({@link AutoMigrationFailure.written}). Throws when there is no
 * record or it cannot be written.
 */
export function markAutoMigrationSuccessWritten(
  vault: string,
  output: AutoMigrationSuccessOutput,
): void {
  const path = autoMigrationStatePath(vault);
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("not a JSON object");
  }
  const record = raw as Record<string, unknown>;
  const written = { ...writtenOf(record["written"]), [output]: true };
  writeStateFile(path, JSON.stringify({ ...record, written }, null, 2) + "\n");
}

/** Drop the state record once nothing of it is left (success, or moot). */
export function clearAutoMigrationState(vault: string): void {
  try {
    unlinkSync(autoMigrationStatePath(vault));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  pruneAutoMigrationStateDir(vault);
}

export function clearAutoMigrationFailure(vault: string): void {
  if (readAutoMigrationFailure(vault) !== null) clearAutoMigrationState(vault);
}

export function clearAutoMigrationWaiting(vault: string): void {
  if (readAutoMigrationWaiting(vault) !== null) clearAutoMigrationState(vault);
}

/**
 * One-line operator description of a recorded failure, for the doctor,
 * the status block and the session start notice.
 */
export function describeAutoMigrationFailure(
  failure: AutoMigrationFailure,
  opts: { readonly retries?: boolean } = {},
): string {
  // With the automatic migration off no start retries it: the schedule is
  // left out, the reason and the manual command stay.
  const retry =
    opts.retries === false ? "" : `, next automatic attempt after ${printable(failure.retryAfter)}`;
  return (
    `the automatic store migration failed at ${printable(failure.failedAt)}: ` +
    `${reportableText(failure.error)}; ${failure.consecutiveFailures} consecutive failure(s)` +
    `${retry}; run \`${failure.manualCommand}\` to run it yourself`
  );
}

/**
 * Reported to a terminal and injected into a session, so control
 * characters are replaced before they reach either.
 */
export function printable(text: string): string {
  // oxlint-disable-next-line no-control-regex -- matching control characters is the point
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

/** Home directories as this process sees them, longest first. */
function homeDirs(): string[] {
  const dirs = new Set<string>();
  for (const value of [process.env["HOME"], process.env["USERPROFILE"]]) {
    if (value !== undefined && value.trim().length > 1) dirs.add(value.replace(/[\\/]+$/, ""));
  }
  try {
    const home = homedir();
    if (home.length > 1) dirs.add(home.replace(/[\\/]+$/, ""));
  } catch {
    // no home directory known
  }
  return [...dirs].toSorted((a, b) => b.length - a.length);
}

/** `/home/<name>`, `/Users/<name>` and the like, wherever they appear. */
const HOME_PATTERN = /[\\/](?:home|Users|users)[\\/][^\\/\s"'`;,)]+/g;

/** `C:\\Users\\<name>` in any case, wherever it appears: Windows paths are not case-sensitive. */
const WINDOWS_HOME_PATTERN = /[A-Za-z]:[\\/]users[\\/][^\\/\s"'`;,)]+/gi;

/** `text` with every occurrence of `home` reduced to `~`, in any case on Windows. */
function withoutHome(text: string, home: string, platform: NodeJS.Platform): string {
  if (platform !== "win32") return text.split(home).join("~");
  const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(escaped, "gi"), "~");
}

/**
 * A failure or waiting reason as it may be kept and shown.
 *
 * What it reduces: control characters (replaced by spaces); every home
 * directory this process knows (`HOME`, `USERPROFILE`, `os.homedir()`)
 * wherever it appears (in any case on Windows, whose paths are not
 * case-sensitive), and any `/home/<name>`, `/Users/<name>` or
 * `<drive>:\Users\<name>` path (the last in any case), to `~`; and the
 * length, to 2000 characters.
 *
 * What it does not reduce: a path that names the account some other way
 * (`D:\data\<name>\...`, a `\\server\homes\<name>` share,
 * `/var/folders/.../T/...`, a store root or vault the person placed
 * elsewhere), and a user name that appears outside a path. It is a
 * courtesy for local display, not a privacy boundary: the text is kept
 * only in this machine's device-local state, shown by the doctor, the
 * status block and the local terminal, and injected into this machine's
 * session digest. Nothing that leaves the machine carries it: the brain
 * log line names no path and the metrics rows carry no text.
 */
export function reportableText(text: string): string {
  return reportableTextFor(text, process.platform, homeDirs());
}

/**
 * {@link reportableText} with the platform and the known home directories
 * as inputs: pure, so the Windows rule and the case-sensitive rule can be
 * checked on any platform.
 */
export function reportableTextFor(
  text: string,
  platform: NodeJS.Platform,
  homes: readonly string[],
): string {
  let out = printable(text);
  const known = homes
    .map((home) => home.replace(/[\\/]+$/, ""))
    .filter((home) => home.trim().length > 1)
    .toSorted((a, b) => b.length - a.length);
  for (const home of known) out = withoutHome(out, home, platform);
  out = out.replace(WINDOWS_HOME_PATTERN, "~").replace(HOME_PATTERN, "~");
  return out.length <= REPORTABLE_TEXT_CHARS
    ? out
    : `${out.slice(0, REPORTABLE_TEXT_CHARS - 3)}...`;
}

/** Longest reason kept in the state file. */
const REPORTABLE_TEXT_CHARS = 2000;

// ----- One-time success notice ---------------------------------------------

/** The one-time success notice's content. */
export interface AutoMigrationNotice {
  /** ISO-8601 instant the migration succeeded. */
  readonly at: string;
  /** The migration snapshot's run id, where the pre-migration copy lives; null when none was taken. */
  readonly snapshot: string | null;
  /** How to undo the switch, spelled for the surfaces that show it. */
  readonly rollbackCommand: string;
}

/**
 * Record the one-time success notice of the run `runId`; the next session
 * start shows it. Not written again for a run whose notice a session
 * already showed ({@link clearAutoMigrationNotice}).
 */
export function recordAutoMigrationNotice(
  vault: string,
  notice: { snapshot: string | null; runId?: string | null },
  now: Date,
): void {
  const run = notice.runId ?? "";
  if (noticeConsumedFor(vault) === run) return;
  const snapshot =
    notice.snapshot === null || notice.snapshot.trim() === "" ? null : notice.snapshot;
  const written = {
    at: now.toISOString(),
    run_id: run,
    snapshot,
    rollback_command: AUTO_MIGRATION_ROLLBACK_COMMAND,
  };
  writeStateFile(autoMigrationNoticePath(vault), JSON.stringify(written, null, 2) + "\n");
}

function readNoticeRecord(vault: string): Record<string, unknown> | null {
  const path = autoMigrationNoticePath(vault);
  if (!existsSync(path)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    return raw as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The run whose notice a session showed while its attempt was unfinished, or null. */
function noticeConsumedFor(vault: string): string | null {
  const r = readNoticeRecord(vault);
  return r !== null && typeof r["consumed_run"] === "string" ? r["consumed_run"] : null;
}

/**
 * The notice to show, or null when there is none: no file, a file that is
 * not a plain JSON object, a record whose `at` is not a time, or the mark
 * of a notice already shown. `snapshot: null` is a notice (a run without
 * a snapshot).
 */
export function readAutoMigrationNotice(vault: string): AutoMigrationNotice | null {
  const r = readNoticeRecord(vault);
  if (r === null || typeof r["at"] !== "string" || !Number.isFinite(Date.parse(r["at"]))) {
    return null;
  }
  const snapshot =
    typeof r["snapshot"] === "string" && r["snapshot"].trim() !== "" ? r["snapshot"] : null;
  return {
    at: r["at"],
    snapshot,
    rollbackCommand:
      typeof r["rollback_command"] === "string"
        ? r["rollback_command"]
        : AUTO_MIGRATION_ROLLBACK_COMMAND,
  };
}

/**
 * Drop the notice once a session start has shown it. While the attempt
 * that wrote it has not finished (its record is still there), the file is
 * replaced by a mark naming the run, so a pass that finishes that attempt
 * does not write the same notice again; the pass drops the mark when it
 * clears the attempt ({@link dropShownAutoMigrationNotice}).
 */
export function clearAutoMigrationNotice(vault: string): void {
  const record = readNoticeRecord(vault);
  const attempt = readAutoMigrationFailure(vault)?.attempt === true;
  // Already cleared by another session while the attempt is unfinished:
  // the mark stays, so the notice is not published again.
  if (attempt && record !== null && typeof record["consumed_run"] === "string") return;
  if (attempt && record !== null && typeof record["run_id"] === "string") {
    writeStateFile(
      autoMigrationNoticePath(vault),
      JSON.stringify({ consumed_run: record["run_id"] }, null, 2) + "\n",
    );
    return;
  }
  try {
    unlinkSync(autoMigrationNoticePath(vault));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  pruneAutoMigrationStateDir(vault);
}

/**
 * Consume the one-time success notice a session start rendered (the one
 * whose `at` is `at`), after the session's text is assembled: the session
 * whose consumption succeeds shows it, and no other, so two sessions that
 * start at once never both show it. The notice file is renamed to a name
 * of this process's own, and only one rename wins. A file that is not
 * that notice (a newer one, or the mark of one already shown) is put back
 * unless something took its place meanwhile. Then, as
 * {@link clearAutoMigrationNotice} does: while the attempt that wrote it is
 * unfinished, a mark naming its run stays, so a pass that finishes the
 * attempt does not publish it again. Never throws; false keeps the notice
 * for a later session.
 */
export function consumeAutoMigrationNotice(
  vault: string,
  at: string,
  hooks: { readonly afterRename?: () => void } = {},
): boolean {
  const path = autoMigrationNoticePath(vault);
  const claimed = `${path}${CLAIMED_NOTICE_INFIX}${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    renameSync(path, claimed);
  } catch {
    // Another session consumed it, or it cannot be moved now.
    return false;
  }
  hooks.afterRename?.();
  const record = readJsonRecord(claimed);
  if (record === null || record["at"] !== at) {
    putBack(claimed, path);
    return false;
  }
  try {
    if (readAutoMigrationFailure(vault)?.attempt === true && typeof record["run_id"] === "string") {
      // Never over a notice a worker wrote since the rename: that one is
      // newer and still to be shown.
      placeIfAbsent(
        path,
        `${claimed}.mark`,
        JSON.stringify({ consumed_run: record["run_id"] }, null, 2) + "\n",
      );
    }
  } catch {
    // Best effort: without the mark, the pass that finishes the attempt
    // may publish the notice once more.
  }
  try {
    unlinkSync(claimed);
  } catch {
    // left for the next session start ({@link recoverClaimedAutoMigrationNotices})
  }
  pruneAutoMigrationStateDir(vault);
  return true;
}

/** The infix of a notice a session start claimed: `<notice>.shown-<pid>-<hex>`. */
const CLAIMED_NOTICE_INFIX = ".shown-";

/** The JSON object in `path`, or null (absent, unreadable, not an object). */
function readJsonRecord(path: string): Record<string, unknown> | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Write `text` to `path` only when nothing is there: written to `temp`
 * first and hard-linked in, so a file that appeared at `path` meanwhile is
 * never replaced. Returns whether it was placed.
 */
function placeIfAbsent(path: string, temp: string, text: string): boolean {
  writeFileSync(temp, text);
  try {
    linkSync(temp, path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // already gone
    }
  }
}

/**
 * Give back what a session start that died while it consumed the notice
 * left (`<notice>.shown-<pid>-<hex>`, and its `.mark` scratch file), so
 * nothing a worker wrote is lost: the session died before it showed the
 * notice (a session shows it only after the consume returns). Run by a
 * session start before it reads the notice. For each claimed file whose
 * process is gone: with no notice in place it is put back; in place of the
 * mark that session wrote for the same run it is put back over that mark
 * (shown now, it is marked again); beside a newer notice or another mark
 * it is dropped. A claimed file of a live process (a session consuming
 * right now, or a pid reused since) is left alone; such a leftover costs
 * one small file in the device-local folder until its pid is gone. Never
 * throws.
 */
export function recoverClaimedAutoMigrationNotices(vault: string): void {
  const path = autoMigrationNoticePath(vault);
  const prefix = `${AUTO_MIGRATION_NOTICE_FILE}${CLAIMED_NOTICE_INFIX}`;
  let names: string[];
  try {
    names = readdirSync(dirname(path)).filter((n) => n.startsWith(prefix));
  } catch {
    return;
  }
  for (const name of names) {
    const pid = Number.parseInt(name.slice(prefix.length), 10);
    if (processAlive(pid)) continue;
    const leftover = join(dirname(path), name);
    try {
      if (name.endsWith(".mark") || name.endsWith(".aside")) {
        unlinkSync(leftover);
        continue;
      }
      // Claimed again under this process's own name, by one rename: two
      // starts that recover at once never both work on it.
      const claimed = `${path}${CLAIMED_NOTICE_INFIX}${process.pid}-${randomBytes(4).toString("hex")}`;
      renameSync(leftover, claimed);
      recoverClaimed(claimed, path);
    } catch {
      // left for the next session start
    }
  }
  pruneAutoMigrationStateDir(vault);
}

function recoverClaimed(claimed: string, path: string): void {
  const notice = readJsonRecord(claimed);
  const runId = typeof notice?.["run_id"] === "string" ? notice["run_id"] : null;
  const current = readJsonRecord(path);
  if (!existsSync(path)) {
    putBack(claimed, path);
    return;
  }
  if (notice !== null && current !== null && runId !== null && current["consumed_run"] === runId) {
    // The mark that session wrote for this very notice: moved aside by one
    // atomic rename, so a notice written meanwhile is never lost.
    const aside = `${claimed}.aside`;
    renameSync(path, aside);
    if (readJsonRecord(aside)?.["consumed_run"] !== runId) {
      putBack(aside, path);
      unlinkSync(claimed);
      return;
    }
    unlinkSync(aside);
    putBack(claimed, path);
    return;
  }
  unlinkSync(claimed);
}

/** Move a claimed file back to `path`, unless something took its place. Never throws. */
function putBack(claimed: string, path: string): void {
  try {
    // A hard link never replaces a file that appeared at `path`.
    linkSync(claimed, path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST" && !existsSync(path)) {
      try {
        renameSync(claimed, path);
        return;
      } catch {
        // lost: the attempt's pass writes an unshown notice again
      }
    }
  }
  try {
    unlinkSync(claimed);
  } catch {
    // already gone
  }
}

/** Drop the mark of a notice already shown, once its attempt is finished. Never throws. */
export function dropShownAutoMigrationNotice(vault: string): void {
  if (noticeConsumedFor(vault) === null) return;
  try {
    unlinkSync(autoMigrationNoticePath(vault));
  } catch {
    // already gone
  }
  pruneAutoMigrationStateDir(vault);
}
