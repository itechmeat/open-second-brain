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
 *    itself is the user's choice and may be a link, except in a vault's
 *    reserved store folder ({@link vaultStoreFolders}).
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

import { sameDevIno } from "../fs-identity.ts";
import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readlinkSync,
  realpathSync,
  type Stats,
  unlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { STORE_VAULT_DIR } from "./constants.ts";

/** Mode of every directory the store creates: the owner only. */
export const STORE_DIR_MODE = 0o700;

/** Mode of every file the store creates: the owner only. */
export const STORE_FILE_MODE = 0o600;

/** A path inside a partition that the store refuses to write through. */
export class StoreUnsafePathError extends Error {
  readonly path: string;

  constructor(
    path: string,
    why: string,
    remedy = "remove it and let the store create the path again",
  ) {
    super(
      `refusing to write through ${path} in the brain store: it ${why}. ` +
        `Something other than Open Second Brain put it there (a sync peer, a restore, a manual ` +
        `edit); ${remedy}`,
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

/** Whether the last name of `path` is the vault's reserved store folder name. */
function hasVaultStoreName(path: string): boolean {
  const name = basename(path);
  // Case is folded where the default file system ignores it, as the
  // resolver folds it (`store-paths.ts`).
  return process.platform === "win32" || process.platform === "darwin"
    ? name.toLowerCase() === STORE_VAULT_DIR
    : name === STORE_VAULT_DIR;
}

/** Most links a root configured as an alias is followed through, one by one. */
const ALIAS_HOPS_MAX = 40;

/**
 * The names the alias `root` leads through, one link at a time: each link
 * target in turn (relative ones resolved against the link's folder), up
 * to the first name that is no link. Stops early at a name that cannot
 * be read.
 */
function aliasHops(root: string): string[] {
  const hops: string[] = [];
  let at = root;
  for (let i = 0; i < ALIAS_HOPS_MAX; i++) {
    let target: string;
    try {
      if (!lstatSync(at).isSymbolicLink()) break;
      target = readlinkSync(at);
    } catch {
      break;
    }
    at = resolve(dirname(at), target);
    hops.push(at);
  }
  return hops;
}

/**
 * The folders of the store at `root` that may not be links because `root`
 * is a vault's reserved store folder (`.open-second-brain-store/`): there
 * they arrive with the vault's sync, so a link is no choice of this
 * machine's user, and a record written through it would land wherever it
 * leads. The root itself is one when it is written by that name. A root
 * configured as an alias (a link, or a chain of them) that leads through
 * the reserved folder brings that folder, as named on the way: the alias
 * is the user's choice, the reserved folder is not, so a sync that turns
 * it into a link to a folder of another name is refused at the next write
 * through the same, unchanged alias. Each of `partitionFolders` is one
 * when the root is that folder as written, through an alias, or once its
 * links are resolved. Empty for any other root: an explicit store root
 * outside the vault may be a link, and so may its partition folders.
 */
export function vaultStoreFolders(root: string, partitionFolders: ReadonlyArray<string>): string[] {
  if (hasVaultStoreName(root)) return [root, ...partitionFolders];
  const reserved = aliasHops(root).find(hasVaultStoreName);
  if (reserved !== undefined) return [reserved, ...partitionFolders];
  let real: string;
  try {
    real = realpathSync(root);
  } catch {
    return [];
  }
  return hasVaultStoreName(real) ? [...partitionFolders] : [];
}

/** The first of `folders` that is a symbolic link (on Windows also a junction), or null. */
export function firstLinkedFolder(folders: ReadonlyArray<string>): string | null {
  return folders.find((folder) => lstatOrNull(folder)?.isSymbolicLink() === true) ?? null;
}

/** Why a linked folder of a vault's store is refused, for the open and the write. */
export const VAULT_STORE_LINK_WHY =
  "is a link (or a junction), and the vault's brain store folder and its partition folders, " +
  "which the vault's sync fills, are never opened or written through a link: records would " +
  "go wherever it leads";

/** What to do about a linked folder of a vault's store. */
export const VAULT_STORE_LINK_REMEDY =
  "replace the link with a real folder holding the files it leads to, then start again";

function assertNoVaultStoreLink(folders: ReadonlyArray<string>): void {
  const linked = firstLinkedFolder(folders);
  if (linked !== null) {
    throw new StoreUnsafePathError(linked, VAULT_STORE_LINK_WHY, VAULT_STORE_LINK_REMEDY);
  }
}

/**
 * Make `dir` exist under `partitionRoot` without following any symlink
 * below the partition folder. `dir` must be `partitionRoot` or inside it.
 * In a vault's reserved store folder the store root and the partition
 * folder may not be links either ({@link vaultStoreFolders}).
 */
export function ensureStoreDir(partitionRoot: string, dir: string): void {
  const rel = relative(partitionRoot, dir);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new StoreUnsafePathError(dir, "is outside the partition folder");
  }
  const vaultFolders = vaultStoreFolders(dirname(partitionRoot), [partitionRoot]);
  // Before the create, so nothing is made through a link; after it, as
  // another process may have won the create.
  assertNoVaultStoreLink(vaultFolders);
  mkdirSync(partitionRoot, { recursive: true, mode: STORE_DIR_MODE });
  assertNoVaultStoreLink(vaultFolders);
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
export function openRegularFileForRead(
  path: string | Buffer,
  partitionRoot?: string,
): number | null {
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
    const opened = fstatSync(fd, { bigint: true });
    // Without O_NOFOLLOW (Windows) the open follows whatever is at the
    // name: a link swapped in after the lstat shows here.
    keep =
      opened.isFile() &&
      (NO_FOLLOW !== 0 || nameIsOpenedFile(path, opened)) &&
      (partitionRoot === undefined ||
        isRealDirBelowPartition(partitionRoot, dirname(path.toString())));
  } finally {
    if (!keep) closeSync(fd);
  }
  return keep ? fd : null;
}

/**
 * The name's `bigint` lstat, or null when it is gone. These checks run
 * where the open cannot refuse a link (Windows, no `O_NOFOLLOW`), whose
 * NTFS file ids exceed what a number holds exactly (`fs-identity.ts`).
 */
function lstatBigOrNull(path: string | Buffer): BigIntStats | null {
  try {
    return lstatSync(path, { bigint: true });
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return null;
    throw err;
  }
}

/** Whether the name `path` still refers to the file `opened` describes, and is no link. */
function nameIsOpenedFile(path: string | Buffer, opened: BigIntStats): boolean {
  const now = lstatBigOrNull(path);
  return now !== null && !now.isSymbolicLink() && sameDevIno(now, opened);
}

/** The name `path` still refers to the file `opened` describes, and is no link. */
function assertNameIsOpenedFile(path: string, opened: BigIntStats): void {
  const now = lstatBigOrNull(path);
  if (now === null) throw new StoreUnsafePathError(path, "was removed while it was opened");
  if (now.isSymbolicLink()) throw new StoreUnsafePathError(path, "is a symbolic link");
  if (!sameDevIno(now, opened)) {
    throw new StoreUnsafePathError(path, "was replaced while it was opened");
  }
}

/**
 * Create `path` as a new, empty store file for writing (a temp file the
 * caller renames into place), never through a link: whatever a sync or a
 * crash left at the name (a stale temp, a symbolic link a peer synced) is
 * removed first, without following it, and the open is exclusive
 * (`O_CREAT | O_EXCL`, so a link put back at the name fails it) with
 * `O_NOFOLLOW` where defined; where not (Windows) the name is checked to be
 * the opened file after the open. Something other than a file or a link at
 * the name (a folder) is refused.
 */
export function createStoreTempFile(path: string): number {
  const left = lstatOrNull(path);
  if (left !== null) {
    if (left.isDirectory() && !left.isSymbolicLink()) {
      throw new StoreUnsafePathError(path, "is a directory");
    }
    unlinkSync(path);
  }
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      STORE_FILE_MODE,
    );
  } catch (err) {
    if (errnoCode(err) === "ELOOP") throw new StoreUnsafePathError(path, "is a symbolic link");
    throw err;
  }
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile()) throw new StoreUnsafePathError(path, "is not a regular file");
    if (NO_FOLLOW === 0) assertNameIsOpenedFile(path, stat);
  } catch (err) {
    closeSync(fd);
    throw err;
  }
  return fd;
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
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile()) throw new StoreUnsafePathError(path, "is not a regular file");
    if (stat.nlink > 1n) throw new StoreUnsafePathError(path, `has ${stat.nlink} hard links`);
    // Without O_NOFOLLOW (Windows) the open itself follows whatever is at
    // the name: a link swapped in after the first lstat shows here.
    if (NO_FOLLOW === 0) assertNameIsOpenedFile(path, stat);
  } catch (err) {
    closeSync(fd);
    throw err;
  }
  return fd;
}
