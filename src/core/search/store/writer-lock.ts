/**
 * The exclusive writer lock on the index path. Every writer - a write
 * open, the reindex rebuild+swap, the crash-recovery restore, an
 * out-of-band FTS rebuild, a snapshot's store archive - serialises here,
 * on the LIVE `dbPath`, so there is exactly one lock and one stale window
 * in the system.
 *
 * On disk the lock is the protocol `proper-lockfile` uses, unchanged: the
 * directory `<dbPath>.lock`, created with `mkdir` (atomic), whose mtime is
 * the holder's heartbeat. A lock whose mtime is older than the stale
 * window is abandoned and the next writer removes and re-creates it.
 * Processes running an older release, which take this lock through
 * `proper-lockfile` itself, are excluded by it and exclude it. The safety
 * is not symmetric, though: an older release's release and exit hook
 * remove the directory whoever owns it, so an older holder that went stale
 * and wakes up can remove this module's lock. This module then sees the
 * lock gone, marks its lease lost and refuses its next commit.
 *
 * What this module adds over `proper-lockfile` is the lease discipline:
 *
 *   1. Ownership. Every refresh and the release first check that the
 *      lock is still the one this holder last stamped (its mtime, and its
 *      device and inode where the filesystem reports one). A lock another
 *      writer took over is never refreshed and never removed: the holder
 *      marks its lease lost instead. Before a commit and at release, a
 *      lock past the stale window minus a margin is not touched either,
 *      even when it still looks like ours, because a contender may be
 *      taking it over at that very moment; a routine beat after a long
 *      stall still refreshes a lock nobody took over, up to one second
 *      (or the margin, when that is shorter) before the stale window.
 *   2. Freshness through synchronous work. The heartbeat normally runs on
 *      the event loop (a timer, plus {@link writerLeaseCheckIn} from long
 *      synchronous loops). A call that blocks the thread for longer - a
 *      `spawnSync` of tar or zstd, a `PRAGMA quick_check`, `VACUUM INTO`,
 *      an FTS rebuild, a migration - is wrapped in
 *      {@link keepWriterLeasesFresh}, which refreshes from a worker thread
 *      for at most a stated budget. Past the budget the worker stops, so a
 *      holder wedged inside the call still goes stale and is taken over.
 *   3. Loss is surfaced. A holder about to commit (the reindex swap, the
 *      restore swap) calls {@link WriterLease.assertHeld}, which refuses
 *      with `INDEX_LOCKED`. A holder with no single commit point (a
 *      write-mode store) passes an `onLost` handler, which runs the moment
 *      the main thread sees the loss.
 */

import {
  closeSync,
  fstatSync,
  futimesSync,
  mkdirSync,
  openSync,
  rmdirSync,
  statSync,
  utimesSync,
} from "node:fs";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";

import onExit from "signal-exit";

import {
  isHeldLockCreateError,
  isNamedLockFault,
  isRemovalRefusalTransient,
  LockRemovalRefusedError,
  tryCreateLockName,
} from "../../fs-lock.ts";
import { SearchError } from "../types.ts";

/**
 * Default stale window for the writer lock (ms). A lock whose mtime is
 * older than this is treated as abandoned (crashed or wedged holder) and
 * taken over by the next writer, so a SIGKILL never wedges the index for
 * longer than this window. {@link WRITER_LOCK_STALE_ENV} overrides it.
 */
export const WRITER_LOCK_STALE_MS = 60_000;

/**
 * Default heartbeat (ms): a live lease refreshes its mtime once it is this
 * old, a third of the stale window, so two missed beats still leave the
 * lock fresh. Derived from the resolved stale window when that is
 * overridden.
 */
export const WRITER_LOCK_HEARTBEAT_MS = 20_000;

/** Environment variable overriding {@link WRITER_LOCK_STALE_MS}. */
export const WRITER_LOCK_STALE_ENV = "OPEN_SECOND_BRAIN_WRITER_LOCK_STALE_MS";

/** The smallest stale window the override accepts (ms). */
const MIN_WRITER_LOCK_STALE_MS = 1_000;

/** The largest stale window the override accepts (ms): one day. */
const MAX_WRITER_LOCK_STALE_MS = 24 * 60 * 60_000;

/** Longest delay a timer accepts; a longer one fires every millisecond. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Budget (ms) for an in-process blocking call that has no timeout of its
 * own (an integrity scan, `VACUUM INTO`, an FTS rebuild, a migration):
 * {@link keepWriterLeasesFresh} keeps the lease fresh this long, and a
 * call still running past it counts as wedged.
 */
export const WRITER_LEASE_BLOCKING_BUDGET_MS = 15 * 60_000;

let shortWindowWarned = false;

/**
 * The stale window this process uses, from {@link WRITER_LOCK_STALE_ENV}
 * or the default. Every process sharing an index should agree on it: a
 * process with a shorter window takes over a lock a longer-window holder
 * still considers fresh. Older releases always use the default and cannot
 * be told otherwise, so a window below it is unsafe while one of them
 * shares the index; that is warned about once per process.
 */
export function resolveWriterLockStaleMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[WRITER_LOCK_STALE_ENV];
  if (raw === undefined || raw.trim() === "") return WRITER_LOCK_STALE_MS;
  const text = raw.trim();
  const parsed = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < MIN_WRITER_LOCK_STALE_MS ||
    parsed > MAX_WRITER_LOCK_STALE_MS
  ) {
    throw new Error(
      `${WRITER_LOCK_STALE_ENV}=${raw} is not a stale window; set it to a whole number of ` +
        `milliseconds from ${MIN_WRITER_LOCK_STALE_MS} to ${MAX_WRITER_LOCK_STALE_MS} ` +
        `(the default is ${WRITER_LOCK_STALE_MS}), or unset it`,
    );
  }
  if (parsed < WRITER_LOCK_STALE_MS && !shortWindowWarned) {
    shortWindowWarned = true;
    // eslint-disable-next-line no-console
    console.error(
      `warning: ${WRITER_LOCK_STALE_ENV}=${parsed} is below the ${WRITER_LOCK_STALE_MS} ms ` +
        "older releases always use; do not share the index with an older release, whose " +
        "live lock this process would take over",
    );
  }
  return parsed;
}

function heartbeatFor(staleMs: number): number {
  // Never longer than the default beat, whatever the window: an older
  // release judges this lock by its own fixed 60-second window, so a
  // longer window must not let the lock's mtime fall that far behind.
  return Math.min(WRITER_LOCK_HEARTBEAT_MS, Math.floor(staleMs / 3));
}

/**
 * How far below the stale window a holder stops trusting its own lock
 * (ms): half a heartbeat. A refresh or release that finds the lock this
 * old does not write or remove it, since a contender may already be
 * removing it as stale.
 */
function marginFor(staleMs: number): number {
  return Math.floor(heartbeatFor(staleMs) / 2);
}

/** The one message both acquire paths report contention with. */
function contentionError(cause: unknown): SearchError {
  const msg = cause instanceof Error ? cause.message : String(cause);
  return new SearchError("INDEX_LOCKED", `another writer holds the search index lock: ${msg}`);
}

function lockDirOf(path: string): string {
  return `${resolve(path)}.lock`;
}

function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

// ---------------------------------------------------------------------------
// Shared lease state
//
// Each lease keeps its state in a SharedArrayBuffer so the main thread and
// a refresher worker see one copy: Int32 slot 0 is the refresh mutex
// (whoever refreshes or releases holds it), slot 1 the lease state, and
// from byte 8 four Float64s: the mtime this holder last stamped, the
// device and inode of the directory, and 1 when the filesystem kept the
// stamp to the sub-millisecond (0 when it rounded it). The Float64s are
// plain, non-atomic memory: they are read and written only by whoever
// holds the mutex, whose Atomics operations order those accesses.
//
// Each stamp carries a random sub-millisecond fraction, so on a filesystem
// with fine timestamps two holders never record the same mtime, even when
// the filesystem reuses an inode number for a successor's directory.

const SLOT_BUSY = 0;
const SLOT_STATE = 1;
const STATE_HELD = 0;
const STATE_LOST = 1;
const STATE_RELEASED = 2;
const LEASE_BYTES = 40;

/**
 * Refresh one lease whose mutex the caller holds. Shared verbatim by the
 * main thread and the refresher worker (its source is embedded there), so
 * it references only its parameters and globals.
 *
 * Nothing is written, and the lease is marked lost, when the lock's mtime
 * or directory identity is not the one recorded, when its directory is
 * gone, or when it is too old: for a forced check (`minAgeMs` 0, before a
 * commit) past the stale window minus `marginMs`, since a contender may be
 * taking it over; for a due beat past the stale window minus the smaller
 * of `marginMs` and one second. The identity is checked once more
 * after the write, so a successor that replaced the directory between the
 * check and the write is not adopted. A refresh that fails for another
 * reason is retried on the next beat; the age rule gives it up in time.
 *
 * Returns true only when it stamped the lock and proved it ours after the
 * write; a skipped or inconclusive refresh (an EIO or EACCES on the stat)
 * returns false, which a commit check treats as not holding the lock.
 */
function refreshHeldLease(
  state: Int32Array,
  own: Float64Array,
  lockDir: string,
  staleMs: number,
  marginMs: number,
  minAgeMs: number,
  fs: LockFs,
): boolean {
  if (Atomics.load(state, 1) !== 0) return false;
  const known = own[0] as number;
  const age = Date.now() - known;
  // Only a due-check may skip the ownership check; a forced refresh
  // (minAgeMs 0) always looks, also when a clock that went backwards
  // makes the lock's age read as negative.
  if (minAgeMs > 0 && age < minAgeMs) return false;
  // How old the lock may be and still be written. A forced check (a commit
  // about to happen) stops at the margin below the stale window: it must not
  // write a lock a contender may be taking over. A due beat after a long
  // stall of this thread (a sleeping laptop) goes further, so a holder
  // nobody took over keeps its lease, but not to the window itself: a lock
  // that crosses the window between this check and the write is exactly
  // the one a contender removes and re-creates in that gap. One second
  // covers a stat and a utimes on a slow filesystem many times over and
  // still recovers almost the whole stall; with a short window the margin
  // itself is the smaller guard.
  const limit = minAgeMs > 0 ? staleMs - Math.min(marginMs, 1_000) : staleMs - marginMs;
  if (age >= limit) {
    Atomics.store(state, 1, 1);
    return false;
  }
  // An inode of 0 is a filesystem that reports none; the mtime alone counts.
  const sameDir = (st: { dev: number; ino: number }): boolean =>
    own[2] === 0 || (st.ino === own[2] && st.dev === own[1]);
  const stamp = Date.now() + Math.random() * 0.9;
  // The directory is opened, and the check and the stamp go through that
  // handle: a handle stays bound to the directory it opened, so a holder
  // that is paused between the check and the write and resumes after a
  // takeover stamps its own removed directory, never the successor's.
  // On Windows the path is used: a directory handle opens there but
  // refuses `futimes` (EPERM), and the pause between the check and the
  // write is the residual window. Elsewhere a directory that cannot be
  // opened falls back to the path too.
  let fd = -1;
  if (process.platform !== "win32") {
    try {
      fd = fs.openSync(lockDir, "r");
    } catch (err) {
      if ((err as { code?: string } | null)?.code === "ENOENT") {
        Atomics.store(state, 1, 1);
        return false;
      }
    }
  }
  try {
    let current: { mtimeMs: number; dev: number; ino: number };
    try {
      current = fd >= 0 ? fs.fstatSync(fd) : fs.statSync(lockDir);
    } catch (err) {
      if ((err as { code?: string } | null)?.code === "ENOENT") Atomics.store(state, 1, 1);
      return false;
    }
    // Ownership, and the age of the lock as it is on disk, read against the
    // clock after the stat returned: a lock that crept up to the limit while
    // the stat was pending (a slow network filesystem) is not written either.
    if (current.mtimeMs !== known || !sameDir(current) || Date.now() - current.mtimeMs >= limit) {
      Atomics.store(state, 1, 1);
      return false;
    }
    try {
      if (fd >= 0) fs.futimesSync(fd, stamp / 1000, stamp / 1000);
      else fs.utimesSync(lockDir, stamp / 1000, stamp / 1000);
      // The path must still name the directory that was stamped.
      const after = fs.statSync(lockDir);
      if (!sameDir(after) || (fd >= 0 && after.mtimeMs !== fs.fstatSync(fd).mtimeMs)) {
        Atomics.store(state, 1, 1);
        return false;
      }
      own[0] = after.mtimeMs;
      own[3] = Math.abs(after.mtimeMs - stamp) < 0.01 ? 1 : 0;
      return true;
    } catch (err) {
      if ((err as { code?: string } | null)?.code === "ENOENT") Atomics.store(state, 1, 1);
      return false;
    }
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch {
        // A handle that cannot be closed is released with the process.
      }
    }
  }
}

interface LockFs {
  readonly statSync: typeof statSync;
  readonly utimesSync: typeof utimesSync;
  readonly openSync: typeof openSync;
  readonly fstatSync: typeof fstatSync;
  readonly futimesSync: typeof futimesSync;
  readonly closeSync: typeof closeSync;
}

const FS_OPS: LockFs = { statSync, utimesSync, openSync, fstatSync, futimesSync, closeSync };

/**
 * How long a blocking mutex take (assert, release, a worker's stop) waits
 * for a refresh in flight (ms). A refresh is a stat, a utimes and a stat,
 * so this is only reached on a filesystem that has stopped answering; the
 * caller then treats ownership as unproven.
 */
const MUTEX_WAIT_MS = 2_000;

// Control words of a refresher worker.
const CONTROL_STOP = 0;
const CONTROL_PHASE = 1;
const PHASE_PENDING = 0;
const PHASE_RUNNING = 1;
const PHASE_DONE = 2;
const PHASE_CANCELLED = 3;

/**
 * Refreshes the given leases while the main thread is blocked, until told
 * to stop, until the budget runs out, or until no lease is held any more.
 * It waits on the control word with `Atomics.wait`, so it needs no event
 * loop, and it only takes a lease's mutex without blocking, so a lease the
 * main thread is releasing is skipped. It claims the start with a
 * compare-exchange, so a worker the main thread cancelled before it began
 * never touches a lease.
 */
const REFRESHER_SOURCE = `
const { workerData } = require("node:worker_threads");
const fs = require("node:fs");
const refreshHeldLease = (${refreshHeldLease.toString()});
const control = new Int32Array(workerData.control);
if (Atomics.compareExchange(control, ${CONTROL_PHASE}, ${PHASE_PENDING}, ${PHASE_RUNNING}) === ${PHASE_PENDING}) {
  const started = performance.now();
  const leases = workerData.leases.map((l) => ({
    state: new Int32Array(l.sab, 0, 2),
    own: new Float64Array(l.sab, 8, 4),
    lockDir: l.lockDir,
    staleMs: l.staleMs,
    marginMs: l.marginMs,
    heartbeatMs: l.heartbeatMs,
  }));
  const tick = Math.max(25, Math.min(...leases.map((l) => l.heartbeatMs)) / 2);
  while (performance.now() - started < workerData.budgetMs) {
    let held = 0;
    for (const l of leases) {
      if (Atomics.load(control, ${CONTROL_STOP}) !== 0) break;
      if (Atomics.load(l.state, 1) !== 0) continue;
      held++;
      if (Atomics.compareExchange(l.state, ${SLOT_BUSY}, 0, 1) !== 0) continue;
      try {
        refreshHeldLease(l.state, l.own, l.lockDir, l.staleMs, l.marginMs, l.heartbeatMs, fs);
      } catch {
        // A refresh that throws is retried on the next tick.
      } finally {
        Atomics.store(l.state, ${SLOT_BUSY}, 0);
        Atomics.notify(l.state, ${SLOT_BUSY});
      }
    }
    if (held === 0 || Atomics.load(control, ${CONTROL_STOP}) !== 0) break;
    Atomics.wait(control, ${CONTROL_STOP}, 0, tick);
  }
  Atomics.store(control, ${CONTROL_PHASE}, ${PHASE_DONE});
  Atomics.notify(control, ${CONTROL_PHASE});
}
`;

/**
 * An exclusive writer lock held by this process. It stays fresh on its own
 * while the event loop runs; synchronous work keeps it fresh through
 * {@link writerLeaseCheckIn} and {@link keepWriterLeasesFresh}.
 */
export interface WriterLease {
  /** The index path the lock is held on (the lock is `<path>.lock`). */
  readonly path: string;
  /**
   * True once the lock stopped being this holder's: another writer took it
   * over, its directory was removed, or it went so long without a refresh
   * that it may be taken over. A lost lease excludes nothing.
   */
  readonly lost: boolean;
  /**
   * Refuse with `INDEX_LOCKED` unless the lock is still this holder's,
   * refreshing it when it is. Called right before a commit that must not
   * race another writer (a swap), so a lease lost to a takeover aborts the
   * commit instead of overwriting what the other writer did.
   */
  assertHeld(): void;
  /**
   * Remove the lock when it is provably still this holder's; leave it
   * otherwise (a successor's lock, or one the next writer will find stale
   * and take over anyway). Idempotent. Throws only when removing our own
   * lock fails.
   */
  release(): void;
}

export interface WriterLeaseOptions {
  /**
   * Runs once, on the main thread, when this process first sees that the
   * lease was lost: from the heartbeat timer, a check-in, the end of a
   * {@link keepWriterLeasesFresh} call, or {@link WriterLease.assertHeld}.
   * It receives the `INDEX_LOCKED` error and may throw it; from the timer,
   * that ends the process, as `proper-lockfile` did for a lock it lost.
   */
  readonly onLost?: (err: SearchError) => void;
}

const liveLeases = new Set<Lease>();
let roundingFilesystemWarned = false;
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // On any exit, a signal included, leases still held are released the
  // same ownership-checked way, so an interrupted writer neither keeps
  // the index locked for a stale window nor removes a successor's lock.
  onExit(() => {
    for (const lease of [...liveLeases]) {
      try {
        lease.release();
      } catch {
        // The process is exiting; the lock goes stale on its own.
      }
    }
  });
}

class Lease implements WriterLease {
  readonly path: string;
  readonly lockDir: string;
  readonly staleMs: number;
  readonly heartbeatMs: number;
  readonly marginMs: number;
  readonly sab: SharedArrayBuffer;
  readonly #state: Int32Array;
  readonly #own: Float64Array;
  readonly #timer: ReturnType<typeof setInterval>;
  readonly #onLost: ((err: SearchError) => void) | undefined;
  #lossReported = false;

  constructor(
    path: string,
    lockDir: string,
    staleMs: number,
    identity: { readonly mtimeMs: number; readonly dev: number; readonly ino: number },
    precise: boolean,
    options: WriterLeaseOptions,
  ) {
    this.path = path;
    this.lockDir = lockDir;
    this.staleMs = staleMs;
    this.heartbeatMs = heartbeatFor(staleMs);
    this.marginMs = marginFor(staleMs);
    this.#onLost = options.onLost;
    this.sab = new SharedArrayBuffer(LEASE_BYTES);
    this.#state = new Int32Array(this.sab, 0, 2);
    this.#own = new Float64Array(this.sab, 8, 4);
    this.#own[0] = identity.mtimeMs;
    this.#own[1] = identity.dev;
    this.#own[2] = identity.ino;
    this.#own[3] = precise ? 1 : 0;
    if (identity.ino === 0 && !precise && !roundingFilesystemWarned) {
      roundingFilesystemWarned = true;
      // eslint-disable-next-line no-console
      console.error(
        `warning: the filesystem holding ${lockDir} reports no inode and rounds timestamps, ` +
          "so a writer cannot prove the search index lock is still its own when it releases " +
          `it; each release leaves the lock to go stale, and the next writer waits up to ${staleMs} ms`,
      );
    }
    // The event-loop heartbeat. Unref'd: a held lease never keeps the
    // process alive by itself.
    this.#timer = setInterval(
      () => this.checkIn(),
      Math.min(MAX_TIMER_MS, Math.max(25, this.heartbeatMs / 2)),
    );
    this.#timer.unref?.();
    liveLeases.add(this);
    installExitHook();
  }

  get lost(): boolean {
    return Atomics.load(this.#state, SLOT_STATE) === STATE_LOST;
  }

  /** Whether its holder released it. */
  get released(): boolean {
    return Atomics.load(this.#state, SLOT_STATE) === STATE_RELEASED;
  }

  /** Whether this lease still needs refreshing (held, not lost or released). */
  get active(): boolean {
    return Atomics.load(this.#state, SLOT_STATE) === STATE_HELD;
  }

  /** Refresh when due, without waiting for a refresh already in flight. */
  refreshIfDue(minAgeMs: number = this.heartbeatMs): void {
    if (!this.#tryLock()) return;
    try {
      refreshHeldLease(
        this.#state,
        this.#own,
        this.lockDir,
        this.staleMs,
        this.marginMs,
        minAgeMs,
        FS_OPS,
      );
    } finally {
      this.#unlock();
    }
  }

  /** A due refresh, then the loss report if the lease was found lost. */
  checkIn(): void {
    this.refreshIfDue();
    if (this.lost) this.reportLost();
  }

  #lostError(): SearchError {
    return new SearchError(
      "INDEX_LOCKED",
      `the search index writer lock on ${this.path} is no longer held by this writer ` +
        "(it went stale and may have been taken over by another writer)",
    );
  }

  /**
   * Report the loss once: stop the heartbeat, warn, and run `onLost`,
   * whose throw propagates to the caller.
   */
  reportLost(): void {
    if (this.#lossReported) return;
    this.#lossReported = true;
    this.#settle();
    const err = this.#lostError();
    // eslint-disable-next-line no-console
    console.error(`warning: ${err.message}`);
    this.#onLost?.(err);
  }

  assertHeld(): void {
    const locked = this.#lockBlocking();
    let proven = false;
    try {
      if (locked) {
        proven = refreshHeldLease(
          this.#state,
          this.#own,
          this.lockDir,
          this.staleMs,
          this.marginMs,
          0,
          FS_OPS,
        );
      }
    } finally {
      if (locked) this.#unlock();
    }
    if (Atomics.load(this.#state, SLOT_STATE) === STATE_HELD && proven) return;
    if (Atomics.load(this.#state, SLOT_STATE) === STATE_HELD) {
      // A refresh that never let go of the mutex, or one that could not
      // read the lock: ownership is not proven, which for a commit is the
      // same as not having it.
      Atomics.store(this.#state, SLOT_STATE, STATE_LOST);
    }
    this.reportLost();
    throw this.#lostError();
  }

  release(): void {
    const locked = this.#lockBlocking();
    try {
      if (!locked || Atomics.load(this.#state, SLOT_STATE) !== STATE_HELD) return;
      // No inode and a rounded stamp: the mtime alone cannot tell this
      // holder from a successor, so the lock is left to go stale.
      if (this.#own[2] === 0 && this.#own[3] === 0) return;
      // Everything else is decided by one stat taken right before the
      // removal, so only the stat and the rmdir themselves are a window
      // for a contender to swap the directory in.
      let current: { mtimeMs: number; dev: number; ino: number };
      try {
        current = statSync(this.lockDir);
      } catch (err) {
        if (errnoCode(err) === "ENOENT") return;
        throw err;
      }
      // Someone else's lock now: theirs to release.
      const sameDir =
        this.#own[2] === 0 || (current.ino === this.#own[2] && current.dev === this.#own[1]);
      if (current.mtimeMs !== this.#own[0] || !sameDir) return;
      // Past the stale window minus the margin, on disk and now, a
      // contender may be removing it right now; it is left for whoever
      // takes it next.
      if (Date.now() - current.mtimeMs >= this.staleMs - this.marginMs) return;
      try {
        rmdirSync(this.lockDir);
      } catch (err) {
        if (errnoCode(err) !== "ENOENT") throw err;
      }
    } finally {
      if (Atomics.load(this.#state, SLOT_STATE) === STATE_HELD) {
        Atomics.store(this.#state, SLOT_STATE, STATE_RELEASED);
      }
      if (locked) this.#unlock();
      this.#settle();
    }
  }

  #settle(): void {
    clearInterval(this.#timer);
    liveLeases.delete(this);
  }

  #tryLock(): boolean {
    return Atomics.compareExchange(this.#state, SLOT_BUSY, 0, 1) === 0;
  }

  #lockBlocking(): boolean {
    const deadline = Date.now() + MUTEX_WAIT_MS;
    while (!this.#tryLock()) {
      const left = deadline - Date.now();
      if (left <= 0) return false;
      Atomics.wait(this.#state, SLOT_BUSY, 1, left);
    }
    return true;
  }

  #unlock(): void {
    Atomics.store(this.#state, SLOT_BUSY, 0);
    Atomics.notify(this.#state, SLOT_BUSY);
  }
}

/**
 * One attempt at the lock: true when this call created it, false when a
 * live holder has it. A lock past the stale window is removed and created
 * again, as `proper-lockfile` does; any other filesystem error is thrown.
 */
function tryCreateLock(lockDir: string, staleMs: number): boolean {
  // A held lock answers EEXIST, or on Windows EPERM/EACCES while its
  // holder's release is still going through (`fs-lock.ts`, which creates a
  // refused name that is already free again at once); a directory that
  // refuses new entries throws there with its own reason.
  if ("created" in tryCreateLockName(lockDir, "directory", () => mkdirSync(lockDir))) return true;
  let mtimeMs: number;
  try {
    mtimeMs = statSync(lockDir).mtimeMs;
  } catch (err) {
    if (errnoCode(err) === "ENOENT") {
      return false; // released meanwhile: retry from the caller's wait path
    } else if (isHeldLockCreateError(err, lockDir, "directory")) {
      return false; // Windows: the directory is being deleted by its holder
    } else {
      throw err;
    }
  }
  if (mtimeMs >= Date.now() - staleMs) return false;
  try {
    rmdirSync(lockDir);
  } catch (err) {
    if (errnoCode(err) === "ENOENT") {
      // gone: the create below takes the free name
    } else if (isRemovalRefusalTransient(lockDir)) {
      // A release is going through: on Windows a name another process has
      // just removed is delete pending, and it refuses the removal of it
      // until its last handle closes. The create below waits that out.
    } else {
      // The name is still there and the removal of it was refused: it
      // cannot be done, and waiting does not change that.
      throw new LockRemovalRefusedError(lockDir, err as NodeJS.ErrnoException);
    }
  }
  // On Windows the directory just removed can stay delete-pending for a
  // moment: the create is made again over a few tens of milliseconds.
  return "created" in tryCreateLockName(lockDir, "directory", () => mkdirSync(lockDir));
}

/**
 * Stamp a directory this call just created (no earlier than `createdAt`,
 * monotonic)
 * with this attempt's own mtime and read back its identity.
 *
 * Nothing can tell from the directory alone that it is the one this call's
 * `mkdir` made, so it is proven by time instead: a contender removes it
 * only once it is a stale window old, so a directory opened less than the
 * window minus `marginMs` after the `mkdir` is necessarily ours. It is
 * opened first and stamped through that handle, so a pause after the check
 * stamps our own directory even if it was replaced meanwhile, and the
 * path is checked to still name it afterwards. Null - contention, nothing
 * more touched - when the directory was removed or replaced, or when too
 * long passed to prove it ours.
 */
function stampNewLock(
  lockDir: string,
  createdAt: number,
  staleMs: number,
  marginMs: number,
): { identity: { mtimeMs: number; dev: number; ino: number }; precise: boolean } | null {
  let fd = -1;
  let created: { dev: number; ino: number } | null = null;
  try {
    // On Windows the path is used: a directory handle opens there but
    // refuses `futimes`. Elsewhere one that cannot be opened falls back too.
    if (process.platform !== "win32") {
      try {
        fd = openSync(lockDir, "r");
      } catch (err) {
        if (errnoCode(err) === "ENOENT") return null;
      }
    }
    created = fd >= 0 ? fstatSync(fd) : statSync(lockDir);
    if (performance.now() - createdAt >= staleMs - marginMs) return null;
    const stamp = Date.now() + Math.random() * 0.9;
    if (fd >= 0) futimesSync(fd, stamp / 1000, stamp / 1000);
    else utimesSync(lockDir, stamp / 1000, stamp / 1000);
    const identity = statSync(lockDir);
    if (identity.ino !== created.ino || identity.dev !== created.dev) return null;
    if (fd >= 0 && identity.mtimeMs !== fstatSync(fd).mtimeMs) return null;
    return { identity, precise: Math.abs(identity.mtimeMs - stamp) < 0.01 };
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return null;
    // The stamp failed (a filesystem that refuses to set a directory's
    // times): the directory this attempt made is removed, so a failed
    // acquire leaves no lock behind, but only under the same proof that it
    // is ours - still inside the window minus the margin since the
    // `mkdir`, and the path still naming the directory that was opened.
    removeOwnNewLock(lockDir, created, createdAt, staleMs, marginMs);
    // A lock that cannot be stamped is a filesystem fault, not another
    // writer: it is reported as itself, never as contention.
    throw Object.assign(
      new Error(
        `cannot stamp the search index writer lock ${lockDir}: ` +
          `${(err as Error).message ?? String(err)}`,
        { cause: err },
      ),
      { code: errnoCode(err), lockStampFailure: true },
    );
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        /* released with the process */
      }
    }
  }
}

function removeOwnNewLock(
  lockDir: string,
  created: { readonly dev: number; readonly ino: number } | null,
  createdAt: number,
  staleMs: number,
  marginMs: number,
): void {
  if (created === null || performance.now() - createdAt >= staleMs - marginMs) return;
  try {
    const now = statSync(lockDir);
    if (now.ino !== created.ino || now.dev !== created.dev) return;
    rmdirSync(lockDir);
  } catch {
    /* left to go stale */
  }
}

function attempt(path: string, staleMs: number, options: WriterLeaseOptions): Lease | null {
  const lockDir = lockDirOf(path);
  // Taken before the `mkdir`, so the time it proves ownership by can only
  // be overstated, never understated.
  const startedAt = performance.now();
  if (!tryCreateLock(lockDir, staleMs)) return null;
  const stamped = stampNewLock(lockDir, startedAt, staleMs, marginFor(staleMs));
  if (stamped === null) return null;
  return new Lease(path, lockDir, staleMs, stamped.identity, stamped.precise, options);
}

function lockedError(path: string): Error {
  return Object.assign(new Error("Lock file is already being held"), {
    code: "ELOCKED",
    file: path,
  });
}

/**
 * Take the writer lock synchronously as a {@link WriterLease}. Retries a
 * few times over half a second, then refuses with `INDEX_LOCKED`. Other
 * filesystem errors are thrown as they are. `path` need not exist; its
 * parent directory must.
 */
export function acquireWriterLeaseSync(
  path: string,
  options: WriterLeaseOptions = {},
): WriterLease {
  const staleMs = resolveWriterLockStaleMs();
  const maxAttempts = 10;
  const sleepMs = 50;
  for (let i = 0; i < maxAttempts; i++) {
    const lease = attempt(path, staleMs, options);
    if (lease !== null) return lease;
    if (i < maxAttempts - 1) Bun.sleepSync(sleepMs);
  }
  throw contentionError(lockedError(path));
}

export function acquireWriterLockSync(path: string): () => void {
  const lease = acquireWriterLeaseSync(path);
  return () => lease.release();
}

/**
 * Take the writer lock on the LIVE index path as a {@link WriterLease}.
 * Shared by `Store.open({ mode: "write" })` and `reindexVault`'s
 * rebuild+swap so both serialise on the SAME lock (keyed on `dbPath`, not
 * on the `.new` staging path). Fast-fails to `INDEX_LOCKED` after a few
 * retries a second apart rather than blocking indefinitely, matching the
 * module's fail-fast contention contract; every failure, a filesystem one
 * included, is reported that way, except a lock directory that was created
 * but cannot be stamped, and a folder that refuses the lock
 * (`LockDirectoryRefusedError` and the probe fault beside it, as on the
 * sync path), which are faults of the filesystem and are thrown as
 * themselves. `path` need not exist yet (a fresh
 * reindex has no live index); only its parent directory must.
 */
export async function acquireWriterLease(
  path: string,
  options: WriterLeaseOptions = {},
): Promise<WriterLease> {
  const retries = 3;
  const delayMs = 1_000;
  // A malformed override is a configuration error, not contention.
  const staleMs = resolveWriterLockStaleMs();
  try {
    for (let i = 0; i <= retries; i++) {
      const lease = attempt(path, staleMs, options);
      if (lease !== null) return lease;
      if (i < retries) await Bun.sleep(delayMs);
    }
    throw lockedError(path);
  } catch (e) {
    if ((e as { lockStampFailure?: boolean } | null)?.lockStampFailure === true) throw e;
    // A folder that refuses the lock is its own fault, as on the sync path:
    // reported as contention it would send the operator after a holder
    // that does not exist.
    if (isNamedLockFault(e)) throw e;
    throw contentionError(e);
  }
}

export async function acquireWriterLock(dbPath: string): Promise<() => Promise<void>> {
  const lease = await acquireWriterLease(dbPath);
  return async () => lease.release();
}

/**
 * Whether the writer lock on `dbPath` is held by a live holder RIGHT NOW.
 *
 * ADVISORY, and only that. It answers about the instant it is called: the
 * lock can be taken or released the moment after it returns, so a caller
 * that acts on `false` is not excluded from anything - {@link
 * acquireWriterLock} is the only thing that excludes. What this buys is
 * cheaper contention, not exclusion: a caller about to start a rebuild it
 * can already see will lose can decline to start it at all.
 *
 * Same stale window as both acquire paths, so a lock whose holder was
 * SIGKILLed reads as free here exactly when it would be taken over there.
 * A stale lock is reported free without being removed - removing it is the
 * acquiring writer's business.
 *
 * Throws whatever the stat failed with (EACCES, ELOOP). It does NOT
 * collapse an unreadable lock directory to `false`: "the lock is free" and
 * "I could not find out" are different answers, and a caller that treats
 * the second as the first has been told something untrue.
 */
export function isWriterLockHeld(dbPath: string): boolean {
  const staleMs = resolveWriterLockStaleMs();
  try {
    return statSync(lockDirOf(dbPath)).mtimeMs >= Date.now() - staleMs;
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return false;
    throw err;
  }
}

/**
 * A cheap check-in for long synchronous loops (the index walk, the brain
 * store catch-up): refreshes every lease this process holds that is due,
 * and reports a lease found lost (a write-mode store's `onLost` refuses
 * the loop from here). A no-op syscall-wise until a lease is a heartbeat
 * old.
 */
export function writerLeaseCheckIn(): void {
  for (const lease of [...liveLeases]) lease.checkIn();
}

/**
 * Run `fn`, which blocks this thread, with every lease this process holds
 * kept fresh from a worker thread for at most `budgetMs`.
 *
 * The budget is the bound on the lease, not on `fn`: once it runs out the
 * worker stops refreshing, so a holder wedged inside `fn` goes stale one
 * stale window later and the next writer takes the lock over. Callers pass
 * the timeout the call is killed at (a `spawnSync` timeout) plus a margin,
 * or {@link WRITER_LEASE_BLOCKING_BUDGET_MS} for a call without one. The
 * worker refreshes under the same ownership check as the main thread, so a
 * lock another writer took over is marked lost, never refreshed, and the
 * loss is reported when `fn` returns. A worker that dies or never starts
 * only stops refreshing: the lease goes stale, which is the safe failure,
 * and {@link WriterLease.assertHeld} reports it.
 *
 * When `fn` returns, the worker is stopped and, once it has let go of every
 * lease, terminated; it never outlives the call by more than a refresh in
 * flight. Leases taken inside `fn` are not covered. Nested calls each run
 * their own worker with their own budget, so an outer budget does not cut
 * an inner one short; the shared mutex keeps their refreshes from
 * overlapping.
 */
export function keepWriterLeasesFresh<T>(budgetMs: number, fn: () => T): T {
  const leases = [...liveLeases].filter((l) => l.active);
  if (leases.length === 0) return fn();
  // Ownership proven, and a fresh beat, before the protected work starts:
  // a lease already lost refuses it here with INDEX_LOCKED, and a fresh
  // beat gives the worker a whole stale window to start in.
  for (const lease of leases) lease.assertHeld();
  const control = new Int32Array(new SharedArrayBuffer(8));
  let worker: Worker | null = null;
  try {
    worker = new Worker(REFRESHER_SOURCE, {
      eval: true,
      workerData: {
        control: control.buffer,
        budgetMs,
        leases: leases.map((l) => ({
          sab: l.sab,
          lockDir: l.lockDir,
          staleMs: l.staleMs,
          marginMs: l.marginMs,
          heartbeatMs: l.heartbeatMs,
        })),
      },
    });
    worker.unref();
    // A worker failure is the safe one (the lease goes stale); it must
    // not surface as an unhandled error event.
    worker.on("error", () => {});
  } catch {
    worker = null;
  }
  const finish = (fnFailed: boolean): void => {
    if (worker !== null) stopRefresher(worker, control);
    // Ownership proven again once the blocking work is over: a worker that
    // ran out of budget stops without marking anything, so only a fresh
    // check tells whether the lock outlived `fn`. A loss refuses with
    // INDEX_LOCKED when `fn` itself succeeded; a failure of `fn` stays the
    // error the caller sees.
    let loss: unknown = null;
    for (const lease of leases) {
      // A lease `fn` released itself is not a loss.
      if (lease.released) continue;
      try {
        lease.assertHeld();
      } catch (err) {
        loss ??= err;
      }
    }
    if (loss !== null && !fnFailed) throw loss;
  };
  let result: T;
  try {
    result = fn();
  } catch (err) {
    finish(true);
    throw err;
  }
  finish(false);
  return result;
}

/**
 * Stop a refresher. One that never started is cancelled and terminated at
 * once. A running one is woken, waited for until it has let go of every
 * lease (bounded by {@link MUTEX_WAIT_MS}), then terminated; one that does
 * not answer in time (a filesystem call that hangs) is left to finish on
 * its own, since terminating it mid-refresh could leave a lease's mutex
 * taken for good.
 */
function stopRefresher(worker: Worker, control: Int32Array): void {
  Atomics.store(control, CONTROL_STOP, 1);
  Atomics.notify(control, CONTROL_STOP);
  const cancelled =
    Atomics.compareExchange(control, CONTROL_PHASE, PHASE_PENDING, PHASE_CANCELLED) ===
    PHASE_PENDING;
  if (!cancelled) {
    const deadline = Date.now() + MUTEX_WAIT_MS;
    while (Atomics.load(control, CONTROL_PHASE) === PHASE_RUNNING) {
      const left = deadline - Date.now();
      if (left <= 0) return;
      Atomics.wait(control, CONTROL_PHASE, PHASE_RUNNING, left);
    }
  }
  void worker.terminate().catch(() => {});
}
