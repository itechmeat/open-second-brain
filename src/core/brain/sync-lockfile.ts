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

import { closeSync, mkdirSync, openSync, readdirSync, unlinkSync, writeSync } from "node:fs";
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
 * hold. The tail is long because nothing here is fair - a writer in a loop
 * re-acquires with no backoff at all while every waiter is mid-sleep, so a
 * waiter can lose many draws in a row.
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
  budgetMs: number = LOCK_WAIT_BUDGET_MS,
): LockHandle {
  // A budget this loop cannot honour is named rather than quietly
  // reinterpreted, in the same discipline as `requireCap` and the lease's
  // TTL guard. `NaN` is the reason the guard exists: `Date.now() >= NaN` is
  // false forever, so a non-finite budget turned a bounded freeze into an
  // unbounded one that no signal could break. Zero is legal and means
  // exactly one attempt - the deadline is only consulted after a failure.
  if (!Number.isInteger(budgetMs) || budgetMs < 0) {
    throw new Error(`lock wait budgetMs must be an integer >= 0, got ${budgetMs}`);
  }
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
