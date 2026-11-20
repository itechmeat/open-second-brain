/**
 * File handling of view pages for the render protocol (design D7 "No
 * silent loss"): read a page, find the conflict copies a sync tool made of
 * it, and replace it with a new render so that the bytes it replaces are
 * always captured.
 *
 * Replacing a page:
 *
 *  1. the new text goes to a temp file beside the page;
 *  2. the page is read once more; if it changed since the writer checked
 *     it, nothing is replaced and the caller starts over;
 *  3. the page is renamed away to a second temp name. A rename is atomic,
 *     so this captures exactly the bytes that were on disk at that
 *     instant, including an edit a sync tool delivered after step 2;
 *  4. the temp file is linked to the page name, which fails when a sync
 *     tool created the page again in the instant between 3 and 4: that
 *     file is then left as it is and the caller starts over. Where the
 *     filesystem has no hard links, an exclusive write, flushed to disk,
 *     puts the page in place, failing the same way; any other failure
 *     leaves no partial page and puts the captured page back;
 *  5. the temp file is removed, and the captured bytes are returned so the
 *     caller can keep them and ingest an edit they carry; the captured file
 *     is removed only once the caller has stored them.
 *
 * Temp names start with {@link VIEW_TEMP_PREFIX}; they exist for
 * milliseconds, and a sync setup should ignore them.
 */

import { sameDevIno } from "../fs-identity.ts";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  lstatSync,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import { basename, dirname, join } from "node:path";

import { READ_NO_FOLLOW_FLAGS } from "../derived-store-guard.ts";
import { syncConflictOriginalName } from "../brain/ledger-shards.ts";
import { NO_LINK_CODES } from "../store/blobs.ts";
import { VIEW_PAGE_EXT, VIEW_TEMP_PREFIX } from "./constants.ts";

/** A page name that is not a regular file (a symbolic link, a folder): never read through. */
export class NotAPageFileError extends Error {
  readonly code = "ENOTPAGE";
  constructor(path: string) {
    super(`not a regular file, left alone: ${path}`);
    this.name = "NotAPageFileError";
  }
}

/** Open errors of `O_NOFOLLOW` on a symbolic link (`EMLINK` on FreeBSD). */
const LINK_REFUSED_CODES: ReadonlySet<string> = new Set(["ELOOP", "EMLINK"]);

/**
 * The bytes of the regular file at `path`, never following a symbolic
 * link: a sync tool or another process may put a link under a page name
 * after the path was checked. The `lstat` check refuses a link on every
 * platform; where the platform has `O_NOFOLLOW` the open refuses one too,
 * and the opened descriptor is checked again, so a link or a folder
 * swapped in between is never read through.
 */
function readRegular(path: string): Buffer {
  if (!lstatSync(path).isFile()) throw new NotAPageFileError(path);
  let fd: number;
  try {
    fd = openSync(path, READ_NO_FOLLOW_FLAGS);
  } catch (err) {
    if (LINK_REFUSED_CODES.has(errnoCode(err) ?? "")) throw new NotAPageFileError(path);
    throw err;
  }
  try {
    if (!fstatSync(fd).isFile()) throw new NotAPageFileError(path);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** The bytes of a page, or `null` when it does not exist. */
export function readPage(path: string): Buffer | null {
  try {
    return readRegular(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }
}

function sameBytes(a: Buffer | null, b: Buffer | null): boolean {
  return a === null || b === null ? a === b : a.equals(b);
}

function tempName(dir: string, label: string): string {
  return join(dir, `${VIEW_TEMP_PREFIX}${randomBytes(6).toString("hex")}-${label}${VIEW_PAGE_EXT}`);
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

/** What a replacement did. */
export type ReplaceOutcome =
  /** The page changed after it was checked; nothing was replaced. */
  | { readonly status: "changed" }
  /** The page is the new text. `replaced`: the bytes it replaced (`null`: there was no page). */
  | { readonly status: "placed"; readonly replaced: Buffer | null; readonly discard: () => void }
  /** The page was renamed away, but a new page appeared before the new text could take its name. */
  | {
      readonly status: "lost-race";
      readonly replaced: Buffer | null;
      readonly discard: () => void;
    };

export interface ReplaceHooks {
  /**
   * Called after the re-check and before the page is captured. A seam
   * only so a test can land a sync tool's write in that window, which no
   * test can hit by timing; production never sets it.
   */
  readonly beforeCapture?: (path: string) => void;
}

/**
 * Create `path` with `bytes`, failing with `EEXIST` when a file has that
 * name. A write that fails once the file is created removes it: a partial
 * file of ours never stays under the name.
 */
function writeExclusive(path: string, bytes: Buffer): void {
  const fd = openSync(path, "wx");
  try {
    let written = 0;
    while (written < bytes.length) written += writeSync(fd, bytes, written);
    // On disk before the name points at it: after a power loss a page
    // must never read as an empty or truncated file (a mass edit).
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    removeQuietly(path);
    throw err;
  }
  closeSync(fd);
}

/**
 * Replace the page at `path` with `bytes`, provided it still holds
 * `checked`. The captured old page stays under its temp name until the
 * caller has stored its bytes and calls `discard`, so a crash in between
 * leaves it recoverable in the view folder rather than lost.
 */
export function replacePage(
  path: string,
  bytes: Buffer,
  checked: Buffer | null,
  hooks: ReplaceHooks = {},
): ReplaceOutcome {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const temp = tempName(dir, "new");
  writeExclusive(temp, bytes);
  try {
    if (!sameBytes(readPage(path), checked)) return { status: "changed" };
    hooks.beforeCapture?.(path);
    const away = tempName(dir, "old");
    let captured = false;
    try {
      renameSync(path, away);
      captured = true;
    } catch (err) {
      if (errnoCode(err) !== "ENOENT") throw err;
    }
    let replaced: Buffer | null = null;
    if (captured) {
      try {
        replaced = readRegular(away);
      } catch (err) {
        // Unreadable right now (an antivirus or indexer holds it): the page
        // goes back under its name, never left away.
        restore(away, path);
        throw err;
      }
    }
    const discard = (): void => removeQuietly(away);
    try {
      linkSync(temp, path);
    } catch (err) {
      const code = errnoCode(err);
      if (code === "EEXIST") return { status: "lost-race", replaced, discard };
      if (code === undefined || !NO_LINK_CODES.has(code)) {
        if (replaced !== null) restore(away, path);
        throw err;
      }
      // No hard links here: an exclusive write, flushed before it counts,
      // which fails rather than overwrite a page a sync tool created
      // meanwhile. Any other failure leaves no partial page of ours and
      // puts the captured page back.
      try {
        writeExclusive(path, bytes);
      } catch (writeErr) {
        if (errnoCode(writeErr) === "EEXIST") return { status: "lost-race", replaced, discard };
        if (replaced !== null) restore(away, path);
        throw writeErr;
      }
    }
    return { status: "placed", replaced, discard };
  } finally {
    removeQuietly(temp);
  }
}

/**
 * Put a captured page back when the new text could not be placed for an
 * unexpected reason, and remove the captured name once it is back. When it
 * cannot go back (a page appeared meanwhile: it is newer, kept), the
 * captured bytes stay under their temp name, recoverable.
 */
function restore(away: string, path: string): void {
  try {
    linkSync(away, path);
  } catch (err) {
    if (errnoCode(err) === "EEXIST") return;
    // No hard links here: an exclusive write of the captured bytes, never
    // a rename, which would replace a page a sync tool created meanwhile.
    try {
      writeExclusive(path, readFileSync(away));
    } catch {
      return; // kept under the temp name
    }
  }
  removeQuietly(away);
}

/** A page taken out of its name, its bytes captured, until the caller settles it. */
export interface CapturedPage {
  readonly bytes: Buffer;
  /** Remove the captured file, once its bytes are stored or known to be the writer's own. */
  readonly discard: () => void;
  /** Put the page back under its name (a new page under that name is newer and kept). */
  readonly restore: () => void;
}

/**
 * Take the page at `path` away from its name for removal: one atomic
 * rename captures exactly the bytes on disk at that instant, an edit a
 * sync tool delivered a moment before included. `null` when there is no
 * page. The captured file keeps a temp name until the caller discards or
 * restores it, so a crash in between leaves it recoverable.
 */
export function capturePage(path: string): CapturedPage | null {
  const away = tempName(dirname(path), "old");
  try {
    renameSync(path, away);
  } catch (err) {
    if (errnoCode(err) === "ENOENT" || errnoCode(err) === "ENOTDIR") return null;
    throw err;
  }
  let bytes: Buffer;
  try {
    bytes = readRegular(away);
  } catch (err) {
    if (err instanceof NotAPageFileError) putBackOther(away, path);
    else restore(away, path);
    throw err;
  }
  return { bytes, discard: () => removeQuietly(away), restore: () => restore(away, path) };
}

/**
 * Put a captured name that is not a regular file (a folder, a symbolic
 * link) back under its name, never replacing a name that exists now: a
 * link is made again (which fails on an existing name) and never followed,
 * a folder is renamed back (a rename never replaces a file or a non-empty
 * folder), and anything else only while the name is free. When it cannot
 * go back it stays under its temp name, nothing lost.
 */
function putBackOther(away: string, path: string): void {
  try {
    const stat = lstatSync(away);
    if (stat.isSymbolicLink()) {
      symlinkSync(readlinkSync(away), path);
      removeQuietly(away);
    } else if (stat.isDirectory() || lstatOrNull(path) === null) {
      renameSync(away, path);
    }
  } catch {
    // kept under the temp name
  }
}

/**
 * Conflict copies a sync tool made of the page at `path`: Syncthing's
 * `<name>.sync-conflict-<stamp>.md`, and the `<name> (conflicted copy ...).md`
 * form other sync clients use. The names are recognised in one place
 * (`brain/ledger-shards.ts`, `syncConflictOriginalName`): a user's own
 * `about-me (conflict notes).md` is not a copy of the page.
 */
export function conflictCopies(path: string): string[] {
  const dir = dirname(path);
  const stem = basename(path, VIEW_PAGE_EXT).toLowerCase();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const own = `${stem}${VIEW_PAGE_EXT}`;
  return names
    .filter((name) => {
      const lower = name.toLowerCase();
      if (!lower.endsWith(VIEW_PAGE_EXT) || lower.startsWith(VIEW_TEMP_PREFIX)) return false;
      // Matched on the lowercased name: a stamp spelled in capitals is a copy too.
      return syncConflictOriginalName(lower) === own;
    })
    .toSorted()
    .map((name) => join(dir, name));
}

/**
 * Move what the user keeps in a topic folder (companion files beside the
 * writer's pages) into the folder the topic moved to, when a rename moved
 * its page. `skip` names the writer's own pages; temp files and names the
 * new folder already has stay where they are; `only`, when given, limits
 * the move to those names. Best effort: a file that cannot move stays in
 * the old folder, which is then kept.
 */
export function moveCompanions(
  fromDir: string,
  toDir: string,
  skip: ReadonlySet<string>,
  only?: ReadonlySet<string>,
): void {
  for (const name of listCompanions(fromDir, skip)) {
    if (only !== undefined && !only.has(name)) continue;
    try {
      mkdirSync(toDir, { recursive: true });
      moveNoReplace(join(fromDir, name), join(toDir, name));
    } catch {
      // left in the old folder
    }
  }
}

/** The companion names in `dir` (none when it cannot be read): every name but `skip` and temp files. */
export function listCompanions(dir: string, skip: ReadonlySet<string>): string[] {
  try {
    return readdirSync(dir).filter((n) => !skip.has(n) && !n.startsWith(VIEW_TEMP_PREFIX));
  } catch {
    return [];
  }
}

/**
 * Whether two stats are one version of one file: same file (device and
 * inode as bigint, `fs-identity.ts`), same size, same modification time.
 */
function sameVersion(a: BigIntStats, b: BigIntStats | null): boolean {
  return b !== null && sameDevIno(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs;
}

function lstatOrNull(path: string): BigIntStats | null {
  try {
    return lstatSync(path, { bigint: true });
  } catch {
    return null;
  }
}

/**
 * Move `from` to `to` without ever replacing a `to` that exists, even one
 * a sync tool creates in the same instant: a file is linked to its new
 * name (which fails on an existing name) and then unlinked, or, where the
 * file system has no hard links, copied exclusively; a folder is renamed
 * only onto no name (a rename may replace an empty folder, never a file
 * or a non-empty folder). A symbolic link is left where it is.
 *
 * A move that cannot finish is taken back: when the old name holds another
 * version by the time it would be removed (a sync tool delivered a newer
 * one), or cannot be removed (Windows reports a file another program
 * holds as `EPERM`, the same code as "no hard links"), the new name is
 * taken back and the file stays where it was. Neither name is ever
 * unlinked live: each is first renamed to a temp name, and only the
 * version checked is removed there, so a version a sync tool delivers
 * under either name meanwhile is put back, never deleted. One case is
 * left: a file another program holds open against deletion can be linked
 * but neither name can then be removed, so it stays under both names
 * until that program lets go.
 */
function moveNoReplace(from: string, to: string): void {
  const stat = lstatSync(from, { bigint: true });
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    if (existsSync(to)) return;
    renameSync(from, to);
    return;
  }
  // The version this move put under the new name: the source itself for a
  // link, the copy as written otherwise.
  let placed = stat;
  try {
    linkSync(from, to);
  } catch (err) {
    const code = errnoCode(err);
    if (code === undefined || !NO_LINK_CODES.has(code)) throw err;
    copyFileSync(from, to, fsConstants.COPYFILE_EXCL);
    placed = lstatSync(to, { bigint: true });
  }
  const now = lstatOrNull(from);
  if (now === null) return; // gone meanwhile: the new name holds the only copy
  if (!sameVersion(stat, now)) {
    removeIfVersion(to, placed);
    return;
  }
  const away = tempName(dirname(from), "move");
  try {
    renameSync(from, away);
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return; // gone meanwhile, as above
    removeIfVersion(to, placed);
    throw err;
  }
  if (sameVersion(stat, lstatOrNull(away))) {
    removeQuietly(away);
    return;
  }
  // A newer version took the old name between the check and the rename:
  // it goes back under that name, and the move is taken back.
  restore(away, from);
  removeIfVersion(to, placed);
}

/**
 * Remove `path` only while it is still the version `ours` (the name this
 * move created): it is renamed to a temp name first and checked there, so
 * a file a sync tool put under the name meanwhile is put back, not removed.
 */
function removeIfVersion(path: string, ours: BigIntStats): void {
  const away = tempName(dirname(path), "back");
  try {
    renameSync(path, away);
  } catch {
    return; // gone already
  }
  if (sameVersion(ours, lstatOrNull(away))) removeQuietly(away);
  else restore(away, path);
}

/** Remove a page folder once nothing is left in it; a folder with anything in it stays. */
export function removeEmptyFolder(dir: string): void {
  try {
    rmdirSync(dir);
  } catch {
    // not empty, or already gone
  }
}
