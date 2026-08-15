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
 * Stale-lock recovery: on normal process exit the cleanup hook unlinks
 * any still-held locks. On hard crash (SIGKILL, OOM) the `.lock` file
 * stays on disk and the next acquire fails with ELOCKED; the brain
 * doctor surfaces these via {@link scanStaleLocks} so an operator can
 * remove them by hand.
 */

import { closeSync, mkdirSync, openSync, readdirSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

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

  let fd: number;
  try {
    fd = openSync(lockPath, "wx", 0o644);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EEXIST") {
      const collision: NodeJS.ErrnoException = new Error(`lock busy: ${lockPath}`);
      collision.code = "ELOCKED";
      collision.path = lockPath;
      throw collision;
    }
    throw err;
  }

  // Stamp pid + timestamp into the lock body. The contents are
  // purely diagnostic - the doctor surface reads them when reporting
  // stale locks. Failure to write is non-fatal: the lock semantics
  // come from the exclusive create, not from the body.
  try {
    const stamp = Buffer.from(`${process.pid}\n${new Date().toISOString()}\n`, "utf8");
    writeSync(fd, stamp, 0, stamp.byteLength);
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
      try {
        unlinkSync(lockPath);
      } catch {
        // already gone (race with exit hook or manual cleanup); ignore
      }
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
 * Five seconds is generous against a hold measured in milliseconds. Reaching
 * it does not mean "busy", it means something is wrong - most likely a `.lock`
 * left by a crashed process, which `brain doctor` reports via
 * {@link scanStaleLocks} - so the deadline exists to make that surface as a
 * loud `ELOCKED` instead of a hang.
 */
const LOCK_WAIT_BUDGET_MS = 5_000;
const RETRY_SLEEP_CEILING_MS = 25;

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
 * error propagates at once, and an expired budget rethrows the last
 * `ELOCKED` (which names the lock file) rather than proceeding unlocked.
 * Nothing is ever silently skipped.
 */
export function acquireLockSyncWithRetry(
  target: string,
  budgetMs: number = LOCK_WAIT_BUDGET_MS,
): LockHandle {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      return acquireLockSync(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ELOCKED") throw err;
      if (Date.now() >= deadline) throw err;
      Bun.sleepSync(1 + Math.floor(Math.random() * RETRY_SLEEP_CEILING_MS));
    }
  }
}

/**
 * Walk `root` recursively and return every `.lock` file path. Used by
 * `brain_doctor` to surface stale locks left behind by a crashed
 * process.
 */
export function scanStaleLocks(root: string): string[] {
  const out: string[] = [];
  walkLocks(root, out);
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
 */
export function _resetHeldLocksForTests(): void {
  heldLocks.clear();
}
