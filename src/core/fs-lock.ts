/**
 * One answer to "is this failed lock create a held lock?", shared by every
 * lock Open Second Brain takes, and the `proper-lockfile` attempts built on
 * it.
 *
 * A lock is a name created exclusively: a directory (`mkdir`, the
 * `proper-lockfile` form and the search writer lease) or a file (an
 * exclusive `open`, `brain/sync-lockfile.ts` and the claim files). The
 * create fails with `EEXIST` while someone holds the name, and every lock
 * waits that out within its own budget.
 *
 * Windows adds a second answer. A name another process has just removed
 * stays "delete pending" until the last handle to it closes, and creating
 * that name meanwhile fails with `EPERM` (or `EACCES`) instead of `EEXIST`;
 * even an `lstat` of it is refused that way. Under the race the locks
 * exist for (several agent sessions appending at once) a writer that loses
 * by microseconds to a releasing holder gets that code, and by the time it
 * looks the name may already be gone. A directory that really refuses new
 * entries (an ACL, Controlled Folder Access, a read-only mount, POSIX
 * permission bits) answers the same codes. {@link isHeldLockCreateError}
 * tells them apart the same way on every platform:
 *
 * 1. something is at the name (it can be `lstat`ed): held;
 * 2. otherwise a uniquely named sibling is created and removed in the
 *    same directory. If that works the directory accepts entries and the
 *    refusal was a release going through: held, wait and retry. If the
 *    probe is refused as well the directory refuses writes:
 *    {@link LockDirectoryRefusedError}, at once, with the directory named.
 *
 * On POSIX a create in a directory that accepts entries never answers
 * `EPERM`/`EACCES`, so there the probe only turns a refusal into the
 * named error; the extra `mkdir` runs on that failure path alone. A
 * read-only mount (`EROFS`) is that refusal too, named at once without a
 * probe.
 *
 * A refusal whose name turns out to be free (case 2) is a release going
 * through, not a holder: {@link tryCreateLockName} creates the name again
 * at once and a few times over a few tens of milliseconds, whatever wait
 * the lock itself allows, and only a name that stays refused that long
 * counts as held. So a lock with no wait budget, or a claim made right
 * after removing a dead holder's claim, is not lost to a release that has
 * already finished.
 *
 * Two failures are neither contention nor something a wait can clear, and
 * both are surfaced at once with their path and cause: a lock name this
 * process may not REMOVE ({@link LockRemovalRefusedError} - the lock
 * library removes a stale lock directory itself, and POSIX can refuse that
 * removal), and a record that could not be WRITTEN into a name this process
 * had just created ({@link tryCreateLockFile}). A write that fails
 * is not a holder, so the file the create made is removed again and the
 * write's error is the answer.
 */

import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";

import lockfile from "proper-lockfile";

import { sleepSync } from "./fs-atomic.ts";

/**
 * Prefix of the probe {@link isHeldLockCreateError} makes beside a lock
 * name. The probe's name is short and independent of the lock's, so a lock
 * name at the longest component length still has a probe that fits.
 */
export const LOCK_PROBE_PREFIX = ".o2b-lock-probe-";

/**
 * The sleeps between the creates {@link tryCreateLockName} makes while a
 * refused name is free (a release going through): at once, then twice more
 * a little later. About 40 ms in all, on that failure path alone.
 */
const RELEASE_SETTLE_DELAYS_MS: readonly number[] = [0, 10, 30];

/** The exclusive-create primitive used by a lock family. */
export type LockCreateKind = "directory" | "file";

/** A lock name whose directory refuses new entries: not contention, never retried. */
export class LockDirectoryRefusedError extends Error {
  readonly code: string;
  readonly path: string;

  constructor(lockPath: string, cause: NodeJS.ErrnoException) {
    const code = cause.code ?? "EPERM";
    const path = resolve(lockPath);
    const remedy =
      code === "EROFS"
        ? "it is on a read-only mount; keep this data on a writable mount"
        : "give this user write access to that directory";
    super(
      `cannot take the lock ${path}: its directory ${dirname(path)} refuses new ` +
        `entries (${code}); ${remedy}`,
      { cause },
    );
    this.name = "LockDirectoryRefusedError";
    this.code = code;
    this.path = path;
  }
}

/**
 * The probe {@link isHeldLockCreateError} made could not be removed: the
 * directory accepts entries but refuses this user their removal. Never
 * retried, since each attempt would leave one more probe behind.
 */
export class LockProbeCleanupError extends Error {
  readonly path: string;

  constructor(probe: string, cause: unknown) {
    super(`cannot remove lock probe ${probe}`, { cause });
    this.name = "LockProbeCleanupError";
    this.path = probe;
  }
}

/**
 * A stale lock name could not be removed, and nothing says a release is
 * going through: the removal was refused and the name is still there (a
 * POSIX sticky parent that holds another user's directory, a read-only
 * mount, an ACL).
 *
 * This is not contention. Nobody holds the name - it is the residue of a
 * holder that is gone - and waiting cannot clear it: the refusal is about
 * this user's right to remove the name, not about who has it. So it is
 * surfaced with its path and cause instead of being waited out and reported
 * as a lock that is busy.
 *
 * A removal refused while the name is ON ITS WAY OUT is not this error: a
 * name another process has just removed stays delete pending on Windows
 * until its last handle closes, and it refuses both the removal and any
 * look at it. That refusal says a release is going through, so the attempt
 * is made again over the settle window and, if it is still refused there,
 * waited out within the lock's own budget like any lock changing hands.
 */
export class LockRemovalRefusedError extends Error {
  readonly code: string;
  readonly path: string;

  constructor(lockPath: string, cause: NodeJS.ErrnoException) {
    const code = cause.code ?? "EPERM";
    const path = resolve(lockPath);
    super(
      `cannot remove the stale lock ${path}: the removal was refused (${code}); ` +
        "another user may own it, or this user may not remove it",
      { cause },
    );
    this.name = "LockRemovalRefusedError";
    this.code = code;
    this.path = path;
  }
}

/**
 * Whether `err` is a fault the lock code itself named about the lock's
 * directory or its removal ({@link LockDirectoryRefusedError},
 * {@link LockProbeCleanupError}, {@link LockRemovalRefusedError}): neither
 * contention nor a transient failure, so never waited out, retried or
 * reported as another holder.
 */
export function isNamedLockFault(err: unknown): boolean {
  return (
    err instanceof LockDirectoryRefusedError ||
    err instanceof LockProbeCleanupError ||
    err instanceof LockRemovalRefusedError
  );
}

function codeOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

/** The codes a create gets from a name being deleted (Windows) or a refusing directory. */
function isRefusalCode(code: string | undefined): boolean {
  return code === "EPERM" || code === "EACCES";
}

/**
 * The syscalls that remove a lock name. A refusal that came from one of
 * them is a removal that failed, not a create that was refused, and the two
 * are answered differently: a refused create may be a lock changing hands,
 * a refused removal never is.
 */
const REMOVAL_SYSCALLS: ReadonlySet<string> = new Set(["rmdir", "unlink", "rm"]);

/**
 * Whether `err` came from removing the lock name rather than from creating
 * it: the lock library removes a stale lock directory itself, and that
 * removal can be refused (a POSIX sticky parent that holds another user's
 * directory answers `EPERM` for `rmdir`).
 */
function isRemovalRefusal(err: unknown): boolean {
  const syscall = (err as NodeJS.ErrnoException | null)?.syscall;
  return typeof syscall === "string" && REMOVAL_SYSCALLS.has(syscall);
}

/**
 * Whether a refused removal of `lockPath` says that a release is going
 * through: the name cannot be looked at (the Windows delete-pending
 * reading - a name another process has just removed stays in the directory
 * until its last handle closes, and refuses any look at it) or it is
 * already gone.
 *
 * A name that is still there says the opposite: the removal cannot be
 * done (a POSIX sticky parent holding another user's directory, a
 * read-only mount), and waiting does not change that. A look that fails
 * for an unexpected reason says nothing either way, so it is read as
 * "the removal cannot be done" and the refusal is surfaced.
 */
export function isRemovalRefusalTransient(lockPath: string): boolean {
  try {
    return !nameExists(lockPath);
  } catch {
    return false;
  }
}

/** Whether something is at `path`: it can be `lstat`ed. */
function nameExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (err) {
    const code = codeOf(err);
    if (code === "ENOENT" || isRefusalCode(code)) return false;
    throw Object.assign(new Error(`cannot inspect lock path ${path}`, { cause: err }), { path });
  }
}

/** Make and remove a probe with the same exclusive-create primitive as the lock. */
function directoryAcceptsEntries(lockPath: string, kind: LockCreateKind): boolean {
  const probe = join(dirname(lockPath), `${LOCK_PROBE_PREFIX}${randomBytes(6).toString("hex")}`);
  try {
    if (kind === "directory") {
      mkdirSync(probe);
    } else {
      const fd = openSync(probe, "wx", 0o600);
      try {
        closeSync(fd);
      } catch (err) {
        try {
          unlinkSync(probe);
        } catch (cleanupErr) {
          throw new LockProbeCleanupError(probe, cleanupErr);
        }
        throw Object.assign(new Error(`cannot close lock probe ${probe}`, { cause: err }), {
          path: probe,
        });
      }
    }
  } catch (err) {
    if (isRefusalCode(codeOf(err))) return false;
    // Any other answer (the directory itself vanished, a full disk) is not
    // the question this probe asks; the caller's error stands.
    throw err;
  }
  try {
    if (kind === "directory") rmdirSync(probe);
    else unlinkSync(probe);
  } catch (err) {
    throw new LockProbeCleanupError(probe, err);
  }
  return true;
}

/**
 * What a failed exclusive create of a lock name met: `held`, another holder
 * has the name (`EEXIST`, `ELOCKED` from `proper-lockfile`, or a refusal
 * while something is at the name); `releasing`, the create was refused but
 * the name is free and its directory accepts entries, a release going
 * through (Windows); `removal-refused`, the removal of a stale name was
 * refused while the name is still there, so the removal cannot be done.
 */
export type LockCreateAnswer = "held" | "releasing" | "removal-refused";

/**
 * Classify `err`, thrown by an exclusive create of the lock name `lockPath`
 * (or by the `stat` a lock library runs on it): a {@link LockCreateAnswer},
 * or null for every other error, which the caller rethrows as it is.
 * Throws {@link LockDirectoryRefusedError} when the refusal is the
 * directory's own (a read-only mount included), {@link LockProbeCleanupError}
 * when the probe cannot be removed, {@link LockRemovalRefusedError} when the
 * refusal came from removing the name (a stale lock this process may not
 * remove), and an error naming the path when the name cannot be inspected.
 */
export function classifyLockCreateError(
  err: unknown,
  lockPath: string,
  kind: LockCreateKind,
): LockCreateAnswer | null {
  const code = codeOf(err);
  if (code === "EEXIST" || code === "ELOCKED") return "held";
  // A removal that was refused is not a create that was refused: the lock
  // library removes a stale lock name itself, and that removal can be
  // refused. The two refusals are told apart by the name, the same way the
  // create path tells its own apart:
  //
  // - a name that cannot be looked at is on its way out (on Windows a name
  //   another process has just removed is delete pending, and it refuses
  //   any look at it): a release is going through, so the attempt is made
  //   again over the settle window, and a name that is still refused there
  //   is waited out within the lock's own budget;
  // - a name that is still there says the removal cannot be done (a POSIX
  //   sticky parent holding another user's directory, a read-only mount),
  //   and waiting cannot clear that: it is answered by its own error, with
  //   the path and the cause, and never as a held lock.
  if (isRemovalRefusal(err)) {
    return isRemovalRefusalTransient(lockPath) ? "releasing" : "removal-refused";
  }
  if (code === "EROFS") throw new LockDirectoryRefusedError(lockPath, err as NodeJS.ErrnoException);
  if (!isRefusalCode(code)) return null;
  if (nameExists(lockPath)) return "held";
  if (directoryAcceptsEntries(lockPath, kind)) return "releasing";
  throw new LockDirectoryRefusedError(lockPath, err as NodeJS.ErrnoException);
}

/**
 * Whether `err`, thrown by an exclusive create of the lock name `lockPath`
 * (or by the `stat` a lock library runs on it), means another holder has
 * the lock: `EEXIST`, or an `EPERM`/`EACCES` from a name being released
 * (Windows). Throws {@link LockDirectoryRefusedError} when the refusal is
 * the directory's own; false for every other error, which the caller
 * rethrows as it is.
 */
export function isHeldLockCreateError(
  err: unknown,
  lockPath: string,
  kind: LockCreateKind,
): boolean {
  const answer = classifyLockCreateError(err, lockPath, kind);
  // A removal that was refused is not a holder: nobody has the name.
  return answer === "held" || answer === "releasing";
}

/** The outcome of {@link tryCreateLockName}: the create's result, or the error of a held name. */
export type LockCreateOutcome<T> = { readonly created: T } | { readonly held: unknown };

/**
 * Create the lock name `lockPath` exclusively with `create`: its result, or
 * `held` with the create's error when another holder has the name. A
 * refusal of a free name (a release going through) is created again at
 * once, then after the short settle sleeps, and counts as held only while
 * it lasts past them. A refused removal of a stale name is created again
 * over the same settle window - that window is the test for whether the
 * removal clears - and is answered by {@link LockRemovalRefusedError} when
 * it does not. Throws what {@link classifyLockCreateError} throws, and
 * every error that is no lock answer as it is.
 */
export function tryCreateLockName<T>(
  lockPath: string,
  kind: LockCreateKind,
  create: () => T,
): LockCreateOutcome<T> {
  for (let settle = 0; ; settle++) {
    try {
      return { created: create() };
    } catch (err) {
      const answer = classifyLockCreateError(err, lockPath, kind);
      if (answer === null) throw err;
      const delay = RELEASE_SETTLE_DELAYS_MS[settle];
      if (delay === undefined) {
        // The settle window is over: a removal that is still refused cannot
        // be done, and that is its own error, not a lock that is held.
        if (answer === "removal-refused") {
          throw new LockRemovalRefusedError(lockPath, err as NodeJS.ErrnoException);
        }
        return { held: err };
      }
      if (answer === "held") return { held: err };
      if (delay > 0) sleepSync(delay);
    }
  }
}

/** {@link tryCreateLockName} for an asynchronous create. */
export async function tryCreateLockNameAsync<T>(
  lockPath: string,
  kind: LockCreateKind,
  create: () => Promise<T>,
): Promise<LockCreateOutcome<T>> {
  for (let settle = 0; ; settle++) {
    try {
      // Creates are sequential by nature: each follows the refusal before.
      // oxlint-disable-next-line no-await-in-loop
      return { created: await create() };
    } catch (err) {
      const answer = classifyLockCreateError(err, lockPath, kind);
      if (answer === null) throw err;
      const delay = RELEASE_SETTLE_DELAYS_MS[settle];
      if (delay === undefined) {
        // The settle window is over: a removal that is still refused cannot
        // be done, and that is its own error, not a lock that is held.
        if (answer === "removal-refused") {
          throw new LockRemovalRefusedError(lockPath, err as NodeJS.ErrnoException);
        }
        return { held: err };
      }
      if (answer === "held") return { held: err };
      // oxlint-disable-next-line no-await-in-loop
      if (delay > 0) await new Promise((done) => setTimeout(done, delay));
    }
  }
}

/**
 * The identity of the file a create made: device and inode as exact bigints,
 * or null when the platform reports no identity.
 */
function identityOfCreated(fd: number): { readonly dev: bigint; readonly ino: bigint } | null {
  try {
    const st = fstatSync(fd, { bigint: true });
    return { dev: st.dev, ino: st.ino };
  } catch {
    return null;
  }
}

/**
 * Remove the file a failed write left behind, but only while the name still
 * names the file this call created: a takeover between the create and the
 * failed write belongs to whoever took it over.
 */
function removeCreatedLockFile(
  lockPath: string,
  identity: { readonly dev: bigint; readonly ino: bigint } | null,
): void {
  try {
    if (identity !== null) {
      const st = lstatSync(lockPath, { bigint: true });
      if (st.dev !== identity.dev || st.ino !== identity.ino) return;
    }
    unlinkSync(lockPath);
  } catch {
    // already gone, or a name this call does not own: nothing to remove
  }
}

/**
 * Take the lock name `lockPath` as a FILE, and write what the caller holds
 * into it: an exclusive create, then the caller's write into the file the
 * create made. Its result, or `held` with the create's error when another
 * holder has the name.
 *
 * The create and the write are two steps on purpose. The create is what the
 * classifier reads (does the name hold a lock, or is a release going
 * through?), and a write that fails is not contention: the file is there,
 * so a refusal from the write would read as a held name, and the caller
 * would wait out a budget - and read an empty claim as a holder of unknown
 * identity - for a failure that waiting cannot clear. So a write that fails
 * removes the file this call created and is thrown as it is.
 *
 * The write is the caller's own, so the record a claim keeps stays visible
 * where the claim is taken.
 */
export function tryCreateLockFile(
  lockPath: string,
  write: (fd: number) => void,
): LockCreateOutcome<void> {
  const outcome = tryCreateLockName(lockPath, "file", () => openSync(lockPath, "wx"));
  if ("held" in outcome) return outcome;
  const fd = outcome.created;
  const identity = identityOfCreated(fd);
  let writeError: unknown;
  try {
    write(fd);
  } catch (err) {
    writeError = err;
  }
  try {
    closeSync(fd);
  } catch {
    // the file is closed either way; the write's answer is what matters
  }
  if (writeError !== undefined) {
    removeCreatedLockFile(lockPath, identity);
    throw writeError;
  }
  return { created: undefined };
}

/** The error a single lock attempt throws when the lock is held. */
function heldError(lockPath: string, cause: unknown): NodeJS.ErrnoException {
  const held: NodeJS.ErrnoException = new Error(`Lock file is already being held: ${lockPath}`, {
    cause,
  });
  held.code = "ELOCKED";
  held.path = lockPath;
  return held;
}

/** The options every `proper-lockfile` lock here passes. */
export interface DirLockAttemptOptions {
  /** Age after which the lock directory counts as abandoned. */
  readonly stale: number;
}

/**
 * One attempt at the `proper-lockfile` directory lock of `target`
 * (`<target>.lock`): its release, or an `ELOCKED` error when another holder
 * has it, Windows' delete-pending answer included. A directory that refuses
 * new entries throws {@link LockDirectoryRefusedError}; any other failure
 * is rethrown as it is.
 */
export function lockDirSync(target: string, options: DirLockAttemptOptions): () => void {
  const lockPath = `${resolve(target)}.lock`;
  const outcome = tryCreateLockName(lockPath, "directory", () =>
    lockfile.lockSync(target, { stale: options.stale, realpath: false }),
  );
  if ("created" in outcome) return outcome.created;
  throw codeOf(outcome.held) === "ELOCKED" ? outcome.held : heldError(lockPath, outcome.held);
}

/** How {@link lockDir} waits between attempts. */
export interface DirLockWaitOptions extends DirLockAttemptOptions {
  /** Attempts after the first one. */
  readonly retries: number;
  /** First sleep between attempts, in milliseconds. */
  readonly minTimeoutMs: number;
  /** Longest sleep between attempts, in milliseconds. */
  readonly maxTimeoutMs: number;
  /** Growth of the sleep from one attempt to the next. */
  readonly factor?: number;
  /**
   * Additional acquisition failures to retry, a failed look at a refused
   * name included; named faults of the directory ({@link isNamedLockFault})
   * stay immediate.
   */
  readonly retryOnError?: (error: unknown) => boolean;
}

/**
 * The asynchronous `proper-lockfile` directory lock of `target`, retried
 * while it is held (Windows' delete-pending answer included) as the options
 * say, then refused with `ELOCKED`. The release is asynchronous, and the
 * lock keeps its mtime fresh while held, as `proper-lockfile` does. A
 * directory that refuses new entries fails at the first attempt.
 */
export async function lockDir(
  target: string,
  options: DirLockWaitOptions,
): Promise<() => Promise<void>> {
  const lockPath = `${resolve(target)}.lock`;
  let delay = options.minTimeoutMs;
  for (let attempt = 0; ; attempt++) {
    let outcome: LockCreateOutcome<() => Promise<void>>;
    try {
      // Attempts are sequential by nature: each waits for the one before.
      // oxlint-disable-next-line no-await-in-loop
      outcome = await tryCreateLockNameAsync(lockPath, "directory", () =>
        lockfile.lock(target, { stale: options.stale, realpath: false, retries: 0 }),
      );
    } catch (err) {
      // Neither held nor releasing: the create failed, or the look at
      // the refused name did. Opted-in callers retry such a failure
      // within the same budget; a named fault of the directory never.
      if (isNamedLockFault(err) || !options.retryOnError?.(err) || attempt >= options.retries) {
        throw err;
      }
      // oxlint-disable-next-line no-await-in-loop
      await new Promise((done) => setTimeout(done, delay));
      delay = Math.min(options.maxTimeoutMs, delay * (options.factor ?? 1));
      continue;
    }
    if ("created" in outcome) return outcome.created;
    if (attempt >= options.retries) {
      throw codeOf(outcome.held) === "ELOCKED" ? outcome.held : heldError(lockPath, outcome.held);
    }
    // oxlint-disable-next-line no-await-in-loop
    await new Promise((done) => setTimeout(done, delay));
    delay = Math.min(options.maxTimeoutMs, delay * (options.factor ?? 1));
  }
}
