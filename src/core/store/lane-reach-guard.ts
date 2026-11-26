/**
 * The lane write rule below local reach: private-partition lane entries
 * are withheld below local reach, and a write such a caller makes never
 * touches one.
 *
 * Below local reach (`privateWithheld()`) every lane read sees the
 * caller's fold, which holds `shared` only (`lane-fold-cache.ts`), so an
 * update, a transition or a removal of a private entry finds nothing and
 * answers as for an absent one. What remains is a write that lands on a
 * key the caller cannot see: a create-style write onto a key the
 * `private` partition holds, a removal or move that would tombstone a
 * stale `shared` value over a `private` entry, and any lane write while
 * the fold of every partition may miss a record. Each is refused here
 * with one fixed answer, before any record is written, reading the fold
 * of every partition once. Outside that scope (the command line, hooks,
 * a local transport, work run inside `withPrivateShown`) nothing here
 * applies.
 *
 * The write primitives of `lane-pages.ts` call it, and so do the writers
 * that build their records around those primitives (the lifecycle store
 * writer, the decision record, the entity registry).
 */

import { join } from "node:path";

import type { FrontmatterMap } from "../types.ts";
import { privateWithheld, withPrivateShown } from "./caller-reach.ts";
import type { DualWriteRecord } from "./dual-write.ts";
import { foldedAt, laneRemovalRecords } from "./lane-dual-moves.ts";
import {
  brainRelOf,
  heldInStore,
  isPrivateEntry,
  laneEntryInPrivate,
  lanePagesInStore,
  storedEntryPrivate,
} from "./lane-entry-store.ts";
import { laneFoldIncomplete, wholeLaneStoreFold, type LaneFolded } from "./lane-fold-cache.ts";
import { lanePlaceOf } from "./lane-paths.ts";
import { laneEntryKey } from "./lane-records.ts";

/** The fixed answer of a lane write refused below local reach. */
export const LANE_ENTRY_WITHHELD_MESSAGE = "this entry cannot be written at this reach";

/**
 * A lane write refused below local reach. It carries no path and no key:
 * the same answer for every refusal, so it says nothing of the entry.
 */
export class LaneEntryWithheldError extends Error {
  constructor() {
    super(LANE_ENTRY_WITHHELD_MESSAGE);
    this.name = "LaneEntryWithheldError";
  }
}

/** The fold key of the store-held lane entry at `path`, or null when `path` names none. */
function storeKeyOf(vault: string, path: string, configPath?: string): string | null {
  if (!heldInStore(vault, path, configPath)) return null;
  const place = lanePlaceOf(brainRelOf(vault, path));
  return place === null ? null : laneEntryKey(place.lane, place.entry);
}

/** Whether the key is live in the `private` partition of `fold`. */
function liveInPrivate(fold: LaneFolded, key: string): boolean {
  return fold.entries.has(key) && fold.privateKeys.has(key);
}

/**
 * Below local reach, refuse a write of the lane entries at `paths` when
 * the fold of every partition may miss a record or any of them is live in
 * `private`. Paths that name no store-held lane entry are not judged, and
 * with none left nothing is read. Call it before the first record.
 */
export function assertLaneWriteAtReach(
  vault: string,
  paths: ReadonlyArray<string>,
  configPath?: string,
): void {
  if (!privateWithheld()) return;
  const keys = paths.flatMap((path) => storeKeyOf(vault, path, configPath) ?? []);
  if (keys.length === 0) return;
  const fold = wholeLaneStoreFold(configPath);
  if (laneFoldIncomplete(fold) || keys.some((key) => liveInPrivate(fold, key))) {
    throw new LaneEntryWithheldError();
  }
}

/**
 * Below local reach, refuse a lane removal (or a move, which removes its
 * source) while the fold of every partition may miss a record: a stale
 * `shared` value the caller's fold still shows could then be tombstoned
 * over a `private` entry the fold cannot see.
 */
export function assertLaneRemovalAtReach(vault: string, configPath?: string): void {
  if (!privateWithheld() || !lanePagesInStore(vault, configPath)) return;
  if (laneFoldIncomplete(wholeLaneStoreFold(configPath))) throw new LaneEntryWithheldError();
}

/**
 * Below local reach, whether the lane entry at `path` is live in
 * `private` in the fold of every partition (false outside that scope and
 * for a path that names no store-held lane entry). A removal or a move
 * leaves such an entry out, as one that is not there.
 */
export function withheldPrivateKey(vault: string, path: string, configPath?: string): boolean {
  if (!privateWithheld()) return false;
  const key = storeKeyOf(vault, path, configPath);
  return key !== null && liveInPrivate(wholeLaneStoreFold(configPath), key);
}

/**
 * Below local reach, refuse a write of the lane page at `path` whose
 * record would land in `private`: the entry there lives in `private` or
 * reserves it, or the judge every lane write applies (`isPrivateEntry`)
 * finds the page private. For a writer that reads its write back through
 * the caller's fold, which cannot show a `private` entry: refused before
 * the first record, nothing lands.
 */
export function assertEntryShareableAtReach(
  vault: string,
  path: string,
  fields: FrontmatterMap,
  body: string,
  configPath?: string,
): void {
  if (!privateWithheld() || !heldInStore(vault, path, configPath)) return;
  if (
    storedEntryPrivate(vault, path, configPath) ||
    isPrivateEntry(vault, fields, body, undefined, configPath)
  ) {
    throw new LaneEntryWithheldError();
  }
}

/**
 * The paths of `paths` a lane write may act on, judged by `fold` (the
 * fold of every partition the write builds its records from): below local
 * reach a fold that may miss a record refuses the write, and a path whose
 * entry is live in `private` in `fold` is left out, as one that is not
 * there. Outside that scope every path is kept.
 */
export function pathsAtReach(
  vault: string,
  fold: LaneFolded,
  paths: ReadonlyArray<string>,
  configPath?: string,
): ReadonlyArray<string> {
  if (!privateWithheld()) return paths;
  if (laneFoldIncomplete(fold)) throw new LaneEntryWithheldError();
  return paths.filter((path) => {
    const key = storeKeyOf(vault, path, configPath);
    return key === null || !liveInPrivate(fold, key);
  });
}

/**
 * The tombstones of removing the lane entries at `paths`, built inside the
 * store write: the reach check, the winning value of each entry and the
 * partition each tombstone goes to are read from ONE fold of every
 * partition, read when the write builds its records. A winner that changed
 * after the caller's own read (an entry raised to `private` meanwhile) is
 * judged again here, so below local reach no tombstone is ever built over
 * a `private` entry, and none lands in `private`. Empty when nothing is
 * left to remove.
 */
export function removalRecordsAtReach(
  vault: string,
  paths: ReadonlyArray<string>,
  configPath?: string,
): DualWriteRecord[] {
  const fold = wholeLaneStoreFold(configPath);
  return laneRemovalRecords(vault, fold, pathsAtReach(vault, fold, paths, configPath));
}

/**
 * Below local reach, refuse a write of the lane entries at `paths` judged
 * by `fold` (the fold of every partition the write builds its records
 * from): a fold that may miss a record, or an entry live in `private`
 * there. For a write that already passed {@link assertLaneWriteAtReach}
 * on an earlier read and must judge again at build time.
 */
export function assertWritableInFold(
  vault: string,
  fold: LaneFolded,
  paths: ReadonlyArray<string>,
  configPath?: string,
): void {
  if (!privateWithheld()) return;
  if (laneFoldIncomplete(fold)) throw new LaneEntryWithheldError();
  for (const path of paths) {
    const key = storeKeyOf(vault, path, configPath);
    if (key !== null && liveInPrivate(fold, key)) throw new LaneEntryWithheldError();
  }
}

/**
 * The source entry of a single-page move from `from` to `to`, judged inside
 * the store write from `fold` (the fold the write builds its records
 * from): the destination is judged again ({@link assertWritableInFold}),
 * and a source live in `private` there (raised since the caller's read) is
 * `null`, left alone. The tombstone's partition is the one `fold` names.
 */
export function moveSourceAtReach(
  vault: string,
  fold: LaneFolded,
  from: string,
  to: string,
  configPath?: string,
): ReturnType<typeof foldedAt> {
  assertWritableInFold(vault, fold, [to], configPath);
  if (pathsAtReach(vault, fold, [from], configPath).length === 0) return null;
  return foldedAt(fold, vault, from);
}

/**
 * Below local reach, whether a device-local journal (a recovery marker)
 * that names the lane entries at `paths` must be left for a local caller:
 * the fold of every partition may miss a record, or one of the entries
 * is held in `private` there (live, or removed by a record held in
 * `private`). Such a caller's own fold cannot tell a private entry from
 * an absent one, so it never reads, clears or answers from that journal.
 * False outside that scope and when the lane pages are files.
 */
export function journalWithheldAtReach(
  vault: string,
  paths: ReadonlyArray<string>,
  configPath?: string,
): boolean {
  if (!privateWithheld() || !lanePagesInStore(vault, configPath)) return false;
  const fold = wholeLaneStoreFold(configPath);
  if (laneFoldIncomplete(fold)) return true;
  return paths.some((path) => {
    const key = storeKeyOf(vault, path, configPath);
    return key !== null && (fold.privateKeys.has(key) || fold.privateRemovals.has(key));
  });
}

/**
 * Whether the winning record of the lane entry `lane`/`entry` in the fold
 * of every partition is held in `private` (a live entry, or a removal):
 * the holder a refusal must not name below local reach. An earlier record
 * of the key in `private` that no longer wins does not count, so two keys
 * with the same winner get the same answer.
 */
export function winnerHeldInPrivate(lane: string, entry: string, configPath?: string): boolean {
  const fold = wholeLaneStoreFold(configPath);
  const key = laneEntryKey(lane, entry);
  return fold.privateKeys.has(key) || fold.privateRemovals.has(key);
}

/**
 * Below local reach, refuse a write that a record held in `private`
 * outranks (a human removal of the entry, for one) with the fixed answer,
 * instead of an explanation that names the holder: `privateHolder` is
 * whether such a record holds the entry.
 */
export function assertHolderReadableAtReach(privateHolder: boolean): void {
  if (privateHolder && privateWithheld()) throw new LaneEntryWithheldError();
}

/** A reach predicate over vault-relative POSIX paths, as the lane readers take it. */
type ReadableRel = (rel: string) => boolean;

/**
 * The identity decision of a create the caller addresses (a deduplication,
 * a title or identity reservation, the entry a create would update in
 * place), taken on the fold of every partition (the write rule). `matches`
 * answers the lane entries (absolute paths) a local caller with the same
 * store would be answered with or would update, given `readable` widened to
 * every entry held in `private`. Below local reach a match held in
 * `private` (or any match while that fold may miss a record) refuses the
 * call with the fixed answer before any durable step, and the answer names
 * nothing of it; a match held in `shared` leaves the caller's own decision
 * to run as at local reach. Outside that scope nothing is read.
 */
export function assertCreateMatchAtReach(
  vault: string,
  matches: (readable: ReadableRel | undefined) => ReadonlyArray<string>,
  readable?: ReadableRel,
  configPath?: string,
): void {
  if (!privateWithheld()) return;
  const wide: ReadableRel | undefined =
    readable === undefined
      ? undefined
      : (rel) => laneEntryInPrivate(vault, join(vault, rel), configPath) || readable(rel);
  let found: ReadonlyArray<string>;
  try {
    found = withPrivateShown(() => matches(wide));
  } catch (err) {
    // An error raised while `private` was shown was composed from a view
    // the caller may not read (an unreadable entry it met, a slot it
    // found held): it never reaches the caller while an entry it could
    // have read is held in `private`, and the store's lanes are where
    // `matches` reads.
    if (err instanceof LaneEntryWithheldError || privateLaneEntryMayExist(vault, configPath)) {
      throw new LaneEntryWithheldError();
    }
    throw err;
  }
  if (found.some((path) => laneEntryInPrivate(vault, path, configPath))) {
    throw new LaneEntryWithheldError();
  }
}

/**
 * Whether a lane may hold an entry in `private`: a store whose fold of
 * every partition holds a live one or may miss a record, or a machine
 * whose lane pages are files, where privacy is a page's own marker and
 * cannot be ruled out without the read that failed.
 */
function privateLaneEntryMayExist(vault: string, configPath?: string): boolean {
  if (!lanePagesInStore(vault, configPath)) return true;
  const fold = wholeLaneStoreFold(configPath);
  return (
    privateRecordMayBeMissed(fold) || [...fold.privateKeys].some((key) => fold.entries.has(key))
  );
}

/**
 * Whether the fold of every partition may miss a record held in `private`:
 * an unread shard of that partition, a store it could not open (its reason
 * names no partition), or a pending blob of that partition. An unread
 * `shared` shard hides no `private` record.
 */
function privateRecordMayBeMissed(fold: LaneFolded): boolean {
  return (
    fold.unreadable.some((entry) => !entry.startsWith("shared/")) ||
    fold.pendingBlobs.some((blob) => blob.startsWith("private/"))
  );
}

/**
 * Whether the lane entry at `path` is taken for a ladder that picks a free
 * key (an id, an archive slot, a dated stem): read on the fold of every
 * partition, whatever the caller's reach, so the ladder lands on the key a
 * local caller with the same store would get and never on one a `private`
 * entry holds. `taken` is the ladder's own existence check.
 */
export function takenOnWholeFold(taken: () => boolean): boolean {
  return withPrivateShown(taken);
}

/**
 * The members of a folder a move or a removal acts on, listed by `list` on
 * the fold of every partition whatever the caller's reach (the write rule):
 * below local reach a member held in `private` refuses the whole call with
 * the fixed answer before the first move or removal, so a folder is never
 * split between what the caller may see and what it may not.
 */
export function treeMembersAtReach(
  vault: string,
  list: () => ReadonlyArray<string>,
  configPath?: string,
): ReadonlyArray<string> {
  const paths = withPrivateShown(list);
  // A fold that may miss a `private` record cannot show that no member is
  // private; an unread `shared` shard is the operation's own report.
  if (
    privateWithheld() &&
    lanePagesInStore(vault, configPath) &&
    privateRecordMayBeMissed(wholeLaneStoreFold(configPath))
  ) {
    throw new LaneEntryWithheldError();
  }
  if (paths.some((path) => withheldPrivateKey(vault, path, configPath))) {
    throw new LaneEntryWithheldError();
  }
  return paths;
}

/**
 * The coarse rule, bulk form: below local reach, refuse a verb that
 * removes, moves, merges or rewrites lane entries the caller did not
 * address one by one (a hygiene apply, a derived-page refresh) while any
 * lane holds a live entry in `private`, or the fold of every partition may
 * miss a record. Call it before the first durable step. On a store with no
 * `private` entry, and outside that scope, the verb runs as before. The
 * refusal says nothing of which entry or lane holds one.
 */
export function assertNoPrivateLaneEntryAtReach(vault: string, configPath?: string): void {
  if (!privateWithheld() || !lanePagesInStore(vault, configPath)) return;
  const fold = wholeLaneStoreFold(configPath);
  if (laneFoldIncomplete(fold) || [...fold.privateKeys].some((key) => fold.entries.has(key))) {
    throw new LaneEntryWithheldError();
  }
}
