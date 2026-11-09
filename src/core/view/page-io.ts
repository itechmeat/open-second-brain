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

import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { NO_LINK_CODES } from "../store/blobs.ts";
import { VIEW_PAGE_EXT, VIEW_TEMP_PREFIX } from "./constants.ts";

/** The bytes of a page, or `null` when it does not exist. */
export function readPage(path: string): Buffer | null {
  try {
    return readFileSync(path);
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
        replaced = readFileSync(away);
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

/** Syncthing: `.sync-conflict-<YYYYMMDD>-<HHMMSS>-<device id prefix>`. */
const SYNCTHING_COPY_RE = /^\.sync-conflict-\d{8}-\d{6}-[a-z0-9]{7}$/;
/** Dropbox, Nextcloud and similar: ` (<who>conflicted copy <date ...>)`. */
const CONFLICTED_COPY_RE = /^ \([^)]*conflicted copy[^)]*\d{4}-\d{2}-\d{2}[^)]*\)$/;

/**
 * Conflict copies a sync tool made of the page at `path`: Syncthing's
 * `<name>.sync-conflict-<stamp>.md`, and the `<name> (conflicted copy ...).md`
 * form other sync clients use.
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
  return names
    .filter((name) => {
      const lower = name.toLowerCase();
      if (!lower.endsWith(VIEW_PAGE_EXT) || lower.startsWith(VIEW_TEMP_PREFIX)) return false;
      const middle = lower.slice(0, -VIEW_PAGE_EXT.length);
      if (!middle.startsWith(stem)) return false;
      // Only the stamped shapes sync tools make: a user's own
      // `about-me (conflict notes).md` is not a copy of the page.
      const rest = middle.slice(stem.length);
      return SYNCTHING_COPY_RE.test(rest) || CONFLICTED_COPY_RE.test(rest);
    })
    .toSorted()
    .map((name) => join(dir, name));
}

/** Remove a conflict copy once its content is in the store. */
export function removeCopy(path: string): void {
  removeQuietly(path);
}
