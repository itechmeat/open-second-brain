/**
 * Read-only enumeration of the legacy items one mapping covers (task 2.2):
 * the files a {@link Locator} names, the items in them, the device id each
 * per-device shard carries in its name, and every item that cannot be
 * read as its surface writes it.
 *
 * Nothing here writes, creates or locks anything: files are listed with
 * `readdirSync`, sized with `lstatSync` and read with `readFileSync`. A
 * link or special file is never followed or read; it is reported as an
 * unparseable item instead, so a planted link cannot steer the scan out
 * of the vault.
 */

import { lstatSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";

import { isStoreFamilyEntry } from "../search/store-family.ts";
import { checksum, fileStamp, stampInode, type IncrementalReads } from "./incremental-reads.ts";

import { isSyncConflictName, parseShardedName } from "../brain/ledger-shards.ts";
import { DEGRADATION_CODE } from "../integrity/degradation.ts";
import { parseFrontmatterTextWithNotices, parseFrontmatterWithNotices } from "../vault.ts";
import {
  entryOfPath,
  laneNameRefusal,
  laneFolderRivals,
  lanePlaceOf,
  normalizedFolderPlace,
  ROOT_LANE,
} from "../store/lane-paths.ts";
import type { LegacyItem, Locator } from "./destinations.ts";
import { claims } from "./legacy-claims.ts";

/** One item the scan could not read as its surface writes it. */
export interface ScanProblem {
  readonly path: string;
  /** 1-based line of a JSONL item, or null for a whole file. */
  readonly line: number | null;
  readonly reason: string;
}

/** What one device's shards hold in the scanned locators. */
export interface DeviceTally {
  files: number;
  items: number;
  /** Newest modification time of its shards, in ms. */
  lastSeenMs: number;
}

/** Totals of one scan, accumulated across the locators of a mapping. */
export interface ScanTally {
  files: number;
  bytes: number;
  items: number;
  /** Files of the legacy un-sharded name (no device id). */
  unshardedFiles: number;
  readonly devices: Map<string, DeviceTally>;
  readonly problems: ScanProblem[];
  /**
   * What earlier passes read of each JSONL file (`incremental-reads.ts`):
   * an unchanged file is skipped, an appended one read from where the
   * last read ended. Absent: every file is read whole.
   */
  incremental?: IncrementalReads;
  /**
   * Called for every item the scan reaches, before it is parsed or handed
   * to the visitor: the one place a pass counts the rows it visits.
   */
  onVisit?: (path: string, line: number | null) => void;
}

export function emptyTally(): ScanTally {
  return { files: 0, bytes: 0, items: 0, unshardedFiles: 0, devices: new Map(), problems: [] };
}

/**
 * A failure of the visitor that must stop the whole scan (a failed store
 * append, an interrupted run) rather than mark one item unparseable.
 */
export class ScanAbort extends Error {
  override readonly name = "ScanAbort";
  constructor(override readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

/** Called for every readable item; a throw marks the item unparseable, a {@link ScanAbort} stops the scan. */
export type ItemVisitor = (item: LegacyItem) => void;

const JSON_EXT = ".json";
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });
const PAGE_EXT = ".md";

/** The entries of a directory, or none when it does not exist. */
function entries(dir: string, tally: ScanTally): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).toSorted((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      tally.problems.push({ path: dir, line: null, reason: `cannot list: ${String(code)}` });
    }
    return [];
  }
}

/** Size a regular file; a link or special file is reported and skipped. */
function regularFile(
  path: string,
  tally: ScanTally,
): { size: number; mtimeMs: number; stamp: string } | null {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      tally.problems.push({ path, line: null, reason: `cannot stat: ${String(code)}` });
    }
    return null;
  }
  if (!stat.isFile()) {
    if (!stat.isDirectory()) {
      tally.problems.push({ path, line: null, reason: "a link or special file, not read" });
    }
    return null;
  }
  tally.files += 1;
  tally.bytes += stat.size;
  return { size: stat.size, mtimeMs: stat.mtimeMs, stamp: fileStamp(stat) };
}

function visit(tally: ScanTally, path: string, line: number | null, fn: () => void): boolean {
  // Every item the scan reaches, whatever becomes of it.
  tally.onVisit?.(path, line);
  try {
    fn();
    tally.items += 1;
    return true;
  } catch (error) {
    if (error instanceof ScanAbort) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    tally.problems.push({ path, line, reason });
    return false;
  }
}

/**
 * The lines of a file's raw bytes, split on `\n` without decoding, so a
 * line keeps its exact bytes (a torn or non-UTF-8 line included). Line
 * `n` is element `n - 1`, as in `text.split("\n")`.
 */
export function rawLines(bytes: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let start = 0;
  for (let at = bytes.indexOf(0x0a); at !== -1; at = bytes.indexOf(0x0a, start)) {
    out.push(bytes.subarray(start, at));
    start = at + 1;
  }
  out.push(bytes.subarray(start));
  return out;
}

/**
 * The rows of one JSONL file. `itemPath` is the path the items carry (the
 * file itself, or the original a conflict copy is a version of), and
 * `mtimeMs` null leaves the device tallies alone (a copy's time is when
 * the conflict happened, not when its device last wrote).
 */
function scanJsonlFile(
  path: string,
  shardId: string,
  mtimeMs: number | null,
  tally: ScanTally,
  visitor: ItemVisitor,
  itemPath: string = path,
  stamp: string | null = null,
): void {
  // An earlier pass read this file: unchanged, it is not opened at all.
  const incremental = stamp === null ? undefined : tally.incremental;
  const known = incremental?.lookup(path);
  if (incremental !== undefined && known !== undefined && known.stamp === stamp) {
    incremental.record(path, known);
    tallyDevice(tally, shardId, mtimeMs, known.items);
    return;
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    // Gone, turned into a folder or denied since it was sized: reported,
    // and the rest of the scan goes on.
    const code = (error as NodeJS.ErrnoException).code;
    tally.problems.push({ path, line: null, reason: `cannot read: ${String(code)}` });
    return;
  }
  let items = 0;
  const lines = rawLines(bytes);
  // Appended to since the last read, the lines read before unchanged: only
  // the new lines are parsed and judged.
  let start = 0;
  if (
    known !== undefined &&
    stamp !== null &&
    stampInode(known.stamp) === stampInode(stamp) &&
    bytes.length >= known.bytes &&
    checksum(bytes.subarray(0, known.bytes)) === known.sha
  ) {
    start = known.lines;
    items = known.items;
  }
  for (let index = start; index < lines.length; index++) {
    const line = lines[index]!;
    let raw: string | null;
    try {
      raw = STRICT_UTF8.decode(line);
    } catch {
      raw = null;
    }
    if (raw !== null && raw.trim() === "") continue;
    const ok = visit(tally, path, index + 1, () => {
      if (raw === null) throw new Error("not UTF-8 text");
      let row: unknown;
      try {
        row = JSON.parse(raw) as unknown;
      } catch {
        throw new Error(
          index === lines.length - 1 ? "an incomplete last line, not JSON" : "not JSON",
        );
      }
      visitor({ shape: "line", path: itemPath, line: index + 1, row, device: shardId });
    });
    if (ok) items += 1;
  }
  if (incremental !== undefined && stamp !== null) {
    // Complete lines only: a last line without its newline is read again.
    const complete = bytes.lastIndexOf(0x0a) + 1;
    incremental.record(path, {
      stamp,
      bytes: complete,
      lines: lines.length - 1,
      sha: checksum(bytes.subarray(0, complete)),
      items,
    });
  }
  tallyDevice(tally, shardId, mtimeMs, items);
}

function tallyDevice(
  tally: ScanTally,
  shardId: string,
  mtimeMs: number | null,
  items: number,
): void {
  if (mtimeMs === null) return;
  if (shardId === "") {
    tally.unshardedFiles += 1;
    return;
  }
  const device = tally.devices.get(shardId) ?? { files: 0, items: 0, lastSeenMs: 0 };
  device.files += 1;
  device.items += items;
  device.lastSeenMs = Math.max(device.lastSeenMs, mtimeMs);
  tally.devices.set(shardId, device);
}

function scanJsonl(
  locator: Extract<Locator, { shape: "jsonl" }>,
  tally: ScanTally,
  visitor: ItemVisitor,
): void {
  const dirs = locator.subdirs
    ? entries(locator.dir, tally)
        .filter((e) => e.isDirectory())
        .map((e) => join(locator.dir, e.name))
    : [locator.dir];
  for (const dir of dirs) {
    for (const entry of entries(dir, tally)) {
      const parsed = parseShardedName(entry.name, locator.grammar);
      if (parsed === null) continue;
      const path = join(dir, entry.name);
      const stat = regularFile(path, tally);
      if (stat === null) continue;
      scanJsonlFile(path, parsed.shardId, stat.mtimeMs, tally, visitor, path, stat.stamp);
    }
  }
}

function scanPages(dir: string, tally: ScanTally, visitor: ItemVisitor): void {
  for (const entry of entries(dir, tally)) {
    if (!entry.name.endsWith(PAGE_EXT) || isSyncConflictName(entry.name)) continue;
    const path = join(dir, entry.name);
    if (regularFile(path, tally) === null) continue;
    visit(tally, path, null, () => {
      const [frontmatter, body, notices] = parseFrontmatterWithNotices(path);
      if (notices.some((n) => n.code === DEGRADATION_CODE.frontmatterUnreadable)) {
        throw new Error("unreadable page");
      }
      visitor({ shape: "page", path, frontmatter, body });
    });
  }
}

function scanJsonFiles(dir: string, tally: ScanTally, visitor: ItemVisitor): void {
  for (const entry of entries(dir, tally)) {
    if (!entry.name.endsWith(JSON_EXT) || isSyncConflictName(entry.name)) continue;
    const path = join(dir, entry.name);
    if (regularFile(path, tally) === null) continue;
    visit(tally, path, null, () => {
      let value: unknown;
      try {
        value = JSON.parse(readFileSync(path, "utf8")) as unknown;
      } catch {
        throw new Error("not JSON");
      }
      visitor({ shape: "json-file", path, value });
    });
  }
}

function scanText(path: string, tally: ScanTally, visitor: ItemVisitor): void {
  if (regularFile(path, tally) === null) return;
  visit(tally, path, null, () =>
    visitor({ shape: "text", path, text: readFileSync(path, "utf8") }),
  );
}

/**
 * The lane and entry id of a file below an `entries` root, by the one
 * path rule of `store/lane-paths.ts`: the entry id is the page's path
 * inside its lane folder, never a field of the page, so a page and its
 * archived copy are two entries.
 */
function entryPlace(
  locator: Extract<Locator, { shape: "entries" }>,
  path: string,
): { lane: string; entry: string } {
  const rel = relative(locator.root, path).split(sep).join("/");
  if (locator.lane === null && rel !== "") {
    // A name that does not map to an entry and back is listed as an item
    // the migration could not convert, never filed under an id that
    // names another path (`store/lane-paths.ts`).
    const place = lanePlaceOf(rel) ?? spelledFolderPlace(locator.root, rel);
    if (place === null) throw new Error(laneNameRefusal(rel) ?? "not a lane entry");
    return place;
  }
  return { lane: locator.lane ?? ROOT_LANE, entry: entryOfPath(rel === "" ? basename(path) : rel) };
}

/**
 * The place of a page in a user's top folder spelled otherwise than its
 * lane name (`normalizedFolderPlace`), when no other top folder of the
 * tree at `root` takes the same lane; null otherwise. Two folders that
 * map to one lane (`My Notes/` beside `my-notes/` or `my_notes/`) are
 * refused, both but the one already named as the lane: their entries
 * would share ids.
 */
function spelledFolderPlace(root: string, rel: string): { lane: string; entry: string } | null {
  const place = normalizedFolderPlace(rel);
  if (place === null) return null;
  const folder = rel.split("/")[0]!;
  const rivals = laneFolderRivals(topFolders(root), folder, place.lane);
  if (rivals.length > 0) {
    throw new Error(
      `the folder ${folder} maps to the lane ${place.lane}, which ${rivals.join(", ")} also ` +
        "takes; rename one of them so each folder has a lane of its own",
    );
  }
  return place;
}

/** The names of the folders directly under `root`. */
function topFolders(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function entryItem(
  locator: Extract<Locator, { shape: "entries" }>,
  path: string,
  readPath: string = path,
): LegacyItem {
  const place = entryPlace(locator, path);
  if (path.endsWith(PAGE_EXT)) {
    // Read once: the page's text is kept beside its parts, so the record
    // can carry the file byte for byte (`raw`) when its fields and text do
    // not reproduce it (a page with no frontmatter, a quoted value, CRLF).
    let raw: string;
    try {
      raw = readFileSync(readPath, "utf8");
    } catch {
      throw new Error("unreadable page");
    }
    const [frontmatter, body, notices] = parseFrontmatterTextWithNotices(raw, { path: readPath });
    if (notices.some((n) => n.code === DEGRADATION_CODE.frontmatterUnreadable)) {
      throw new Error("unreadable page");
    }
    return { shape: "entry", path, ...place, fields: frontmatter, text: body, raw };
  }
  let text: string;
  try {
    text = STRICT_UTF8.decode(readFileSync(readPath));
  } catch {
    throw new Error("not UTF-8 text");
  }
  if (path.endsWith(JSON_EXT)) {
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      throw new Error("not JSON");
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { shape: "entry", path, ...place, fields: { value }, text: "" };
    }
    return {
      shape: "entry",
      path,
      ...place,
      fields: value as Record<string, unknown>,
      text: "",
      raw: text,
    };
  }
  return { shape: "entry", path, ...place, fields: {}, text };
}

function scanEntries(
  locator: Extract<Locator, { shape: "entries" }>,
  tally: ScanTally,
  visitor: ItemVisitor,
): void {
  const visitFile = (path: string): void => {
    if (!claims(locator, path, basename(path))) return;
    if (regularFile(path, tally) === null) return;
    visit(tally, path, null, () => visitor(entryItem(locator, path)));
  };
  let isDir: boolean;
  try {
    isDir = lstatSync(locator.root).isDirectory();
  } catch {
    return;
  }
  if (!isDir) return visitFile(locator.root);
  const walk = (dir: string): void => {
    for (const entry of entries(dir, tally)) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else visitFile(path);
    }
  };
  walk(locator.root);
}

/** Count a file or a whole directory tree as files and bytes; each file is one item. */
function scanTree(path: string, tally: ScanTally): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return;
  }
  if (stat.isDirectory()) {
    for (const entry of entries(path, tally)) scanTree(join(path, entry.name), tally);
    return;
  }
  if (regularFile(path, tally) !== null) tally.items += 1;
}

function scanTreeMatching(locator: Extract<Locator, { shape: "tree" }>, tally: ScanTally): void {
  for (const entry of entries(locator.path, tally)) {
    if (parseShardedName(entry.name, locator.grammar!) === null) continue;
    const path = join(locator.path, entry.name);
    if (regularFile(path, tally) !== null) tally.items += 1;
  }
}

/**
 * Count a search index store file and the files its store layer keeps
 * beside it (`search/store-family.ts`) as files and bytes: sized with
 * `lstat` only, never read.
 */
function scanStoreFamily(path: string, tally: ScanTally): void {
  const base = basename(path);
  for (const entry of entries(dirname(path), tally)) {
    if (entry.isDirectory() || !isStoreFamilyEntry(entry.name, base, false)) continue;
    if (regularFile(join(dirname(path), entry.name), tally) !== null) tally.items += 1;
  }
}

/** Scan one locator into `tally`, handing every readable item to `visitor`. */
export function scanLocator(locator: Locator, tally: ScanTally, visitor: ItemVisitor): void {
  switch (locator.shape) {
    case "jsonl":
      return scanJsonl(locator, tally, visitor);
    case "pages":
      return scanPages(locator.dir, tally, visitor);
    case "json-files":
      return scanJsonFiles(locator.dir, tally, visitor);
    case "text":
      return scanText(locator.path, tally, visitor);
    case "entries":
      return scanEntries(locator, tally, visitor);
    case "tree":
      if (locator.family === true) return scanStoreFamily(locator.path, tally);
      return locator.grammar === undefined
        ? scanTree(locator.path, tally)
        : scanTreeMatching(locator, tally);
  }
}

/**
 * The rows of a sync tool's conflict copy at `copyPath` of the JSONL file
 * `originalPath` that `locator` reads: each item carries the original's
 * path and shard device, so it builds the record the original's row
 * would. The device tallies are left alone. A copy whose original name
 * does not fit the locator's grammar holds no rows.
 */
export function scanCopyLines(
  locator: Locator,
  copyPath: string,
  originalPath: string,
  tally: ScanTally,
  visitor: ItemVisitor,
): void {
  if (locator.shape !== "jsonl") return;
  const parsed = parseShardedName(basename(originalPath), locator.grammar);
  if (parsed === null) return;
  if (regularFile(copyPath, tally) === null) return;
  scanJsonlFile(copyPath, parsed.shardId, null, tally, visitor, originalPath);
}

/**
 * The one item a file of a one-item-per-file locator holds (a page, a
 * JSON file, a lane entry, a whole text file), read from `readPath` and
 * carrying `path`: the original's own item, or a conflict copy's version
 * of it. Null for a locator whose files are not one item each; throws
 * when the file cannot be read as its surface writes it.
 */
export function readFileItem(locator: Locator, path: string, readPath: string): LegacyItem | null {
  const stat = lstatSync(readPath);
  if (!stat.isFile()) throw new Error("a link or special file, not read");
  switch (locator.shape) {
    case "pages": {
      const [frontmatter, body, notices] = parseFrontmatterWithNotices(readPath);
      if (notices.some((n) => n.code === DEGRADATION_CODE.frontmatterUnreadable)) {
        throw new Error("unreadable page");
      }
      return { shape: "page", path, frontmatter, body };
    }
    case "json-files": {
      let value: unknown;
      try {
        value = JSON.parse(readFileSync(readPath, "utf8")) as unknown;
      } catch {
        throw new Error("not JSON");
      }
      return { shape: "json-file", path, value };
    }
    case "text":
      return { shape: "text", path, text: readFileSync(readPath, "utf8") };
    case "entries":
      return entryItem(locator, path, readPath);
    default:
      return null;
  }
}
