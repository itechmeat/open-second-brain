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
 * blocking sleep, like every other synchronous lock in this tree.
 *
 * On Windows a released lock directory lingers in a "delete pending" state
 * until the last handle closes, and a `mkdir` of that name meanwhile fails
 * with `EPERM` instead of `EEXIST`. {@link isLockContention} counts that as
 * a held lock, so a writer that loses a race to a releasing holder waits
 * its turn instead of failing; the Brain log lock (`brain/log.ts`) shares
 * the rule.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import lockfile from "proper-lockfile";

import { isWindowsDeletePending, resolveLockWaitBudgetMs } from "../brain/sync-lockfile.ts";
import { sleepSync } from "../fs-atomic.ts";

/** Age after which a lock directory counts as abandoned by a crashed holder. */
export const STORE_LOCK_STALE_MS = 60_000;

/** Upper bound of one sleep between attempts. */
const RETRY_SLEEP_MAX_MS = 20;

/**
 * Whether a failed `proper-lockfile` acquire of `lockTarget` means another
 * holder has the lock: `ELOCKED`, or on Windows an `EPERM`/`EACCES` while
 * the lock directory `<lockTarget>.lock` is still there (a release that
 * has not finished). An `EPERM` with nothing at the name is a directory
 * that refuses writes and stays an error. `platform` is a test seam.
 */
export function isLockContention(
  err: unknown,
  lockTarget: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const e = err as NodeJS.ErrnoException;
  return e.code === "ELOCKED" || isWindowsDeletePending(e, `${lockTarget}.lock`, platform);
}

/** A Windows `EPERM`/`EACCES`, the code a lock create gets while a name is being deleted. */
export function isWindowsRefusal(
  err: unknown,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return platform === "win32" && (code === "EPERM" || code === "EACCES");
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
}

/**
 * Take the `proper-lockfile` directory lock of `lockTarget`
 * (`<lockTarget>.lock`), waiting with jittered, growing sleeps while it is
 * held, and return its release. Throws an `ELOCKED` error naming the
 * target when the lock stays held past the budget; any other failure is
 * rethrown as it is.
 */
export function acquireDirLock(lockTarget: string, options: DirLockOptions): () => void {
  const started = Date.now();
  let refusalRetried = false;
  for (let attempt = 0; ; attempt++) {
    try {
      return lockfile.lockSync(lockTarget, { stale: options.staleMs, realpath: false });
    } catch (err) {
      if (!isLockContention(err, lockTarget)) {
        // A Windows EPERM with nothing at the name is a refusing directory
        // or a release that finished between the mkdir and the check; one
        // more try tells them apart.
        if (refusalRetried || !isWindowsRefusal(err)) throw err;
        refusalRetried = true;
        continue;
      }
      if (Date.now() - started >= options.budgetMs) {
        const refused: NodeJS.ErrnoException = new Error(
          `${options.label} busy: ${lockTarget}: still held after waiting ` +
            `${Date.now() - started} ms; ${options.remedy}`,
          { cause: err },
        );
        refused.code = "ELOCKED";
        refused.path = lockTarget;
        throw refused;
      }
      // Jittered, growing sleep so waiters do not wake in lockstep.
      sleepSync(1 + Math.floor(Math.random() * Math.min(RETRY_SLEEP_MAX_MS, 2 + attempt * 2)));
    }
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
    budgetMs: budgetMs ?? resolveLockWaitBudgetMs(),
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
