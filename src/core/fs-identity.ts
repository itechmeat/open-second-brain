/**
 * One answer to "are these the same file on disk?": the device and the
 * inode, as `bigint`.
 *
 * Node's default `Stats` carries `dev` and `ino` as JavaScript numbers.
 * NTFS file ids are 64-bit (a 48-bit record number under a 16-bit sequence
 * number), so on Windows they routinely exceed 2^53, the largest integer a
 * number holds exactly: two different files whose ids differ only in the
 * low bits can read as one, and a check built on that equality can judge
 * two folders the same (a move refused as "the folder would nest inside
 * itself"), or a replaced file as the one that was opened. Every identity
 * comparison goes through here instead, on `{ bigint: true }` stats.
 *
 * An inode of 0 is a filesystem that reports none (some network and FAT
 * volumes): such a file has no identity here, and two of them are never
 * judged the same.
 */
import { fstatSync, lstatSync, statSync } from "node:fs";

/** A file's place on disk: its device and its inode, exactly. */
export interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

/** The identity `bigint` stats describe, or null when the filesystem reports no inode. */
export function identityOfStats(stat: {
  readonly dev: bigint;
  readonly ino: bigint;
}): FileIdentity | null {
  return stat.ino === 0n ? null : { dev: stat.dev, ino: stat.ino };
}

/**
 * The identity of the file at `path` (following a symbolic link unless
 * `follow` is false), or null when it is missing, cannot be read or has
 * no inode.
 */
export function pathIdentity(
  path: string,
  options: { readonly follow?: boolean } = {},
): FileIdentity | null {
  try {
    const stat =
      options.follow === false
        ? lstatSync(path, { bigint: true, throwIfNoEntry: false })
        : statSync(path, { bigint: true, throwIfNoEntry: false });
    return stat === undefined ? null : identityOfStats(stat);
  } catch {
    return null;
  }
}

/** The identity of the open descriptor `fd`, or null when it cannot be read or has no inode. */
export function fdIdentity(fd: number): FileIdentity | null {
  try {
    return identityOfStats(fstatSync(fd, { bigint: true }));
  } catch {
    return null;
  }
}

/** Whether `a` and `b` are one file: both known, same device, same inode. */
export function sameIdentity(a: FileIdentity | null, b: FileIdentity | null): boolean {
  return a !== null && b !== null && a.dev === b.dev && a.ino === b.ino;
}

/**
 * Whether two `bigint` stats carry the same device and inode, exactly,
 * an inode of 0 included: for a version or stamp check that also compares
 * size and times, where a filesystem with no inodes must still match the
 * file against itself. A question of identity alone asks
 * {@link sameIdentity}, which never matches two files without an inode.
 */
export function sameDevIno(
  a: { readonly dev: bigint; readonly ino: bigint },
  b: { readonly dev: bigint; readonly ino: bigint },
): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
