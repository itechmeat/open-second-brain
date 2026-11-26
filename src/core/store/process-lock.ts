/**
 * A device-local lock held for as long as its holder's process runs: for a
 * long synchronous critical section, such as a dream pass (the dream pass
 * lock, `brain/dream-owner/owner.ts`).
 *
 * Such a section cannot use a lock whose staleness is judged by age
 * ({@link withLocalLock} takes a lock over after sixty seconds, and nothing
 * refreshes it while the thread is busy): a long holder would lose it, and
 * the next holder would then run beside it. The holder is judged by its
 * process instead, with the rule the migration gate uses
 * (`store-migration/holder-liveness.ts`):
 *
 *  - The lock is a file created exclusively (`tryCreateLockFile`) that
 *    records the holder's pid, its start identity
 *    (`store-migration/process-identity.ts`), when it was taken and a
 *    random token.
 *  - A holder whose process is gone, or whose pid now names another
 *    process, is taken over at once.
 *  - A holder whose process runs keeps the lock for as long as it runs,
 *    however long that is.
 *  - Only a holder that cannot be checked (its pid is alive but its start
 *    identity could not be read, or the record cannot be read) falls back
 *    to the age rule, {@link STORE_LOCK_STALE_MS}.
 *
 * Taking, taking over and releasing run under the short device-local
 * mutex of the same name (`withLocalLock`), so two waiters never both
 * remove a stale holder, and a release removes the file only while it
 * still carries its own token.
 *
 * A waiter waits within the shared lock budget
 * (`OPEN_SECOND_BRAIN_LOCK_WAIT_MS`) and is then refused with an `ELOCKED`
 * error that names the holder.
 */

import { randomBytes } from "node:crypto";
import { readFileSync, statSync, unlinkSync, writeSync } from "node:fs";

import { resolveLockWaitBudgetMs } from "../brain/sync-lockfile.ts";
import { sleepSync } from "../fs-atomic.ts";
import { tryCreateLockFile } from "../fs-lock.ts";
import { holderLiveness } from "../store-migration/holder-liveness.ts";
import { processStartIdentity } from "../store-migration/process-identity.ts";
import { STORE_LOCK_STALE_MS, withLocalLock } from "./local-lock.ts";

/** Suffix of the holder file beside the lock target. */
const HOLDER_SUFFIX = ".holder";

/** Upper bound of one sleep between attempts. */
const RETRY_SLEEP_MAX_MS = 100;

interface ProcessLockHolder {
  readonly pid: number;
  readonly started: string | null;
  readonly at: number;
  readonly token: string;
}

type HolderSeen =
  | { readonly kind: "absent" }
  | { readonly kind: "record"; readonly holder: ProcessLockHolder }
  | { readonly kind: "unreadable"; readonly mtimeMs: number };

export interface ProcessLockOptions {
  /** What the refusal calls the lock ("dream pass lock"). */
  readonly label?: string;
  /** What the refusal tells the operator to do next. */
  readonly remedy?: string;
  /** Clock of the age rule and of the record (default `Date.now`). */
  readonly now?: () => number;
  /** Longest wait for a live holder (default: the shared lock budget). */
  readonly budgetMs?: number;
}

let ownStartIdentity: string | null | undefined;

/** This process's start identity, read once per process. */
function selfIdentity(): string | null {
  if (ownStartIdentity === undefined) ownStartIdentity = processStartIdentity(process.pid);
  return ownStartIdentity;
}

function parseHolder(text: string): ProcessLockHolder | null {
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    const { pid, started, at, token } = v;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
    if (typeof at !== "number" || typeof token !== "string") return null;
    if (started !== null && typeof started !== "string") return null;
    return { pid, started, at, token };
  } catch {
    return null;
  }
}

function readHolder(path: string): HolderSeen {
  let text: string;
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    throw err;
  }
  const holder = parseHolder(text);
  return holder === null ? { kind: "unreadable", mtimeMs } : { kind: "record", holder };
}

/** Whether the holder seen may be taken over now. */
function abandoned(seen: HolderSeen, now: number): boolean {
  if (seen.kind === "absent") return true;
  // A record being written, or one that is not a record: the age rule.
  if (seen.kind === "unreadable") return now - seen.mtimeMs > STORE_LOCK_STALE_MS;
  const liveness = holderLiveness(seen.holder.pid, seen.holder.started);
  if (liveness === "dead") return true;
  if (liveness === "alive") return false;
  return now - seen.holder.at > STORE_LOCK_STALE_MS;
}

function removeIfMissing(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

function describeHolder(seen: HolderSeen): string {
  if (seen.kind === "record") {
    return `held by process ${seen.holder.pid} since ${new Date(seen.holder.at).toISOString()}`;
  }
  return seen.kind === "unreadable" ? "held by a holder whose record cannot be read" : "held";
}

/**
 * Take the lock named by `lockTarget` (a path in the device-local state
 * directory; the holder file is `<lockTarget>.holder`, the mutex
 * `<lockTarget>.lock`) and return its release. Waits for a live holder within
 * the budget, then throws an `ELOCKED` error naming the holder.
 */
export function acquireProcessLock(
  lockTarget: string,
  options: ProcessLockOptions = {},
): () => void {
  const now = options.now ?? Date.now;
  const budgetMs = options.budgetMs ?? resolveLockWaitBudgetMs();
  const holderPath = `${lockTarget}${HOLDER_SUFFIX}`;
  const record = (): ProcessLockHolder => ({
    pid: process.pid,
    started: selfIdentity(),
    at: now(),
    token: randomBytes(16).toString("hex"),
  });
  const started = Date.now();
  // The mutex around the holder record is held for one file create or
  // read: it waits within this lock's own budget, never the longer wait
  // of a background pass that may be taking this lock.
  for (let attempt = 0; ; attempt++) {
    const answer = withLocalLock(
      lockTarget,
      (): { token: string } | HolderSeen => {
        const mine = record();
        const write = (fd: number): void => {
          writeSync(fd, JSON.stringify(mine));
        };
        if ("created" in tryCreateLockFile(holderPath, write)) return { token: mine.token };
        const seen = readHolder(holderPath);
        if (!abandoned(seen, now())) return seen;
        removeIfMissing(holderPath);
        if ("created" in tryCreateLockFile(holderPath, write)) return { token: mine.token };
        return readHolder(holderPath);
      },
      budgetMs,
    );
    if ("token" in answer) {
      const token = answer.token;
      return () => {
        withLocalLock(
          lockTarget,
          () => {
            const seen = readHolder(holderPath);
            if (seen.kind === "record" && seen.holder.token === token) removeIfMissing(holderPath);
          },
          budgetMs,
        );
      };
    }
    const waited = Date.now() - started;
    if (waited >= budgetMs) {
      const refused: NodeJS.ErrnoException = new Error(
        `${options.label ?? "process lock"} busy: ${lockTarget}: ${describeHolder(answer)}, ` +
          `still held after waiting ${waited} ms; ` +
          `${options.remedy ?? "retry once the holder finishes"}, or allow a longer wait with ` +
          "OPEN_SECOND_BRAIN_LOCK_WAIT_MS=<milliseconds>",
      );
      refused.code = "ELOCKED";
      refused.path = lockTarget;
      throw refused;
    }
    // Jittered, growing sleep so waiters do not wake in lockstep.
    sleepSync(1 + Math.floor(Math.random() * Math.min(RETRY_SLEEP_MAX_MS, 5 + attempt * 10)));
  }
}

/**
 * Whether the lock named by `lockTarget` is held now by a holder that may
 * not be taken over: a live process, or one that cannot be checked and is
 * younger than the age rule. Reads only; takes nothing. A holder record
 * that cannot be read for another reason than its absence counts as held:
 * unknown is not free.
 */
export function processLockHeld(lockTarget: string, now: () => number = Date.now): boolean {
  let seen: HolderSeen;
  try {
    seen = readHolder(`${lockTarget}${HOLDER_SUFFIX}`);
  } catch {
    return true;
  }
  return !abandoned(seen, now());
}
