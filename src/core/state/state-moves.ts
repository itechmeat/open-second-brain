/**
 * The file moves that keep machine state following the machine
 * (`machine-state.ts`): adopting a folder another location kept, and
 * seeding a relocated folder once from the state a vault still holds.
 *
 * Both run on every path resolution, in processes that run side by side
 * (hooks, the MCP server, the CLI), so neither may lose a byte:
 *
 *  - a copy lands under its final name only when complete (written to a
 *    temp name beside it, then hard-linked into place, never over a file
 *    another process put there first), so a target that exists is a
 *    whole file; on a filesystem without hard links the copy is written
 *    exclusively under the final name instead, so a file another process
 *    published is still never replaced;
 *  - a source file is removed only once the target holds the same bytes,
 *    checked again right before the removal, or the source was kept
 *    aside; a newer source that meets an older target is kept aside,
 *    never dropped;
 *  - the moved state holds secrets, keys and token maps, so every folder
 *    a move creates is owner-only (`0700` on POSIX, the owner-only ACL on
 *    Windows) and every file it copies is `0600` on POSIX;
 *  - a temp name of an unfinished copy is never taken for state;
 *  - a symbolic link or any other entry that is not a regular file is
 *    left where it is;
 *  - a step that fails (a file open on Windows, a full disk) leaves the
 *    source in place for the next process.
 */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  openSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";

import { restrictToOwner } from "../brain/secrets/owner-acl.ts";

/** Folder beside an adoption target holding files that met a different live copy. */
export const ADOPT_CONFLICTS_DIR = "adopt-conflicts";

/** Infix of the temp name a copy is written under before it is published. */
const TEMP_INFIX = ".adopt-";
const TEMP_NAME_RE = /^\..+\.adopt-[0-9a-f]{12}$/;

/**
 * Every regular file at or below `path`, leaving out the temp file of a
 * copy in flight (or one a crash left): it is not state.
 */
export function filesBelow(path: string): string[] {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return [];
  }
  if (stat.isFile()) return TEMP_NAME_RE.test(basename(path)) ? [] : [path];
  if (!stat.isDirectory()) return [];
  return readdirSync(path)
    .toSorted()
    .flatMap((name) => filesBelow(join(path, name)));
}

/** Whether two files hold the same bytes; the sizes are compared first. */
function sameBytes(a: string, b: string): boolean {
  try {
    if (statSync(a).size !== statSync(b).size) return false;
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

/**
 * Create `dir` and its missing parents owner-only: `0700` on POSIX, the
 * owner-only ACL on the topmost folder created on Windows (the folders
 * below it inherit it).
 */
function mkdirOwnerOnly(dir: string): void {
  const created = mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (created !== undefined && process.platform === "win32") restrictToOwner(created, "directory");
}

/** Write `bytes` to `path` only if no file has that name, flushed to disk. */
function writeExclusive(path: string, bytes: Buffer): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    tryUnlink(path);
    throw err;
  }
  closeSync(fd);
}

function tryUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Left for the next process.
  }
}

/**
 * Copy `file` to `target` unless `target` exists: through a temp name, so
 * the target name only ever names a whole file, and without replacing a
 * file another process put there meanwhile. True when this call made it.
 */
function copyNoClobber(file: string, target: string): boolean {
  if (existsSync(target)) return false;
  mkdirOwnerOnly(dirname(target));
  const temp = join(
    dirname(target),
    `.${basename(target)}${TEMP_INFIX}${randomBytes(6).toString("hex")}`,
  );
  // The copy keeps the source's times, as the state's readers may age it.
  const { atime, mtime } = statSync(file);
  try {
    copyFileSync(file, temp, constants.COPYFILE_EXCL);
    if (process.platform !== "win32") chmodSync(temp, 0o600);
    utimesSync(temp, atime, mtime);
    try {
      // A hard link refuses an existing name: the exclusive publish.
      linkSync(temp, target);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    }
    // A filesystem without hard links: an exclusive write under the final
    // name, which refuses a file another process published meanwhile (a
    // rename would replace it).
    try {
      writeExclusive(target, readFileSync(temp));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
    utimesSync(target, atime, mtime);
    return true;
  } finally {
    if (existsSync(temp)) tryUnlink(temp);
  }
}

/** Remove the empty folders at and below `dir`, deepest first. */
function removeEmptyDirs(dir: string): void {
  let stat;
  try {
    stat = lstatSync(dir);
  } catch {
    return;
  }
  if (!stat.isDirectory()) return;
  for (const name of readdirSync(dir)) removeEmptyDirs(join(dir, name));
  try {
    rmdirSync(dir);
  } catch {
    // Not empty (a kept entry), or busy: left in place.
  }
}

/** Whether the target or a kept-aside copy still holds `file`'s bytes. */
function sameLanded(file: string, target: string, aside: string, rel: string): boolean {
  if (sameBytes(file, target)) return true;
  for (let n = 0; n < 100; n++) {
    const kept = join(aside, n === 0 ? rel : `${rel}.${n}`);
    if (!existsSync(kept)) return false;
    if (sameBytes(file, kept)) return true;
  }
  return false;
}

/**
 * Keep `file` at `<aside>/<rel>`, or at the first free `<rel>.<n>` when an
 * earlier conflict holds other bytes there: no kept copy is replaced.
 * True once a copy with the file's bytes is there.
 */
function keepAside(file: string, aside: string, rel: string): boolean {
  for (let n = 0; n < 100; n++) {
    const kept = join(aside, n === 0 ? rel : `${rel}.${n}`);
    if (sameBytes(file, kept)) return true;
    if (!existsSync(kept)) {
      copyNoClobber(file, kept);
      if (sameBytes(file, kept)) return true;
    }
  }
  return false;
}

/**
 * Move every regular file below `from` into `to` (see the module
 * docblock). A file `to` already holds with the same bytes is already
 * there; one it holds with other bytes is kept aside at
 * `<parent of to>/adopt-conflicts/<name of from>/<path>`. Each source file
 * is removed once it is safe; the emptied folders go with it. True when
 * nothing of `from` is left to move. Never throws.
 */
export function adoptFolder(from: string, to: string): boolean {
  if (from === to) return true;
  if (!existsSync(from)) return true;
  let settled = true;
  const aside = join(dirname(to), ADOPT_CONFLICTS_DIR, basename(from));
  for (const file of filesBelow(from)) {
    const rel = relative(from, file);
    const target = join(to, rel);
    try {
      const landed =
        copyNoClobber(file, target) || sameBytes(file, target) || keepAside(file, aside, rel);
      // Checked again right before the removal: a process still on the old
      // root may have written the source since it was copied.
      if (!landed || !sameLanded(file, target, aside, rel)) {
        settled = false;
        continue;
      }
      unlinkSync(file);
    } catch {
      settled = false;
    }
  }
  removeEmptyDirs(from);
  return settled && filesBelow(from).length === 0;
}

/**
 * Copy every regular file below `from` that `to` lacks, once: `marker`
 * records the seeding, so a file deleted from `to` later is not brought
 * back. `from` is only read. Never throws; a failed seeding is retried by
 * the next process.
 */
export function seedFolderOnce(from: string, to: string, marker: string): void {
  if (existsSync(marker) || !existsSync(from)) return;
  try {
    const seeded: string[] = [];
    for (const file of filesBelow(from)) {
      const rel = relative(from, file);
      if (copyNoClobber(file, join(to, rel))) seeded.push(rel.split(sep).join("/"));
    }
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, `${JSON.stringify({ from, seeded }, null, 2)}\n`);
  } catch {
    // Retried by the next process.
  }
}
