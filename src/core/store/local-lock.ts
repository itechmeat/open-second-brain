/**
 * Device-local advisory lock for the brain store (design D2).
 *
 * Every lock the store takes lives in the device-local state directory,
 * never inside the synced store: a lock file that a sync tool copies to
 * another machine would either block that machine or be deleted under the
 * holder. The lock is held only for the short critical section it guards
 * (one shard append, one clock tick).
 *
 * Built on `proper-lockfile`'s directory lock, the same primitive the log
 * appender and the device-id generator use, because it recovers from a
 * crashed holder: a lock directory older than {@link STORE_LOCK_STALE_MS}
 * is taken over. The synchronous lock never refreshes its age while held,
 * so the window has to outlast any critical section a live holder can be
 * stuck in: one append and its fsync are milliseconds long, but a paused
 * VM, an antivirus scan or a stalled disk can hold one for many seconds,
 * and taking such a lock over would let two writers interleave in one
 * shard. Sixty seconds, the window the vault writer lock uses
 * (`brain/sync-lockfile.ts`). The directory form works the same on
 * Windows, where it needs no handle kept open.
 *
 * The wait is bounded by the shared lock budget
 * (`OPEN_SECOND_BRAIN_LOCK_WAIT_MS`, five seconds by default) and is a
 * blocking sleep, like every other synchronous lock in this tree. The
 * synchronous store work of a long background operation (a dream pass's
 * apply step, its session's take and answer calls) waits up to two
 * minutes instead ({@link withBackgroundLockWait}). A holder records
 * itself beside the lock ({@link LOCK_HOLDER_SUFFIX}), so a waiter that
 * gives up names it.
 *
 * On Windows a released lock directory lingers in a "delete pending" state
 * until the last handle closes, and a `mkdir` of that name meanwhile fails
 * with `EPERM` instead of `EEXIST`. The attempt ({@link lockDirSync},
 * `fs-lock.ts`) counts that as a held lock, so a writer that loses a race
 * to a releasing holder waits its turn within the same budget, however
 * often it loses; a directory that refuses new entries fails at once.
 */

import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import { resolveLockWaitBudgetMs } from "../brain/sync-lockfile.ts";
import { renameWithRetry, sleepSync } from "../fs-atomic.ts";
import { lockDirSync } from "../fs-lock.ts";

/** Age after which a lock directory counts as abandoned by a crashed holder. */
export const STORE_LOCK_STALE_MS = 60_000;

/** Upper bound of one sleep between attempts. */
const RETRY_SLEEP_MAX_MS = 20;

/** How long a wait keeps the shortening sleeps that favour the oldest waiter. */
const FAIR_WAIT_MS = 1_000;

/** The longest sleep of a waiter's first attempt. */
const FAIR_SLEEP_MAX_MS = 8;

/**
 * The longest wait of a store lock inside a long background operation (a
 * dream pass, its session's server): two minutes. The five-second default
 * fits a hook or a tool call of a live session, which a person waits on;
 * a pass has minutes of budget, and failing it because a busy device
 * clock stayed held for a few seconds throws its last writes away. Two
 * minutes is still a bound: a lock held that long is stuck, and the
 * refusal names its holder.
 */
export const BACKGROUND_LOCK_WAIT_MS = 120_000;

/** How the store locks of a background operation's synchronous work wait. */
export interface BackgroundLockWait {
  /** Longest total wait of one lock (default {@link BACKGROUND_LOCK_WAIT_MS}). */
  readonly budgetMs?: number;
  /** Clock of the wait (default `Date.now`). */
  readonly now?: () => number;
  /** The sleep between attempts (default a blocking sleep). */
  readonly sleep?: (ms: number) => void;
}

/** The wait of the synchronous call {@link withBackgroundLockWait} runs now, if any. */
let background: BackgroundLockWait | null = null;

/**
 * Run the synchronous `fn` with every store lock it takes without its own
 * budget waiting as a long background operation does: at least
 * {@link BACKGROUND_LOCK_WAIT_MS} (a longer `OPEN_SECOND_BRAIN_LOCK_WAIT_MS`
 * still wins), retrying a busy lock with jittered sleeps the whole time.
 *
 * The wait is set for the synchronous run of `fn` only and restored before
 * this returns. `fn` cannot yield (a promise it returned is refused), so
 * nothing else in the process runs while the wait is set: a timer, a
 * stdin handler or another request of the same process takes its locks
 * with its own bound, never this one. A lock that passes its own budget
 * (the dream pass lock's mutex, the topic plan lock) keeps it too.
 */
export function withBackgroundLockWait<T>(fn: () => T, wait: BackgroundLockWait = {}): T {
  const previous = background;
  background = wait;
  let out: T;
  try {
    out = fn();
  } finally {
    background = previous;
  }
  if (typeof (out as { then?: unknown } | null)?.then === "function") {
    // The refused work still runs; its failure must not surface later as
    // an unhandled rejection that ends the process.
    (out as PromiseLike<unknown>).then(undefined, () => {});
    throw new TypeError("withBackgroundLockWait runs synchronous work only");
  }
  return out;
}

/** The wait budget of a store lock taken without its own budget. */
export function storeLockWaitMs(): number {
  const configured = resolveLockWaitBudgetMs();
  if (background === null) return configured;
  return Math.max(configured, background.budgetMs ?? BACKGROUND_LOCK_WAIT_MS);
}

/**
 * A store lock that stayed held past its wait. `holder` names who holds
 * it when the lock records that (`null` when it does not).
 */
export class LockBusyError extends Error {
  readonly code = "ELOCKED";
  readonly path: string;
  readonly holder: string | null;

  constructor(message: string, path: string, holder: string | null, cause: unknown) {
    super(message, { cause });
    this.name = "LockBusyError";
    this.path = path;
    this.holder = holder;
  }
}

/** Whether `err` is a store lock that stayed busy past its wait. */
export function isLockBusy(err: unknown): err is LockBusyError {
  return err instanceof LockBusyError;
}

/**
 * Suffix of the record a holder writes beside its lock directory: who
 * holds the lock and since when, read by a waiter that gives up. Beside
 * the directory, not inside it, so the library's removal of an abandoned
 * lock (an `rmdir`) still works.
 */
export const LOCK_HOLDER_SUFFIX = ".lock-holder";

interface DirLockHolder {
  readonly pid: number;
  readonly command: string;
  readonly at: number;
  /** Inode of the lock directory this record belongs to. */
  readonly lock: number;
}

function holderPath(lockTarget: string): string {
  return `${resolve(lockTarget)}${LOCK_HOLDER_SUFFIX}`;
}

function lockDirPath(lockTarget: string): string {
  return `${resolve(lockTarget)}.lock`;
}

function processCommand(): string {
  const script = process.argv[1];
  const name = script !== undefined && script !== "" ? basename(script) : basename(process.argv0);
  const verb = process.argv.slice(2, 4).filter((a) => !a.startsWith("-"));
  return [name, ...verb].join(" ").slice(0, 120);
}

/**
 * Write this process as the holder of `lockTarget`, just taken: through a
 * temporary file and a rename, so a waiter never reads half a record, and
 * tied to the inode of the lock directory, so a record left by an earlier
 * holder (a killed process, a binary that writes none) is never taken for
 * the current one's. The rename replaces the record of a dead holder whose
 * lock was taken over; when the new record cannot be written, the old one
 * is removed instead. Informational: never fails the lock. Returns the
 * text written, for {@link forgetHolder}, or `null` when none was.
 */
function recordHolder(lockTarget: string): string | null {
  const path = holderPath(lockTarget);
  try {
    const holder: DirLockHolder = {
      pid: process.pid,
      command: processCommand(),
      at: Date.now(),
      lock: statSync(lockDirPath(lockTarget)).ino,
    };
    const text = `${JSON.stringify(holder)}\n`;
    const tmp = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
    try {
      renameWithRetry(tmp, path);
    } catch (err) {
      unlinkQuietly(tmp);
      throw err;
    }
    return text;
  } catch {
    // The record only explains a refusal: one that cannot be written is
    // dropped, so no earlier holder's stays to be read as this one's.
    unlinkQuietly(path);
    return null;
  }
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // gone already, or refused for a moment on Windows
  }
}

/**
 * Remove this holder's record on release, and only its own: a holder
 * slow enough to have its lock taken over (older than
 * {@link STORE_LOCK_STALE_MS}) finds the new holder's record there, which
 * names another process, time or lock directory inode, and leaves it.
 */
function forgetHolder(lockTarget: string, written: string | null): void {
  if (written === null) return;
  const path = holderPath(lockTarget);
  try {
    if (readFileSync(path, "utf8") !== written) return;
  } catch {
    return;
  }
  unlinkQuietly(path);
}

/** Whether process `pid` still runs (a process this user may not signal still runs). */
export function pidRuns(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Who holds `lockTarget`, as its holder recorded it, or `null` when no
 * record belongs to the lock now held (none written, one being written,
 * or one left by an earlier holder of another lock directory). When its
 * process no longer runs, the description adds the age at which the lock
 * is taken over; the takeover itself goes by that age alone
 * ({@link STORE_LOCK_STALE_MS}), whether or not the holder runs.
 */
export function describeLockHolder(lockTarget: string, now: number = Date.now()): string | null {
  let holder: DirLockHolder;
  try {
    const parsed = JSON.parse(
      readFileSync(holderPath(lockTarget), "utf8"),
    ) as Partial<DirLockHolder>;
    if (
      typeof parsed.pid !== "number" ||
      typeof parsed.at !== "number" ||
      typeof parsed.lock !== "number"
    ) {
      return null;
    }
    holder = {
      pid: parsed.pid,
      command: String(parsed.command ?? ""),
      at: parsed.at,
      lock: parsed.lock,
    };
    if (statSync(lockDirPath(lockTarget)).ino !== holder.lock) return null;
  } catch {
    return null;
  }
  const since = new Date(holder.at).toISOString();
  const held = Math.max(0, Math.round((now - holder.at) / 1000));
  const who = `process ${holder.pid}${holder.command !== "" ? ` (${holder.command})` : ""}`;
  return pidRuns(holder.pid)
    ? `held by ${who} since ${since} (${held} s)`
    : `held by ${who} since ${since}, which no longer runs; the lock is taken over once it is ` +
        `${STORE_LOCK_STALE_MS / 1000} s old`;
}

/**
 * Whether a failed acquire means another holder has the lock: the
 * `ELOCKED` every attempt here reports for a held lock, Windows'
 * delete-pending answer included ({@link lockDirSync}).
 */
export function isLockContention(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "ELOCKED";
}

/** How {@link acquireDirLock} waits and what its refusal says. */
export interface DirLockOptions {
  /** Age after which the lock directory counts as abandoned. */
  readonly staleMs: number;
  /** Longest total wait before giving up with `ELOCKED`. */
  readonly budgetMs: number;
  /** What the refusal calls the lock ("store lock", "log lock"). */
  readonly label: string;
  /** What the refusal tells the operator to do next. */
  readonly remedy: string;
  /** Clock of the wait (default: the background wait's, else `Date.now`). */
  readonly now?: () => number;
  /** The sleep between attempts (default: the background wait's, else a blocking sleep). */
  readonly sleep?: (ms: number) => void;
}

/**
 * Take the `proper-lockfile` directory lock of `lockTarget`
 * (`<lockTarget>.lock`), waiting with jittered, growing sleeps while it is
 * held, and return its release. Throws an `ELOCKED` error naming the
 * target when the lock stays held past the budget; a directory that
 * refuses new entries throws `LockDirectoryRefusedError` at once, and any
 * other failure is rethrown as it is.
 */
export function acquireDirLock(lockTarget: string, options: DirLockOptions): () => void {
  const now = options.now ?? background?.now ?? Date.now;
  const sleep = options.sleep ?? background?.sleep ?? sleepSync;
  const started = now();
  for (let attempt = 0; ; attempt++) {
    let release: () => void;
    try {
      release = lockDirSync(lockTarget, { stale: options.staleMs });
    } catch (err) {
      if (!isLockContention(err)) throw err;
      const waited = now() - started;
      if (waited >= options.budgetMs) {
        const holder = describeLockHolder(lockTarget);
        throw new LockBusyError(
          `${options.label} busy: ${lockTarget}: ` +
            `${holder ?? "its holder is not recorded"}, still held after waiting ` +
            `${waited} ms; ${options.remedy}`,
          lockTarget,
          holder,
          err,
        );
      }
      // Jittered sleep, so waiters do not wake in lockstep, that shortens
      // as the wait grows for the first second: a waiter that has waited
      // longer retries sooner than one that just arrived, so under a
      // stream of short holds (the device clock's ticks, a flush each) the
      // oldest waiter takes the lock instead of starving behind newcomers.
      // Past that the holder is slow, not busy, and the sleep grows again
      // so a long wait costs few attempts.
      const ceiling =
        waited < FAIR_WAIT_MS
          ? Math.max(1, FAIR_SLEEP_MAX_MS - attempt)
          : Math.min(RETRY_SLEEP_MAX_MS, 2 + attempt * 2);
      sleep(1 + Math.floor(Math.random() * ceiling));
      continue;
    }
    const written = recordHolder(lockTarget);
    return () => {
      forgetHolder(lockTarget, written);
      release();
    };
  }
}

/**
 * Run `fn` while holding the device-local lock named by `lockTarget` (a
 * path inside the device-local state directory; the lock directory is
 * `<lockTarget>.lock`). Throws an `ELOCKED` error naming the target when
 * the lock stays held past the wait budget.
 */
export function withLocalLock<T>(lockTarget: string, fn: () => T, budgetMs?: number): T {
  mkdirSync(dirname(lockTarget), { recursive: true });
  const release = acquireDirLock(lockTarget, {
    staleMs: STORE_LOCK_STALE_MS,
    budgetMs: budgetMs ?? storeLockWaitMs(),
    label: "store lock",
    remedy:
      "retry once the other writer finishes, or allow a longer wait with " +
      "OPEN_SECOND_BRAIN_LOCK_WAIT_MS=<milliseconds>",
  });
  try {
    return fn();
  } finally {
    release();
  }
}
