/**
 * Symlink-safe directories and files inside a partition of the brain store.
 *
 * A partition is a sync folder: anything a peer or the sync tool delivers
 * lands in it, symlinks included (Syncthing replicates them on POSIX
 * hosts). A writer that followed such a link would append a record line,
 * or create a blob, wherever the link points, outside the store. So every
 * write goes through here:
 *
 *  - {@link ensureStoreDir} walks from the partition folder to the target
 *    directory one component at a time with `lstat`, creates what is
 *    missing with mode `0700`, and refuses a component that is a symlink
 *    (on Windows `lstat` reports junctions and other name-surrogate
 *    reparse points the same way) or not a directory. The partition folder
 *    itself is the user's choice and may be a link.
 *  - {@link openShardForAppend} refuses a shard name that is a symlink,
 *    opens it with `O_NOFOLLOW` where the platform has it (elsewhere it
 *    checks after the open that the name is still that file and no link;
 *    mode `0600` for a new shard), and checks the open file: a regular
 *    file with one link.
 *    A hard link would let a peer's file and a file outside the store be
 *    the same file.
 *
 * Every refusal is a {@link StoreUnsafePathError} naming the path; the
 * dual write counts it as a failure and keeps the legacy write.
 */

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

/** Mode of every directory the store creates: the owner only. */
export const STORE_DIR_MODE = 0o700;

/** Mode of every file the store creates: the owner only. */
export const STORE_FILE_MODE = 0o600;

/** A path inside a partition that the store refuses to write through. */
export class StoreUnsafePathError extends Error {
  readonly path: string;

  constructor(path: string, why: string) {
    super(
      `refusing to write through ${path} in the brain store: it ${why}. ` +
        "Something other than Open Second Brain put it there (a sync peer, a restore, a manual " +
        "edit); remove it and let the store create the path again",
    );
    this.name = "StoreUnsafePathError";
    this.path = path;
  }
}

function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

/** `lstat`, or `null` when nothing is at `path`. */
function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return null;
    throw err;
  }
}

function assertRealDirectory(path: string): void {
  const stat = lstatOrNull(path);
  if (stat === null) return;
  if (stat.isSymbolicLink()) throw new StoreUnsafePathError(path, "is a symbolic link");
  if (!stat.isDirectory()) throw new StoreUnsafePathError(path, "is not a directory");
}

/**
 * Make `dir` exist under `partitionRoot` without following any symlink
 * below the partition folder. `dir` must be `partitionRoot` or inside it.
 */
export function ensureStoreDir(partitionRoot: string, dir: string): void {
  const rel = relative(partitionRoot, dir);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new StoreUnsafePathError(dir, "is outside the partition folder");
  }
  mkdirSync(partitionRoot, { recursive: true, mode: STORE_DIR_MODE });
  let current = partitionRoot;
  for (const part of rel === "" ? [] : rel.split(sep)) {
    current = join(current, part);
    assertRealDirectory(current);
    try {
      mkdirSync(current, { mode: STORE_DIR_MODE });
    } catch (err) {
      if (errnoCode(err) !== "EEXIST") throw err;
    }
    // Checked again after the create: another process may have won it.
    assertRealDirectory(current);
  }
}

/** `O_NOFOLLOW` where the platform defines it (not on Windows), else 0. */
export const NO_FOLLOW: number = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

/** `O_NONBLOCK` where the platform defines it (not on Windows), else 0. */
const NON_BLOCK: number = (constants as { O_NONBLOCK?: number }).O_NONBLOCK ?? 0;

/**
 * Whether `dir` is `partitionRoot` or inside it and every directory below
 * the partition folder on the way to it is a real directory, by `lstat`:
 * no symbolic link, and on Windows no junction or other name-surrogate
 * reparse point. A missing component is not a directory. The partition
 * folder itself is the user's choice and may be a link.
 */
export function isRealDirBelowPartition(partitionRoot: string, dir: string): boolean {
  const rel = relative(partitionRoot, dir);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
  let current = partitionRoot;
  for (const part of rel === "" ? [] : rel.split(sep)) {
    current = join(current, part);
    const stat = lstatOrNull(current);
    if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()) return false;
  }
  return true;
}

/**
 * Open `path` read-only only when it is a regular file, or `null` when it
 * is not: a symlink is never followed (`O_NOFOLLOW` where defined; where
 * not, the `lstat` before the open and a check after it that the name is
 * still the opened file) and a FIFO swapped in after the
 * `lstat` is never blocked on (`O_NONBLOCK`, then `fstat`). A missing file
 * throws `ENOENT` as `openSync` does.
 *
 * With `partitionRoot`, the file must also have been reached without a
 * link at any directory below the partition folder
 * ({@link isRealDirBelowPartition}), checked after the open: a linked
 * stream or device folder a peer synced could otherwise hand the reader
 * another partition's records, or files outside the store, under this
 * partition's name.
 */
export function openRegularFileForRead(path: string, partitionRoot?: string): number | null {
  if (!lstatSync(path).isFile()) return null;
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | NO_FOLLOW | NON_BLOCK);
  } catch (err) {
    if (errnoCode(err) === "ELOOP") return null;
    throw err;
  }
  let keep = false;
  try {
    const opened = fstatSync(fd);
    // Without O_NOFOLLOW (Windows) the open follows whatever is at the
    // name: a link swapped in after the lstat shows here.
    keep =
      opened.isFile() &&
      (NO_FOLLOW !== 0 || nameIsOpenedFile(path, opened)) &&
      (partitionRoot === undefined || isRealDirBelowPartition(partitionRoot, dirname(path)));
  } finally {
    if (!keep) closeSync(fd);
  }
  return keep ? fd : null;
}

/** Whether the name `path` still refers to the file `opened` describes, and is no link. */
function nameIsOpenedFile(path: string, opened: Stats): boolean {
  const now = lstatOrNull(path);
  return now !== null && !now.isSymbolicLink() && now.ino === opened.ino && now.dev === opened.dev;
}

/** The name `path` still refers to the file `opened` describes, and is no link. */
function assertNameIsOpenedFile(path: string, opened: Stats): void {
  const now = lstatOrNull(path);
  if (now === null) throw new StoreUnsafePathError(path, "was removed while it was opened");
  if (now.isSymbolicLink()) throw new StoreUnsafePathError(path, "is a symbolic link");
  if (now.ino !== opened.ino || now.dev !== opened.dev) {
    throw new StoreUnsafePathError(path, "was replaced while it was opened");
  }
}

/**
 * Open the shard at `path` for appending (read and append, created with
 * mode `0600` when new). Its directory must already have been made by
 * {@link ensureStoreDir}. Throws {@link StoreUnsafePathError} for a
 * symlink, a non-regular file or a file with more than one link.
 */
export function openShardForAppend(path: string): number {
  const before = lstatOrNull(path);
  if (before?.isSymbolicLink() === true) throw new StoreUnsafePathError(path, "is a symbolic link");
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | NO_FOLLOW,
      STORE_FILE_MODE,
    );
  } catch (err) {
    if (errnoCode(err) === "ELOOP") throw new StoreUnsafePathError(path, "is a symbolic link");
    throw err;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new StoreUnsafePathError(path, "is not a regular file");
    if (stat.nlink > 1) throw new StoreUnsafePathError(path, `has ${stat.nlink} hard links`);
    // Without O_NOFOLLOW (Windows) the open itself follows whatever is at
    // the name: a link swapped in after the first lstat shows here.
    if (NO_FOLLOW === 0) assertNameIsOpenedFile(path, stat);
  } catch (err) {
    closeSync(fd);
    throw err;
  }
  return fd;
}
