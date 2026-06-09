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
