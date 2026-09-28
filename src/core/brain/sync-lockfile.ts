/**
 * Synchronous lockfile primitive for the brain write path.
 *
 * The brain write path is sync end-to-end (`writePreference`, `dream`,
 * `moveToRetired`, `writeFrontmatterAtomic`) and migrating it to async
 * would touch every caller signature for one async-only ingredient.
 * Instead, this module provides a tiny single-attempt sync lock built
 * on `fs.openSync(target
 * + '.lock', 'wx')`. EEXIST surfaces as `Error` with
 * `.code === 'ELOCKED'`; the brain txn layer maps that to a
 * `BrainCollisionError({ kind: 'SourceLock' })`.
 *
 * No retry/backoff. Contention in OSB is rare (single operator, single
 * MCP server, dream runs from cron). When it does happen, we prefer a
 * loud typed error over a silent retry-then-still-fail loop.
 *
 * ## Why this exists beside `reliability/lock.ts`
 *
 * `withFileLock` there is the general-purpose ladder and it is ASYNC -
 * it awaits `proper-lockfile`. Every consumer of the waiting form here
 * (`updateManifest`, `appendGitRecords`, `recordCompleted`,
 * `generateRun`) is a synchronous function, and `ingestSource` above two
 * of them is synchronous on the published SDK surface, so awaiting a
 * lock would colour that function, its callers and the SDK contract.
 * Two ladders, two reasons; a reader who finds this one and wonders why
 * the other was not used is reading the right question, and this is the
 * answer.
 *
 * Stale-lock recovery: on normal process exit the cleanup hook unlinks
 * any still-held locks. On hard crash (SIGKILL, OOM, or the second
 * Ctrl-C that falls through to the default SIGINT disposition) the
 * `.lock` file stays on disk and the next acquire fails with ELOCKED;
 * the brain doctor surfaces these via {@link scanStaleLocks} so an
 * operator can remove them by hand.
 *
 * ## Why this lock has no stale window, when the search writer lock does
 *
 * `search/store/writer-lock.ts` treats a lock older than
 * `WRITER_LOCK_STALE_MS` (60 s) as abandoned and takes it over, so a
 * SIGKILL never wedges the index for longer than that. This lock
 * deliberately has no such window, and the asymmetry is not an
 * oversight: the search lock can self-heal only because its holder
 * HEARTBEATS - `acquireWriterLock` passes `update:
 * WRITER_LOCK_HEARTBEAT_MS` so a live holder keeps refreshing the mtime,
 * which is what makes "old mtime" mean "dead holder". A holder of THIS
 * lock is inside a synchronous critical section: the single thread is
 * busy doing the very work the lock protects, so no timer can refresh
 * anything. Here an age threshold would only mean "held for longer than
 * N", which a live writer on a large store reaches honestly - and
 * breaking a live writer's lock corrupts what it protects. So the
 * condition is REPORTED and the judgement is left to the operator; see
 * `doctor/uncertainty-probes.ts`.
 */

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { BRAIN_ROOT_REL, DERIVED_STORE_DIR } from "./path-constants.ts";

export interface LockHandle {
  /** Filesystem path to the underlying `.lock` file. */
  readonly path: string;
  /** Release the lock. Idempotent: a second call is a no-op. */
  release(): void;
}

const LOCK_SUFFIX = ".lock";

// Held locks, tracked at module scope so the exit hook can clean up.
const heldLocks = new Set<string>();
let exitHookInstalled = false;

function ensureExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const lockPath of heldLocks) {
      try {
        unlinkSync(lockPath);
      } catch {
        // best-effort; the next acquire will see ELOCKED and surface it
      }
    }
    heldLocks.clear();
  });
}

/**
 * Whether a failed exclusive create is Windows reporting a lock that is
 * mid-release rather than a real permission problem.
 *
 * Windows does not remove a file the moment another process unlinks it: the
 * name stays in a "delete pending" state until the last handle closes, and
 * any attempt to create that name meanwhile fails with `EPERM` (or `EACCES`)
 * instead of `EEXIST`. Under a multi-process race - the exact case these
 * locks exist for - a writer that loses by a few microseconds to a releasing
 * holder then crashed with a raw `EPERM` instead of waiting its turn. On
 * win32 that code is contention and goes through the same retry path as
 * `EEXIST`; the original error rides along as `cause`, so a directory that
 * genuinely refuses writes still names its real reason once the wait budget
 * runs out. POSIX never reports a held lock this way, so there it stays an
 * error.
 *
 * A directory that refuses to create files at all (an ACL, Defender's
 * Controlled Folder Access) answers the same `EPERM`, and treating THAT as
 * contention froze the caller for the whole wait budget and then reported
 * "lock busy". The two differ in whether anything holds the name: a
 * delete-pending or held lock file is there to `lstat` (or refuses the
 * `lstat` too), a refused create leaves nothing (`ENOENT`). Only the first
 * is contention. `platform` and `occupied` are test seams.
 */
export function isWindowsDeletePending(
  e: NodeJS.ErrnoException,
  lockPath: string,
  platform: NodeJS.Platform = process.platform,
  occupied: (path: string) => boolean = nameIsOccupied,
): boolean {
  if (platform !== "win32" || (e.code !== "EPERM" && e.code !== "EACCES")) return false;
  return occupied(lockPath);
}

/** Whether something holds `path`: it can be `lstat`ed, or refuses it with anything but ENOENT. */
function nameIsOccupied(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/**
 * Acquire an exclusive lock for `target`. Returns a handle whose
 * {@link LockHandle.release} method unlinks the underlying `.lock`
 * file. Throws `Error & { code: 'ELOCKED' }` if the lock is already
 * held.
 *
 * The target file itself does NOT need to exist - first-time writes
 * acquire the lock before creating the target. The parent directory
 * is created on demand.
 */
export function acquireLockSync(target: string): LockHandle {
  ensureExitHook();
  const lockPath = target + LOCK_SUFFIX;
  mkdirSync(dirname(lockPath), { recursive: true });

  let fd = -1;
  for (let attempt = 0; fd < 0; attempt += 1) {
    try {
      fd = openSync(lockPath, "wx", 0o644);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "EEXIST" || isWindowsDeletePending(e, lockPath)) {
        const collision: NodeJS.ErrnoException = new Error(`lock busy: ${lockPath}`, { cause: e });
        collision.code = "ELOCKED";
        collision.path = lockPath;
        throw collision;
      }
      // A Windows EPERM with nothing at the name is either a directory that
      // refuses creates or a holder whose file finished going away between
      // the open and the lstat. One more try tells them apart.
      if (
        attempt === 0 &&
        process.platform === "win32" &&
        (e.code === "EPERM" || e.code === "EACCES")
      ) {
        continue;
      }
      throw err;
    }
  }

  // Stamp pid + timestamp into the lock body. The contents are
  // purely diagnostic - the doctor surface reads them when reporting
  // stale locks. Failure to write is non-fatal: the lock semantics
  // come from the exclusive create, not from the body.
  let stampBytes = 0;
  try {
    const stamp = Buffer.from(`${process.pid}\n${new Date().toISOString()}\n`, "utf8");
    stampBytes = writeSync(fd, stamp, 0, stamp.byteLength);
  } catch {
    // ignore; diagnostic-only payload
  } finally {
    try {
      closeSync(fd);
    } catch {
      // ignore
    }
  }

  heldLocks.add(lockPath);
  let released = false;
  return {
    path: lockPath,
    release(): void {
      if (released) return;
      released = true;
      heldLocks.delete(lockPath);
      // Anything past our own stamp was appended by a waiter (see
      // `markWaiting`): someone is queued for this lock, so a re-acquire from
      // this process steps back first. Best-effort, like the stamp itself.
      let waitedOn = false;
      try {
        waitedOn = lstatSync(lockPath).size > stampBytes;
      } catch {
        // gone already; nobody to hand over to
      }
      try {
        unlinkSync(lockPath);
      } catch {
        // already gone (race with exit hook or manual cleanup); ignore
      }
      if (waitedOn) contendedReleases.set(lockPath, Date.now());
    },
  };
}

/**
 * How long {@link acquireLockSyncWithRetry} keeps waiting, and the ceiling on
 * one sleep between attempts.
 *
 * The budget is a WALL-CLOCK deadline rather than an attempt count because
 * what a waiter queues behind is other writers' work, not other writers'
 * sleeps: with n processes each folding one source into a shared file, the
 * last arrival waits for up to n-1 whole critical sections. An attempt count
 * bounds the number of naps, which is the wrong quantity.
 *
 * The sleep is JITTERED across `[1, RETRY_SLEEP_CEILING_MS]` rather than
 * fixed. A fixed sleep makes contenders that started together retry in
 * lockstep - they wake on the same tick, one wins, the rest sleep another
 * whole tick - so the same budget buys far fewer real attempts.
 *
 * ## Five seconds, for a different reason than the one first given
 *
 * The budget IS the freeze (see {@link acquireLockSyncWithRetry}), so five
 * seconds is a claim worth checking rather than assuming. The claim made
 * here was that it is "generous against a hold measured in milliseconds".
 * Both halves of that were measured, and the first half is false:
 *
 * | rows in the store | `appendGitRecords` hold | `updateManifest` hold |
 * |---|---|---|
 * | 1 000 | 23 ms | 19 ms |
 * | 10 000 | 134 ms | 81 ms |
 * | 50 000 | 465 ms | 262 ms |
 *
 * The holds are linear in the store they guard - a 50 000-commit repo is
 * most of a second per critical section, not milliseconds. But the hold is
 * not what sizes the budget. Measured across a four-process race over a
 * 400-entry manifest (100 acquisitions), the WAIT distribution is
 * `p50 = 0 ms, p90 = 1 ms, p99 = 732 ms, max = 732 ms`: almost every
 * acquisition is uncontended, and the tail is set by queueing, not by one
 * hold. The tail was long because nothing here was fair - a writer in a loop
 * re-acquired with no backoff at all while every waiter was mid-sleep, so a
 * waiter could lose many draws in a row. On a host whose hold is slower (the
 * Windows runner, about 80 ms per checkpoint write) that same unfairness
 * spent the whole budget: the checkpoint race was refused there, and a local
 * replay with an 80 ms hold refused 2 of 300 writes at 5 000 ms.
 *
 * ## The hand-over, and what it measured
 *
 * A waiter now marks the held lock file ({@link markWaiting}); a holder that
 * releases a marked lock and comes straight back for it steps back for longer
 * than any waiter sleeps, and a waiter that has already waited a while polls
 * on a shorter ceiling. The four-process checkpoint race, 100 acquisitions
 * per run, before and after:
 *
 * | host | before p50 / p99 / max | after p50 / p99 / max |
 * |---|---|---|
 * | Linux, 8 ms hold | 0 / 395 / 604 ms | 62 / 155 / 185 ms |
 * | Linux, 80 ms hold | 0 / 4 582 / 5 012 ms, 2 refused | 247 / 508 / 753 ms |
 * | Linux, 210 ms hold | 1 / 5 016 / 5 017 ms, 4 refused | 427 / 1 905 / 2 124 ms |
 * | WSL on an NTFS drive, 26 ms hold | 9 / 654 / 881 ms | 97 / 313 / 328 ms |
 *
 * The median rises because a waiter now actually waits its turn instead of
 * the looping writer taking every draw; the tail, which is what the budget
 * has to cover, falls to a few holds. The cost is idle time at each
 * hand-over (until the next waiter wakes, at most one sleep ceiling), paid
 * only when someone is waiting. The default stays at five seconds: after the
 * hand-over it is more than six times the longest wait at the Windows pace.
 * A slower host moves it with {@link LOCK_WAIT_BUDGET_ENV}.
 *
 * That tail is why the budget cannot simply be made small: at 1 000 ms the
 * branch's own designed-contention test (`updateManifest - concurrent
 * writers`, four real processes) starts failing intermittently with
 * `ELOCKED` on a perfectly healthy race - a budget at the p99 of the thing
 * it is meant to absorb is a coin flip. Five seconds is about six times
 * that p99, which is the margin that makes reaching it mean "something is
 * wrong" rather than "busy".
 *
 * What a caller gives up is therefore stated plainly rather than argued
 * away: in the worst case this freezes the process for five seconds. See
 * {@link acquireLockSyncWithRetry} for what bounds that, and
 * {@link LOCK_WAIT_INTERACTIVE_MS} for the callers that refuse to pay it.
 */
export const LOCK_WAIT_BUDGET_MS = 5_000;

/**
 * The environment variable that moves {@link LOCK_WAIT_BUDGET_MS} for every
 * caller that does not pass its own budget - the ingest writers, the session
 * ledger, the payload store. A host where one critical section is slow (an
 * antivirus scanning every write, a network or synced folder) can give
 * parallel ingest a longer wait without a rebuild. It never touches
 * {@link LOCK_WAIT_INTERACTIVE_MS}: a caller that chose to refuse rather
 * than freeze keeps that choice.
 */
export const LOCK_WAIT_BUDGET_ENV = "OPEN_SECOND_BRAIN_LOCK_WAIT_MS";

/**
 * The default wait budget this process uses, in milliseconds.
 *
 * A value that is not a non-negative integer THROWS rather than falling
 * back to the default, in the same discipline as `O2B_MCP_DRAIN_MS`: an
 * operator who set the variable did so to change the wait, and quietly
 * waiting five seconds because they typed `20s` would hide that.
 */
export function resolveLockWaitBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[LOCK_WAIT_BUDGET_ENV];
  if (raw === undefined || raw.trim() === "") return LOCK_WAIT_BUDGET_MS;
  const text = raw.trim();
  const parsed = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(
      `${LOCK_WAIT_BUDGET_ENV}=${raw} is not a lock wait; set it to a whole number of ` +
        `milliseconds >= 0 (the default is ${LOCK_WAIT_BUDGET_MS}), or unset it`,
    );
  }
  return parsed;
}

/**
 * The budget for a caller whose contention is RARE and whose freeze is
 * expensive - an interactive CLI pass with a progress stream and a Ctrl-C
 * the operator expects to land.
 *
 * The default above is sized for the ingest fan-out: several processes
 * folding results into one file, by design, where a long wait buys a
 * healthy ingest and a freeze costs a short-lived worker nothing. The
 * architect is the opposite case on both counts. Its contender is a second
 * architect run over the same repo, which is not a designed workload, and
 * its process is one an operator is watching: five seconds parked in
 * `Bun.sleepSync` is five seconds of stalled progress events and an
 * undelivered SIGINT. One second is still above the p90 of the measured
 * wait distribution, so a genuine brief overlap is absorbed; beyond that
 * the operator gets a named `ELOCKED` and a prompt back, which is a better
 * answer than a frozen terminal.
 */
export const LOCK_WAIT_INTERACTIVE_MS = 1_000;

const RETRY_SLEEP_CEILING_MS = 25;

/**
 * Lock paths this process released while another process was waiting on
 * them, with the release time. Read (and cleared) by the next
 * {@link acquireLockSyncWithRetry} of the same path.
 */
const contendedReleases = new Map<string, number>();

/**
 * How long after a contended release a re-acquire still counts as "coming
 * straight back". A waiter sleeps at most {@link RETRY_SLEEP_CEILING_MS}
 * between draws, so past a few ceilings every waiter has had its turn and
 * stepping back would only slow the returning writer down.
 */
const HANDOFF_WINDOW_MS = RETRY_SLEEP_CEILING_MS * 4;

/**
 * The pause a returning writer takes before it re-acquires a lock it just
 * released while someone waited: always longer than a waiter's longest
 * sleep, so at least one waiter wakes and draws inside it, and randomised so
 * two returning writers do not step back in lockstep.
 */
function handoffPauseMs(): number {
  return RETRY_SLEEP_CEILING_MS * 2 + Math.floor(Math.random() * RETRY_SLEEP_CEILING_MS);
}

/**
 * How long an aged waiter's ceiling is. After a hand-over the lock goes to
 * whichever waiter draws first, so a waiter that has already waited through
 * several hand-overs polls on a shorter ceiling and wins the next one more
 * often: an approximation of first come, first served without a queue file
 * a crash could strand.
 */
const AGED_WAITER_AFTER_MS = RETRY_SLEEP_CEILING_MS * 10;
const AGED_WAITER_CEILING_MS = 5;

function waiterSleepMs(waitedMs: number): number {
  const ceiling =
    waitedMs >= AGED_WAITER_AFTER_MS ? AGED_WAITER_CEILING_MS : RETRY_SLEEP_CEILING_MS;
  return 1 + Math.floor(Math.random() * ceiling);
}

/** Upper bound on the bytes waiters append to one lock file. */
const WAITER_MARK_LIMIT = 4_096;
const WAITER_MARK = Buffer.from("w", "utf8");
/** Read-write, never create, and never follow a symlink where the platform can refuse one. */
const MARK_OPEN_FLAGS = fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW ?? 0);

/**
 * Tell the holder of `lockPath` that someone is waiting, by appending one
 * byte to its lock file. The file is opened WITHOUT create: a lock
 * released a moment ago must never be re-created by a waiter, which would be
 * a lock nobody holds. Every failure is ignored - the mark only buys
 * fairness, and the exclusive create is still what grants the lock.
 */
function markWaiting(lockPath: string): void {
  let fd = -1;
  try {
    fd = openSync(lockPath, MARK_OPEN_FLAGS);
    const stat = fstatSync(fd);
    // Only a lock file this module could have created: a regular file with
    // one name. A symlink or hard link planted at the lock path (a synced
    // vault can carry one) must not turn the mark into a write elsewhere.
    if (!stat.isFile() || stat.nlink !== 1) return;
    if (stat.size < WAITER_MARK_LIMIT) {
      writeSync(fd, WAITER_MARK, 0, WAITER_MARK.byteLength, stat.size);
    }
  } catch {
    // released, delete-pending or unreadable: nothing to mark
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

/** What an expired wait tells the operator to do next, by who set the budget. */
const REMEDY_EXPLICIT_BUDGET = "retry once the other writer finishes";

function defaultBudgetRemedy(budgetMs: number): string {
  return (
    `retry once the other writer finishes, or allow a longer wait with ` +
    `${LOCK_WAIT_BUDGET_ENV}=<milliseconds> (now ${budgetMs})`
  );
}

/**
 * The next step a refused INGEST write names. Passed by the writers the
 * parallel ingest fan-out shares (the content manifest, the plan and session
 * checkpoints, the git record store, the session ledger), where running the
 * workers one at a time is the other honest answer.
 */
export function ingestLockRemedy(budgetMs: number = resolveLockWaitBudgetMs()): string {
  return (
    `another process is writing the same file: retry the ingest, run parallel ingests ` +
    `one at a time, or allow a longer wait with ${LOCK_WAIT_BUDGET_ENV}=<milliseconds> ` +
    `(now ${budgetMs})`
  );
}

export interface LockWaitOptions {
  /** What the refusal tells the operator to do next, replacing the generic advice. */
  readonly remedy?: (budgetMs: number) => string;
}

/**
 * {@link acquireLockSync} with a bounded wait, for the shared files that
 * PARALLEL processes write by design.
 *
 * The single-attempt policy above is justified by contention being rare -
 * one operator, one MCP server, dream on cron. The ingest path breaks that
 * premise on purpose: `ingest/batch-plan.ts` exists so a caller dispatches
 * each batch as its own subagent, so several processes fold their result
 * into the content manifest, the plan checkpoint and the git record store
 * concurrently. There, an immediate `ELOCKED` would turn a millisecond
 * overlap into a failed ingest.
 *
 * Waiting is bounded and still loud: only `ELOCKED` is retried, any other
 * error propagates at once, and an expired budget throws an `ELOCKED`
 * (`lock busy: <lock file>`, how long it waited, and what to do next; the
 * last collision rides along as `cause`) rather than proceeding unlocked.
 * Nothing is ever silently skipped. `budget` omitted means the default,
 * moved by {@link LOCK_WAIT_BUDGET_ENV}; `options.remedy` replaces the
 * generic advice with the caller's own (see {@link ingestLockRemedy}).
 *
 * ## The wait is a FREEZE, and that is the cost
 *
 * `Bun.sleepSync` blocks the single JavaScript thread. This does not "wait",
 * it stops the process: for the whole budget no timer fires, no progress
 * event is emitted, no signal handler runs (a Ctrl-C is queued, not
 * delivered), and inside the MCP server no other tool call proceeds.
 * `tests/core/brain/sync-lockfile.test.ts` pins both halves of that - the
 * freeze is total, and it ends when the budget does.
 *
 * The freeze is accepted rather than removed, for three reasons that were
 * checked rather than assumed:
 *
 *  - Removing it is not a local change. The Brain write path is synchronous
 *    end to end, and `ingestSource` - the caller that reaches two of these
 *    three sites - is a synchronous function on the published SDK surface
 *    (`brain/sdk.ts`). An awaited lock would have to colour it, its callers
 *    and that contract async for one ingredient. Worth doing on its own
 *    terms; not worth smuggling in beside a lock fix.
 *  - Shrinking it to a value nobody would notice does not work either: at
 *    1 000 ms the four-process manifest race fails on healthy contention.
 *    See {@link LOCK_WAIT_BUDGET_MS} for the measured distribution.
 *  - Within ONE process this lock can never be contended. The whole
 *    acquire-mutate-release runs inside a single synchronous turn, so a
 *    second `brain_ingest_source` call on the same MCP server cannot even
 *    begin while the first holds it. An `ELOCKED` inside a server therefore
 *    always means a DIFFERENT process - never the parallel fan-out this
 *    function exists for. The server can still be frozen by an external
 *    writer; what it cannot do is freeze itself.
 *
 * A caller that would rather refuse than freeze says so with
 * {@link LOCK_WAIT_INTERACTIVE_MS}.
 */
export function acquireLockSyncWithRetry(
  target: string,
  budget?: number,
  options: LockWaitOptions = {},
): LockHandle {
  const budgetMs = budget ?? resolveLockWaitBudgetMs();
  // A budget this loop cannot honour is named rather than quietly
  // reinterpreted, in the same discipline as `requireCap` and the lease's
  // TTL guard. `NaN` is the reason the guard exists: `Date.now() >= NaN` is
  // false forever, so a non-finite budget turned a bounded freeze into an
  // unbounded one that no signal could break. Zero is legal and means
  // exactly one attempt - the deadline is only consulted after a failure.
  if (!Number.isInteger(budgetMs) || budgetMs < 0) {
    throw new Error(`lock wait budgetMs must be an integer >= 0, got ${budgetMs}`);
  }
  const lockPath = target + LOCK_SUFFIX;
  const started = Date.now();
  const deadline = started + budgetMs;
  // Fairness: a writer in a loop re-creates the lock file microseconds after
  // it unlinks it, while every waiter is mid-sleep, so without this a waiter
  // loses draw after draw until its budget runs out on a healthy race. When
  // this process released the lock while someone waited, it steps back for
  // longer than any waiter sleeps, so one of them takes the lock first.
  const releasedAt = contendedReleases.get(lockPath);
  if (releasedAt !== undefined) {
    contendedReleases.delete(lockPath);
    if (started - releasedAt < HANDOFF_WINDOW_MS && budgetMs > 0) {
      Bun.sleepSync(Math.min(handoffPauseMs(), budgetMs));
    }
  }
  for (;;) {
    try {
      return acquireLockSync(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ELOCKED") throw err;
      if (Date.now() >= deadline) {
        const remedy =
          options.remedy?.(budgetMs) ??
          (budget === undefined ? defaultBudgetRemedy(budgetMs) : REMEDY_EXPLICIT_BUDGET);
        const refused: NodeJS.ErrnoException = new Error(
          `lock busy: ${lockPath}: still held after waiting ${Date.now() - started} ms; ${remedy}`,
          { cause: err },
        );
        refused.code = "ELOCKED";
        refused.path = lockPath;
        throw refused;
      }
      markWaiting(lockPath);
      Bun.sleepSync(waiterSleepMs(Date.now() - started));
    }
  }
}

/**
 * Every directory in `vault` a Brain `.lock` can appear under.
 *
 * ENUMERATED here, in the module that owns the lock, rather than chosen by
 * whoever calls the scan. The doctor used to walk one hard-coded root,
 * `<vault>/Brain/` - and two of the three locks the parallel ingest path
 * takes (the content manifest and the plan checkpoint) live in the
 * derived-store directory beside it, so a crashed ingest left a lock the
 * doctor answered `[]` about while it sat plainly on disk.
 *
 * These two are the only directories any lock is taken in today - checked
 * against every path builder that feeds a lock target, not assumed. A new
 * lock site under a third root has to be added here, and
 * the census in `tests/core/brain/sync-lockfile.test.ts` reads the sources
 * to make sure it is: the failure this closes is not one wrong path, it is
 * a scan that silently stops being complete.
 */
export function lockScanRoots(vault: string): string[] {
  return [join(vault, BRAIN_ROOT_REL), join(vault, DERIVED_STORE_DIR)];
}

/**
 * Walk every {@link lockScanRoots} directory of `vault` recursively and
 * return each `.lock` file path. Used by `brain_doctor` to surface stale
 * locks left behind by a crashed process.
 *
 * Takes the VAULT, not a root, so no caller can narrow the scan to a
 * subset of the places a lock lives. A root that does not exist
 * contributes nothing - `walkLocks` already treats an unreadable
 * directory as empty.
 */
export function scanStaleLocks(vault: string): string[] {
  const out: string[] = [];
  for (const root of lockScanRoots(vault)) walkLocks(root, out);
  return out;
}

function walkLocks(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkLocks(full, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.endsWith(LOCK_SUFFIX)) {
      out.push(full);
    }
  }
}

/**
 * Test-only: clear the held-locks tracking set without unlinking. Used
 * to keep cross-test state from leaking when a test deliberately
 * leaves a lock on disk for the next test to discover.
 *
 * The leading underscore is this repo's marker for a test-only export,
 * which is exactly what the rule below flags - same disable as
 * `search/benchmark.ts` uses for `_benchmarkQueryPeakForTests`.
 */
// oxlint-disable-next-line no-underscore-dangle
export function _resetHeldLocksForTests(): void {
  heldLocks.clear();
}
