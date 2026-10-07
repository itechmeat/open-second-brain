/**
 * Guards for machine-local derived state kept inside a vault
 * (`<vault>/.open-second-brain/...`): hook state, the inject cache, the
 * search focus.
 *
 * A vault can arrive from elsewhere (a clone, a synced folder, an archive),
 * so any directory on the way to a derived file may be a symbolic link to a
 * location outside the vault. Readers and writers of derived state call
 * {@link derivedDirIsSymlinked} first and refuse such a tree, and read the
 * leaf through {@link readRegularFileNoFollow}, which never follows a leaf
 * link. Writers replace the leaf by an atomic rename, which swaps a leaf
 * link for a regular file instead of writing through it.
 */

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";

/** Whether `path` exists and is a symbolic link; `false` when it is absent. */
function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * True when any directory from `<base>/<segments[0]>` down to
 * `<base>/<segments...>` is a symbolic link. `base` itself is trusted: it is
 * the vault (or a location the operator configured), never a name the vault
 * content chose.
 */
export function derivedDirIsSymlinked(base: string, ...segments: readonly string[]): boolean {
  let current = base;
  for (const segment of segments) {
    if (segment.length === 0) continue;
    current = join(current, segment);
    if (isSymlink(current)) return true;
  }
  return false;
}

/** Open flags for a derived-file read: never follow a leaf symlink where the platform can refuse one. */
const READ_NO_FOLLOW_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);

/**
 * Outcome of {@link readRegularFileNoFollow}: the file is `absent`, exists but
 * is `not-regular` (a symbolic link, a directory, a device), could not be read
 * (`unreadable`), or was read (`ok`).
 */
export type NoFollowReadResult =
  | { readonly status: "absent" }
  | { readonly status: "not-regular" }
  | { readonly status: "unreadable" }
  | { readonly status: "ok"; readonly text: string };

/**
 * Read `path` as UTF-8 only when it is a regular file, never following a leaf
 * symbolic link. The `lstat` check refuses a link on every platform; on POSIX
 * the read itself also opens with `O_NOFOLLOW` and re-checks the opened
 * descriptor, so a link swapped in between the two steps is refused too.
 */
export function readRegularFileNoFollow(path: string): NoFollowReadResult {
  try {
    if (!lstatSync(path).isFile()) return { status: "not-regular" };
  } catch {
    return { status: "absent" };
  }
  try {
    const fd = openSync(path, READ_NO_FOLLOW_FLAGS);
    try {
      if (!fstatSync(fd).isFile()) return { status: "not-regular" };
      return { status: "ok", text: readFileSync(fd, "utf8") };
    } finally {
      closeSync(fd);
    }
  } catch {
    return { status: "unreadable" };
  }
}
