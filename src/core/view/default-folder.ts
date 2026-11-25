/**
 * The rename of the default view folder (release 2.0.2): release 2.0.1
 * wrote the readable pages into the vault's `brain-view/` folder, this
 * release writes them into `o2b-memory/`, and the program does the
 * rename itself, on the machine that writes the view, with no command
 * and no action of the user.
 *
 * The rules:
 *
 *  - **Only the default target.** A machine whose `view_target` names
 *    another folder (or turns the view off) is never touched: the folder
 *    it names is the user's, not ours.
 *  - **Only a folder the view wrote.** A page the view writer renders
 *    starts with its own marker (`<!-- open-second-brain-view ... -->`),
 *    so a folder holding no such page is not ours and is left alone.
 *  - **Never lose a file.** A folder that holds a file the view did not
 *    write (a note of the user, a file of another program) keeps its
 *    name: the pages are written into the new folder, the old folder
 *    stays with the user's file in it, and one line says so once.
 *  - **Never lose an edit.** A page of the old folder that is neither
 *    the new folder's copy nor a text the view rendered keeps the old
 *    folder: the render reads the new folder only, so an edit in the old
 *    one is in no store yet.
 *  - **A rename that arrives by sync.** When both folders are there (the
 *    new one delivered by a sync tool, the old one left behind), the old
 *    folder is removed only after the new one holds every page it held,
 *    and only when it holds nothing but pages the view wrote. Only those
 *    pages are removed, then the directories that are left empty: a file
 *    written into the old folder after its scan stays, with its folder.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  LEGACY_VIEW_DEFAULT_DIR,
  VIEW_PAGE_EXT,
  VIEW_STATE_DIR,
  VIEW_TEMP_PREFIX,
} from "./constants.ts";

/** The marker every page the view writer writes starts with. */
const VIEW_MARKER = "<!-- open-second-brain-view";

/** Device-local file: the old folder this machine already told the user about. */
const NOTICE_FILE = "default-folder-notice.json";

/** The old default folder beside the new one: `brain-view/` next to `o2b-memory/`. */
export function legacyDefaultDir(target: string): string {
  return join(dirname(target), LEGACY_VIEW_DEFAULT_DIR);
}

/** What a folder holds: the pages the view wrote, and the files it did not. */
interface FolderScan {
  /** Paths of the pages the view wrote, relative to the folder. */
  readonly written: ReadonlyArray<string>;
  /** Paths of the files the view did not write, relative to the folder. */
  readonly foreign: ReadonlyArray<string>;
}

const EMPTY_SCAN: FolderScan = { written: [], foreign: [] };

/** Whether the file at `path` is a page the view writer wrote. */
function isViewPage(path: string): boolean {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  if (!path.endsWith(VIEW_PAGE_EXT)) return false;
  let head: Buffer;
  try {
    const fd = readFileSync(path);
    head = fd.subarray(0, 200);
  } catch {
    return false;
  }
  return head.toString("utf8").trimStart().startsWith(VIEW_MARKER);
}

/**
 * The pages the view wrote in `dir`, and the files it did not. A folder
 * that cannot be read is reported as holding no page and no file, so the
 * caller leaves it alone.
 */
export function scanViewFolder(dir: string): FolderScan {
  const written: string[] = [];
  const foreign: string[] = [];
  const walk = (at: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      foreign.push(prefix);
      return;
    }
    for (const entry of entries) {
      const name = entry.name;
      const path = join(at, name);
      const rel = prefix === "" ? name : `${prefix}/${name}`;
      if (entry.isDirectory()) {
        walk(path, rel);
        continue;
      }
      if (entry.isSymbolicLink()) {
        foreign.push(rel);
        continue;
      }
      // A temp file of the writer is ours, and travels with the rename.
      if (name.startsWith(VIEW_TEMP_PREFIX)) {
        written.push(rel);
        continue;
      }
      if (isViewPage(path)) written.push(rel);
      else foreign.push(rel);
    }
  };
  try {
    if (!lstatSync(dir).isDirectory()) return EMPTY_SCAN;
  } catch {
    return EMPTY_SCAN;
  }
  walk(dir, "");
  return { written: written.toSorted(), foreign: foreign.toSorted() };
}

/** What the rename did. */
export type DefaultFolderOutcome =
  /** There is no old folder. */
  | { readonly status: "no-legacy" }
  /** The old folder holds no page of the view: it is not ours, and stays. */
  | { readonly status: "not-written" }
  /** The old folder was renamed to the new one. */
  | { readonly status: "renamed"; readonly from: string; readonly to: string }
  /** The old folder was removed: the new one holds every page it held. */
  | { readonly status: "removed"; readonly dir: string }
  /**
   * The old folder holds a file the view did not write, so it stays with
   * it. The files are named, so the user can move them.
   */
  | { readonly status: "kept"; readonly files: ReadonlyArray<string> }
  /**
   * The old folder holds a page that is neither the new folder's copy
   * nor a text the view rendered: the render read the new folder only,
   * so an edit in the old page is in no store. It stays until its content
   * is ingested or kept elsewhere.
   */
  | { readonly status: "divergent"; readonly files: ReadonlyArray<string> }
  /** The new folder does not hold every page of the old one yet: a later pass tries again. */
  | { readonly status: "incomplete" };

/**
 * The rename, before the pages are rendered: the old folder becomes the
 * new one when the new one is not there yet and the old folder holds
 * nothing but pages the view wrote.
 */
export function prepareDefaultFolder(target: string): DefaultFolderOutcome {
  const legacy = legacyDefaultDir(target);
  if (legacy === target) return { status: "no-legacy" };
  if (!existsSync(legacy)) return { status: "no-legacy" };
  if (existsSync(target)) return { status: "incomplete" }; // both are there: settled after the render
  const scan = scanViewFolder(legacy);
  if (scan.written.length === 0) return { status: "not-written" };
  if (scan.foreign.length > 0) return { status: "kept", files: scan.foreign };
  try {
    renameSync(legacy, target);
  } catch {
    return { status: "incomplete" };
  }
  return { status: "renamed", from: legacy, to: target };
}

/** The bytes of a file, or `null` when it cannot be read. */
function bytesOf(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

/**
 * The new folder's copy of a page: its bytes, `"absent"` when nothing is
 * there, or `"unusable"` when something is there that is not a regular
 * file (a directory, a link) or cannot be read. An unusable copy proves
 * nothing about the page, so the old one stays.
 */
function copyOf(path: string): Buffer | "absent" | "unusable" {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unusable";
  }
  if (!stat.isFile()) return "unusable";
  return bytesOf(path) ?? "unusable";
}

/**
 * The rename, after the pages are rendered: the old folder is removed
 * when the new one holds every page it held and the old one holds
 * nothing but pages the view wrote. `rendered` names the pages the
 * writer wrote in this pass, so a page the writer removed (a topic that
 * left) does not keep the old folder for ever. `renderedText` says
 * whether bytes are a text the view rendered into a page (its render
 * records), so an older render in the old folder is no edit.
 */
export function finishDefaultFolder(
  target: string,
  rendered: ReadonlySet<string>,
  renderedText: (page: string, bytes: Buffer) => boolean = () => false,
): DefaultFolderOutcome {
  const legacy = legacyDefaultDir(target);
  if (legacy === target) return { status: "no-legacy" };
  if (!existsSync(legacy)) return { status: "no-legacy" };
  const scan = scanViewFolder(legacy);
  if (scan.written.length === 0) return { status: "not-written" };
  if (scan.foreign.length > 0) return { status: "kept", files: scan.foreign };
  // A page is held by the new folder when it is a readable regular file
  // there, or when this pass removed it on purpose. Anything else in its
  // place (a directory, a link, a file that cannot be read) holds nothing.
  const copies = new Map(scan.written.map((rel) => [rel, copyOf(join(target, rel))]));
  const missing = scan.written.filter((rel) => {
    const copy = copies.get(rel);
    return copy === "unusable" || (copy === "absent" && !rendered.has(rel));
  });
  if (missing.length > 0) return { status: "incomplete" };
  // A page the new folder holds with other bytes, and that is no text the
  // view rendered: an edit. The render read the new folder only, so it is
  // in no store, and the old folder stays with it until that content is
  // ingested or kept elsewhere. An older render (the brain changed since
  // the old folder was written) is no edit.
  const divergent = scan.written.filter((rel) => {
    const other = copies.get(rel);
    if (!(other instanceof Buffer)) return false; // removed on purpose by this pass
    const old = bytesOf(join(legacy, rel));
    if (old === null) return true;
    return !old.equals(other) && !renderedText(rel, old);
  });
  if (divergent.length > 0) return { status: "divergent", files: divergent };
  removeScanned(legacy, scan.written);
  if (!existsSync(legacy)) return { status: "removed", dir: legacy };
  // Something was written into the old folder after its scan: it stays,
  // and a later pass says what it holds.
  const left = scanViewFolder(legacy);
  return left.foreign.length > 0
    ? { status: "kept", files: left.foreign }
    : { status: "incomplete" };
}

/**
 * Removes the pages of `dir` its scan classified as written by the view,
 * then its directories, deepest first, each only when it is empty: a file
 * written into the folder after the scan (by the user, a sync tool,
 * another program) is never removed, and its directories stay with it.
 */
function removeScanned(dir: string, written: ReadonlyArray<string>): void {
  for (const rel of written) {
    try {
      rmSync(join(dir, rel), { force: true });
    } catch {
      // a page that cannot be removed keeps its folder
    }
  }
  const prune = (at: string): void => {
    let entries;
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) prune(join(at, entry.name));
    }
    try {
      rmdirSync(at);
    } catch {
      // not empty: something the scan did not classify is in it
    }
  };
  prune(dir);
}

/** The one line the user reads when the old folder keeps a file of their own. */
export function defaultFolderNotice(outcome: DefaultFolderOutcome, target: string): string | null {
  if (outcome.status === "divergent") {
    const files = outcome.files.join(", ");
    return (
      `The old view folder ${legacyDefaultDir(target)} was left alone: it holds ${files}, whose ` +
      `content the new folder does not hold. The pages are now in ${target}.`
    );
  }
  if (outcome.status !== "kept") return null;
  const files = outcome.files.join(", ");
  return (
    `The old view folder ${legacyDefaultDir(target)} was left alone: it holds ${files}, ` +
    `which the view did not write. The pages are now in ${target}.`
  );
}

/** The device-local note that this machine already said the line. */
function noticePath(stateDir: string): string {
  return join(stateDir, VIEW_STATE_DIR, NOTICE_FILE);
}

/**
 * The line to say, and the note that it was said: `null` when the line
 * was already said for this folder, so it is said once.
 */
export function takeDefaultFolderNotice(
  stateDir: string,
  outcome: DefaultFolderOutcome,
  target: string,
): string | null {
  const text = defaultFolderNotice(outcome, target);
  if (text === null) return null;
  const path = noticePath(stateDir);
  try {
    const seen = JSON.parse(readFileSync(path, "utf8")) as { legacy?: unknown };
    if (seen.legacy === legacyDefaultDir(target)) return null;
  } catch {
    // not said yet
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ legacy: legacyDefaultDir(target) })}\n`);
  } catch {
    // the line is said again next time
  }
  return text;
}
