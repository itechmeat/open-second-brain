/**
 * The records of a lane removal or move, and their dual write on an
 * unswitched machine (task 3.12 review, design D19 item 2).
 *
 * With the phase 1 dual write on, a lane page an unswitched machine writes
 * is also a `lane-entry` record in the store (`./lane-pages.ts`, through
 * `routeWrite`). A removal or a move of that page used to touch the file
 * alone, so the record stayed live: once the machine switched, the removed
 * page (a persona, a pledge, a staged page) was back, and a moved page was
 * in both places. A removal now dual-writes the stored entry's tombstone.
 *
 * A move is the write of the destination plus the removal of the source,
 * judged as those two writes would be judged, in both modes and for a page
 * and a folder alike (`tests/core/lanes/lane-move-table.test.ts` checks
 * the rule over every state a move can start from):
 *
 *  - the destination ({@link destinationRecords}): the entry a write of
 *    the content that moved leaves there, or, when nothing the store would
 *    import arrived (a link), the removal of the entry held there;
 *  - the source: its entry's tombstone where that entry lives, last.
 *
 * A move that involves no stored entry (an unswitched rename of a page the
 * store never saw onto a path it holds nothing at) writes nothing: the
 * legacy-only path is unchanged, and the migration imports the page.
 *
 * A move whose source is a lane page (or a folder holding stored entries)
 * and whose destination is no lane entry, outside `Brain/` or not in a
 * lane folder, is refused before anything moves, in both modes
 * ({@link assertLaneDestination}): a store-only machine has no file to
 * leave there, so its tombstones alone would lose the page.
 *
 * Every record of one call is built from one fold of the lane store, so an
 * entry's value and the partition it lives in cannot come from two
 * different reads. The destination write:
 *
 *  - writes nothing when the source and the destination are one entry
 *    (the same path, or one that normalises to it): a rename onto itself
 *    changes nothing, and a tombstone after the entry would remove it;
 *  - builds the new entry from the content that moved: on an unswitched
 *    machine the page as it is on disk after the rename (a legacy-only
 *    edit the store never saw included), on a store-only one the stored
 *    value;
 *  - puts the new entry in `shared` unless the source entry lives in
 *    `private`, the moved page is private by its own content, the entry
 *    or legacy page it replaces is private (it lives in `private` or its
 *    fields reserve it: nothing lowers an entry's partition, as for a write
 *    over it) or the fold may miss a record (an unreadable shard, or a
 *    body blob in `private` that has not arrived: `laneFoldIncomplete`, fail closed as
 *    every lane privacy verdict); each entry is placed by itself, so one private page
 *    of a folder does not raise the others;
 *  - when it replaces a destination entry that lives in `shared` with a
 *    private one, writes that entry's shared tombstone first, so a device
 *    that holds only `shared` does not keep reading the replaced page.
 *
 * A folder move whose folders overlap, the destination inside the source
 * or the source inside the destination, is refused before anything moves,
 * in both modes ({@link assertFoldersApart}): the rename an unswitched
 * machine runs refuses both (a folder cannot move into itself, and the
 * folder that holds the source is never empty), so a store-only machine
 * refuses them too and both modes end in the same state. Within one
 * folder move, therefore, no destination entry is the source entry of
 * another, and no tombstone of the batch can remove an entry the batch
 * wrote. A folder moved onto itself changes nothing.
 *
 * All the records of one call are one store operation (`dualWrite`,
 * `storeWrite`): the partitions are checked before the first append.
 */

import { closeSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

import { BRAIN_ROOT_REL } from "../brain/path-constants.ts";
import { containedRecordPath } from "../record-path.ts";
import type { StorePartition } from "./constants.ts";
import { dualWrite, type DualWriteContext, type DualWriteRecord } from "./dual-write.ts";
import {
  brainRelOf,
  entryRecord,
  insideBrain,
  isPrivateEntry,
  storeEntries,
  tombstoneOf,
} from "./lane-entry-store.ts";
import { laneFoldIncomplete, wholeLaneStoreFold, type LaneFolded } from "./lane-fold-cache.ts";
import { brainRelOfEntry, lanePlaceOf } from "./lane-paths.ts";
import { laneTextParts, rawToKeep } from "./lane-raw.ts";
import { laneEntryKey, type LaneEntryValue } from "./lane-records.ts";
import { isPrivateFrontmatter } from "./private-page.ts";
import { openRegularFileForRead } from "./safe-fs.ts";

/**
 * The absolute paths of every live store entry below `dir`, at any depth,
 * sorted, whatever the machine's mode (the store has no directories; a
 * folder is a path prefix). A path outside `Brain/` is never listed. The
 * caller's fold by default (a read); `whole`: the fold of every
 * partition, for the removal records of an unswitched machine's folder.
 */
export function storedLanePathsBelow(
  vault: string,
  dir: string,
  ext: string,
  whole = false,
): string[] {
  const prefix = brainRelOf(vault, dir);
  const brain = join(vault, BRAIN_ROOT_REL);
  const out: string[] = [];
  const entries = whole ? wholeLaneStoreFold().entries : storeEntries();
  for (const value of entries.values()) {
    const rel = brainRelOfEntry(value.lane, value.entry);
    if (!rel.startsWith(prefix === "" ? "" : `${prefix}/`) || !rel.endsWith(ext)) continue;
    // The fold already refuses an entry id that is no record path; this
    // keeps a path outside `Brain/` out of every reader (and remover) of
    // the list even if that check is ever loosened (FORMAT.md, Trust).
    const path = containedRecordPath(brain, rel);
    if (path !== null) out.push(path);
  }
  return out.toSorted();
}

/** A live entry of one fold, with its key and the partition it lives in. */
interface FoldedEntry {
  readonly key: string;
  readonly value: LaneEntryValue;
  readonly partition: StorePartition;
}

/** The entry key of the lane path `path`, or `null` for a path that is no lane entry. */
function laneKeyAt(vault: string, path: string): string | null {
  if (!insideBrain(vault, path)) return null;
  const place = lanePlaceOf(brainRelOf(vault, path));
  return place === null ? null : laneEntryKey(place.lane, place.entry);
}

/** The live entry of `fold` at the lane path `path`, or `null`. */
export function foldedAt(fold: LaneFolded, vault: string, path: string): FoldedEntry | null {
  const key = laneKeyAt(vault, path);
  if (key === null) return null;
  const value = fold.entries.get(key);
  if (value === undefined) return null;
  return { key, value, partition: fold.privateKeys.has(key) ? "private" : "shared" };
}

/** One move of a lane page: `destinationPrivate` when the legacy page it renamed over was private. */
export interface LaneMove {
  readonly from: string;
  readonly to: string;
  readonly destinationPrivate?: boolean;
}

/** Whether `a` and `b` name one lane entry (the same path, or one that normalises to it). */
export function sameLaneEntry(vault: string, a: string, b: string): boolean {
  const key = laneKeyAt(vault, a);
  return key !== null && key === laneKeyAt(vault, b);
}

/**
 * Refuse, before anything moves, a move whose source is a lane entry and
 * whose destination is none (see the module docblock). For a folder,
 * `moves` are the entries it carries (or a page path below it standing for
 * them); a folder moved out of `Brain/` is refused whatever it holds.
 */
export function assertLaneDestination(
  vault: string,
  from: string,
  to: string,
  moves: ReadonlyArray<LaneMove> = [{ from, to }],
): void {
  const leaves =
    (insideBrain(vault, from) && !insideBrain(vault, to)) ||
    moves.some(
      (move) => laneKeyAt(vault, move.from) !== null && laneKeyAt(vault, move.to) === null,
    );
  if (leaves)
    throw new Error(`cannot move a lane page or folder out of the Brain lanes: ${from} -> ${to}`);
}

/** Whether `inner` lies strictly below the folder `outer`. */
function strictlyBelow(outer: string, inner: string): boolean {
  const rel = relative(outer, inner);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Refuse a folder move whose folders overlap, one inside the other (see the module docblock). */
export function assertFoldersApart(from: string, to: string): void {
  if (strictlyBelow(from, to)) {
    throw new Error(`cannot move a lane folder into itself: ${from} -> ${to}`);
  }
  if (strictlyBelow(to, from)) {
    throw new Error(`cannot move a lane folder into a folder that holds it: ${from} -> ${to}`);
  }
}

/** Whether a write over `entry` keeps it private: it lives in `private`, or its fields reserve it. */
function keepsPrivate(entry: FoldedEntry | null): boolean {
  return (
    entry !== null && (entry.partition === "private" || isPrivateFrontmatter(entry.value.fields))
  );
}

/** What a move carries to its destination. */
export interface MovedContent {
  readonly fields: Readonly<Record<string, unknown>>;
  readonly text: string;
  readonly raw?: string;
  /** Judge the content's own privacy (a page read from disk), not only where it lived. */
  readonly judged: boolean;
}

/** The content a store-only move carries: the stored value as it is. */
export function storedContent(value: LaneEntryValue): MovedContent {
  return {
    fields: value.fields,
    text: value.text,
    ...(value.raw !== undefined ? { raw: value.raw } : {}),
    judged: false,
  };
}

/**
 * The content an unswitched move carried: the page at `to` as it is on
 * disk after the rename, or `null` when there is none there (the page was
 * removed without the store seeing it) or what is there is no page the
 * store would import. As the migration's legacy scan, a symbolic link or
 * special file is never followed or read, nor is a file reached through a
 * linked folder below `Brain/` (`openRegularFileForRead`), so a link moved
 * as a lane page cannot carry a file from outside the vault into the store.
 */
function movedFile(vault: string, to: string): MovedContent | null {
  let fd: number | null;
  try {
    fd = openRegularFileForRead(to, join(vault, BRAIN_ROOT_REL));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (fd === null) return null;
  let text: string;
  try {
    text = readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
  const { fields, body } = laneTextParts(to, text);
  const raw = rawToKeep(to, text, fields, body);
  return { fields, text: body, ...(raw !== undefined ? { raw } : {}), judged: true };
}

/**
 * The records of the write of what is now at `move.to` over the entry
 * `fold` holds there: the write of the moved page, judged as a write over
 * that entry is (see the module docblock), with `sourcePrivate` carrying
 * the moved entry's own partition; or, when nothing the store would import
 * is there, the held entry's tombstone, as a removal of it.
 */
function destinationRecords(
  vault: string,
  fold: LaneFolded,
  move: LaneMove,
  moved: MovedContent | null,
  sourcePrivate: boolean,
): DualWriteRecord[] {
  const replaced = foldedAt(fold, vault, move.to);
  if (moved === null) {
    return replaced === null ? [] : [tombstoneOf(replaced.value, false, replaced.partition)];
  }
  const isPrivate =
    sourcePrivate ||
    laneFoldIncomplete(fold) ||
    move.destinationPrivate === true ||
    keepsPrivate(replaced) ||
    (moved.judged && isPrivateEntry(vault, moved.fields, moved.text, moved.raw));
  const partition: StorePartition = isPrivate ? "private" : "shared";
  return [
    ...(isPrivate && replaced?.partition === "shared"
      ? [tombstoneOf(replaced.value, false, "shared")]
      : []),
    {
      ...entryRecord(vault, move.to, moved.fields, moved.text, isPrivate, "located", moved.raw),
      located: { partition, content: true },
    },
  ];
}

/**
 * The records of moving the entry at `from` to `to`, read from `fold`
 * (see the module docblock): the write of the destination
 * ({@link destinationRecords}) and the removal of the source. `content`
 * gives what moved (`null`: nothing importable). A destination that is no
 * lane entry writes the removal alone (callers refuse one first,
 * {@link assertLaneDestination}).
 */
export function laneMoveRecords(
  vault: string,
  fold: LaneFolded,
  move: LaneMove,
  content: (value: LaneEntryValue) => MovedContent | null,
): DualWriteRecord[] {
  const source = foldedAt(fold, vault, move.from);
  if (source === null) return [];
  const target = laneKeyAt(vault, move.to);
  if (target === source.key) return [];
  const gone = tombstoneOf(source.value, false, source.partition);
  if (target === null) return [gone];
  const sourcePrivate = source.partition === "private";
  return [...destinationRecords(vault, fold, move, content(source.value), sourcePrivate), gone];
}

/**
 * The dual-written records of one unswitched rename: a stored source moves
 * ({@link laneMoveRecords}, the content from disk); a page the store never
 * saw is the write of the destination alone, and nothing at all when the
 * store holds no entry there either (the legacy-only path is unchanged).
 */
function dualMoveRecords(vault: string, fold: LaneFolded, move: LaneMove): DualWriteRecord[] {
  if (foldedAt(fold, vault, move.from) !== null) {
    return laneMoveRecords(vault, fold, move, () => movedFile(vault, move.to));
  }
  if (foldedAt(fold, vault, move.to) === null) return [];
  return destinationRecords(vault, fold, move, movedFile(vault, move.to), false);
}

/** The tombstones of the live entries of `fold` at `paths`, each where its entry lives. */
export function laneRemovalRecords(
  vault: string,
  fold: LaneFolded,
  paths: ReadonlyArray<string>,
): DualWriteRecord[] {
  return paths.flatMap((path) => {
    const entry = foldedAt(fold, vault, path);
    return entry === null ? [] : [tombstoneOf(entry.value, false, entry.partition)];
  });
}

/** Dual-write the tombstones of the stored entries at `paths` (an unswitched removal). */
export function dualWriteLaneRemoval(
  vault: string,
  paths: () => ReadonlyArray<string>,
  context: DualWriteContext,
): void {
  dualWrite(() => laneRemovalRecords(vault, wholeLaneStoreFold(), paths()), context);
}

/** Dual-write an unswitched rename of one lane page. */
export function dualWriteLaneMove(vault: string, move: LaneMove, context: DualWriteContext): void {
  dualWrite(() => dualMoveRecords(vault, wholeLaneStoreFold(), move), context);
}

/**
 * The paths below `dir`, relative to it with `/` separators, of the live
 * entries of `fold`. Judged from the entry ids alone, never from the disk:
 * a link where an entry's file was must not hide the entry.
 */
function foldedBelow(fold: LaneFolded, vault: string, dir: string): string[] {
  const rel = brainRelOf(vault, dir);
  const prefix = rel === "" ? "" : `${rel}/`;
  const out: string[] = [];
  for (const value of fold.entries.values()) {
    const path = brainRelOfEntry(value.lane, value.entry);
    if (path.startsWith(prefix)) out.push(path.slice(prefix.length));
  }
  return out;
}

/**
 * Dual-write an unswitched rename of the folder `from` to `to`: each stored
 * entry below `from` moved, and each stored entry below `to` overwritten
 * by what the rename put there, one move per path below either folder.
 */
export function dualWriteLaneTreeMove(
  vault: string,
  from: string,
  to: string,
  context: DualWriteContext,
): void {
  dualWrite(() => {
    const fold = wholeLaneStoreFold();
    const below = new Set([...foldedBelow(fold, vault, from), ...foldedBelow(fold, vault, to)]);
    return [...below]
      .toSorted()
      .flatMap((rel) => dualMoveRecords(vault, fold, { from: join(from, rel), to: join(to, rel) }));
  }, context);
}
