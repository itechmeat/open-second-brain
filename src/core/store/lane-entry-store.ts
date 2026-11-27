/**
 * The store side of the lane page store: the path helpers the store side
 * needs (`lanePagesInStore`, `heldInStore`, `insideBrain`, `brainRelOf`,
 * `placeOf`, `isLaneEntryPath`), the fold accessors (the one-read
 * snapshot of a read-modify-write, `readLaneEntrySnapshot`, and the
 * authority of the record holding a key, `holderAuthority`) and the record
 * builders of the lane entry store, and the keep rule that holds a
 * replaced private entry private. Every write call stays in
 * `lane-pages.ts`; this module only reads the file system and builds the
 * records of a write (design D14 of brain-store-and-topics).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

import { BRAIN_ROOT_REL } from "../brain/path-constants.ts";
import { canonicalJson } from "../integrity/digest.ts";
import type { FrontmatterMap } from "../types.ts";
import {
  laneFoldIncomplete,
  laneStoreFold,
  wholeLaneStoreFold,
  type LaneFolded,
} from "./lane-fold-cache.ts";
import { laneNameRefusal, lanePlaceOf } from "./lane-paths.ts";
import {
  laneEntryKey,
  laneEntryRecord,
  laneEntryRemoveRecord,
  STANDING_RULE_LANE,
  type LaneEntryValue,
} from "./lane-records.ts";
import {
  lanePrivacyRow,
  laneTextParts,
  rawParsesBack,
  rawToKeep,
  renderLaneText,
} from "./lane-raw.ts";
import { opaqueFields } from "./operation-privacy.ts";
import { isPrivateFrontmatter } from "./private-page.ts";
import { rowNamesPrivatePage } from "./reference-privacy.ts";
import { storeOnlyMode } from "./store-only.ts";
import type { Authority, StorePartition } from "./constants.ts";
import { authorityFromOrigin, type DualWriteRecord } from "./dual-write.ts";
import { strongerAuthority } from "./lane-authority.ts";

/** Whether lane pages of `vault` live in the store on this machine. */
export function lanePagesInStore(vault: string, configPath?: string): boolean {
  return storeOnlyMode({ vault, ...(configPath !== undefined ? { configPath } : {}) }).storeOnly;
}

/** Fields of a lane page that are stamps and ids, never page references. */
const PAGE_OPAQUE_FIELDS = opaqueFields("slug", "date", "valid_from", "content_hash", "revision");

/**
 * Does the store hold `path` on this machine: a store-only machine and a
 * path under `<vault>/Brain/`. Any other path (a user's `skills/` or
 * `runbooks/` page a lane module also reads) stays a file in both modes.
 */
export function heldInStore(vault: string, path: string, configPath?: string): boolean {
  return lanePagesInStore(vault, configPath) && insideBrain(vault, path);
}

/** Whether `path` lies under `<vault>/Brain/` (or is it). */
export function insideBrain(vault: string, path: string): boolean {
  const rel = relative(join(vault, BRAIN_ROOT_REL), path);
  // A parent step is the component `..`, not any name that starts with it
  // (`Brain/..rules.md` is a page inside `Brain/`).
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function brainRelOf(vault: string, path: string): string {
  return relative(join(vault, BRAIN_ROOT_REL), path).split(sep).join("/");
}

function placeOf(vault: string, path: string): { lane: string; entry: string } {
  const rel = brainRelOf(vault, path);
  const place = lanePlaceOf(rel);
  if (place === null) {
    throw new Error(`not a Brain lane page: ${path}: ${laneNameRefusal(rel) ?? "no lane entry"}`);
  }
  return place;
}

function isLaneEntryPath(vault: string, path: string): boolean {
  return insideBrain(vault, path) && lanePlaceOf(brainRelOf(vault, path)) !== null;
}

// ----- The store side -----------------------------------------------------------
//
// The readers below (`storeEntries`, `storeEntry`, `laneEntryClockMs`) read
// the caller's fold (`laneStoreFold`): below local reach it holds `shared`
// only. The privacy verdicts, the placement of a write and a writer's
// version check read the fold of every partition (`wholeLaneStoreFold`).

/** The live lane entries of the caller's fold, by `<lane>/<entry>`. */
export function storeEntries(configPath?: string): ReadonlyMap<string, LaneEntryValue> {
  return laneStoreFold(configPath).entries;
}

/**
 * The physical time (ms) of the newest record of the live lane entry at
 * `path`, the store's stand-in for a file's mtime; `null` when there is no
 * such entry. A file's mtime on a path the store does not hold.
 */
export function laneEntryClockMs(vault: string, path: string, configPath?: string): number | null {
  if (!heldInStore(vault, path, configPath)) {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return null;
    }
  }
  const { lane, entry } = placeOf(vault, path);
  return laneStoreFold(configPath).clocks.get(laneEntryKey(lane, entry)) ?? null;
}

export function storeEntry(
  vault: string,
  path: string,
  configPath?: string,
): LaneEntryValue | null {
  const { lane, entry } = placeOf(vault, path);
  return storeEntries(configPath).get(laneEntryKey(lane, entry)) ?? null;
}

/** The live entry at the lane path `path` in the fold of every partition. */
function wholeStoreEntry(vault: string, path: string, configPath?: string): LaneEntryValue | null {
  const { lane, entry } = placeOf(vault, path);
  return wholeLaneStoreFold(configPath).entries.get(laneEntryKey(lane, entry)) ?? null;
}

/**
 * The live entry at `path` and whether the fold it came from is whole (no
 * `events` shard unreadable or gone, no record whose body is a pending
 * blob), from ONE read of the lane fold of every partition: a
 * read-modify-write judges the entry and the completeness of its read
 * together, against what the store holds, not what one caller may see.
 * `authority` is that of the record holding the key, a live entry or a
 * removal (`removed`), and `null` only when no record holds it.
 */
export function storeEntryRead(
  vault: string,
  path: string,
  configPath?: string,
): {
  readonly value: LaneEntryValue | null;
  readonly whole: boolean;
  readonly authority: Authority | null;
  /** Whether a removal holds the key (no live entry, a tombstone wins). */
  readonly removed: boolean;
} {
  const fold = wholeLaneStoreFold(configPath);
  const { lane, entry } = placeOf(vault, path);
  const key = laneEntryKey(lane, entry);
  const value = fold.entries.get(key) ?? null;
  const authority = fold.authorities.get(key) ?? null;
  return {
    value,
    whole: fold.unreadable.length === 0 && fold.pendingBlobs.length === 0,
    authority,
    removed: value === null && authority !== null,
  };
}

/**
 * The authority of the record that holds the lane path `path` in `fold`,
 * a live entry or a removal; `null` when no record holds it or the path
 * names no lane entry (the kept standing, `lane-standing.ts`).
 */
export function holderAuthority(vault: string, fold: LaneFolded, path: string): Authority | null {
  if (!insideBrain(vault, path)) return null;
  const place = lanePlaceOf(brainRelOf(vault, path));
  if (place === null) return null;
  return fold.authorities.get(laneEntryKey(place.lane, place.entry)) ?? null;
}

/** One lane page as a lane module reads it. */
export interface LanePage {
  /** Absolute path of the page (a legacy path; no file on a store-only machine). */
  readonly path: string;
  readonly frontmatter: FrontmatterMap;
  readonly body: string;
}

/** The text of the store entry `value` at `path`, as `readLaneText` answers it. */
export function entryText(path: string, value: LaneEntryValue): string {
  if (value.raw !== undefined && rawParsesBack(path, value.raw, value.fields, value.text)) {
    return value.raw;
  }
  return renderLaneText(path, value.fields, value.text);
}

/**
 * One read of a store-held lane entry, for a read-modify-write: the page
 * and the stored text come from the same fold value, and `unchanged()`
 * answers whether the store still holds that value, so a write that
 * follows lands only on the entry it was computed from.
 */
export interface LaneEntrySnapshot {
  readonly page: LanePage;
  readonly text: string;
  /**
   * Whether the fold this entry was read from is whole: a record it could
   * not read (an unreadable shard, a pending body blob) may be a newer
   * version of the entry, so a write from this read waits while it is not.
   */
  readonly whole: boolean;
  /** The authority of the record that holds the entry now, from the same read. */
  readonly authority: Authority | null;
  /** Whether the store, read whole again, still holds the entry this snapshot read. */
  unchanged(): boolean;
}

/**
 * The store-held lane entry at `path` read once ({@link LaneEntrySnapshot}),
 * or null when the store holds no entry there. For a store-held path only.
 */
export function readLaneEntrySnapshot(
  vault: string,
  path: string,
  configPath?: string,
): LaneEntrySnapshot | null {
  const { value, whole, authority } = storeEntryRead(vault, path, configPath);
  if (value === null) return null;
  return {
    page: { path, frontmatter: fieldsCopy(value), body: value.text },
    text: entryText(path, value),
    whole,
    authority,
    unchanged: () => {
      const now = storeEntryRead(vault, path, configPath);
      return now.whole && sameEntry(now.value, value.fields, value.text, value.raw);
    },
  };
}

/**
 * Whether the lane fold of every partition may miss a record
 * ({@link laneFoldIncomplete}: an `events` shard unreadable or gone since
 * this machine read it, or a record in `private` whose body blob has not
 * arrived): an entry's private records may be among them, so every
 * privacy verdict over the fold fails closed (design D14).
 */
export function foldIncomplete(configPath?: string): boolean {
  return laneFoldIncomplete(wholeLaneStoreFold(configPath));
}

/** Whether the live entry `value` was written to the `private` partition (every partition read). */
export function livesInPrivate(value: LaneEntryValue, configPath?: string): boolean {
  return wholeLaneStoreFold(configPath).privateKeys.has(laneEntryKey(value.lane, value.entry));
}

/**
 * Whether the store holds `path` on this machine as a live entry of the
 * `private` partition. An entry can be private by partition alone, with no
 * `visibility:` in its fields, so an exporter that turns entries back into
 * pages asks here to keep the privacy (review finding F333). A path the
 * store does not hold is no private entry. While the fold may miss a
 * record ({@link foldIncomplete}), every lane entry reads as private (fail
 * closed). One read of the fold of every partition, whatever the scope.
 */
export function laneEntryInPrivate(vault: string, path: string, configPath?: string): boolean {
  if (!heldInStore(vault, path, configPath)) return false;
  const place = lanePlaceOf(brainRelOf(vault, path));
  if (place === null) return false;
  const fold = wholeLaneStoreFold(configPath);
  if (laneFoldIncomplete(fold)) return true;
  const key = laneEntryKey(place.lane, place.entry);
  return fold.entries.has(key) && fold.privateKeys.has(key);
}

/** The partition the live entry `value` lives in. */
export function partitionOf(value: LaneEntryValue): StorePartition {
  return livesInPrivate(value) ? "private" : "shared";
}

/**
 * The tombstone of a live entry, in the partition the entry lives in
 * whatever the rest of its operation is (`Located`, content-free): a
 * device that holds only `shared` must see a shared entry's tombstone.
 * `onlyIfApart`: the tombstone of an entry a write replaces, needed only
 * when the replacement lands in another partition. `partition`: where the
 * entry lives, when the caller read it from the same fold as `value`.
 * `replacedAuthority`: the authority of the record that holds the entry,
 * from the same read; the tombstone keeps it when it is the stronger
 * (`lane-standing.ts`).
 */
export function tombstoneOf(
  value: LaneEntryValue,
  onlyIfApart = false,
  partition: StorePartition = partitionOf(value),
  replacedAuthority?: Authority | null,
): DualWriteRecord {
  return {
    ...laneEntryRemoveRecord({
      lane: value.lane,
      entry: value.entry,
      ...keptStanding(authorityFor(value.lane), replacedAuthority),
      private: partition === "private",
    }),
    located: { partition, content: false, ...(onlyIfApart ? { onlyIfApart: true } : {}) },
  };
}

/**
 * The tombstone a write replacing the entry at `path` adds before its new
 * record: the old entry lives in `shared`, so if the new value lands in
 * `private` (a raise), a device that holds only `shared` sees the entry
 * go rather than keep reading the old value. Nothing when no shared entry
 * is replaced; the append drops it when the new value stays in `shared`.
 */
export function replacedShared(
  vault: string,
  path: string,
  configPath?: string,
): DualWriteRecord[] {
  if (!isLaneEntryPath(vault, path)) return [];
  // One read: the replaced entry and the authority of its record, which
  // the tombstone keeps (`lane-standing.ts`).
  const { value: prior, authority } = storeEntryRead(vault, path, configPath);
  return prior !== null && !livesInPrivate(prior, configPath)
    ? [tombstoneOf(prior, true, "shared", authority)]
    : [];
}

/** An entry's fields as a fresh map: a caller may edit what it reads. */
export function fieldsCopy(value: LaneEntryValue): FrontmatterMap {
  return structuredClone(value.fields) as FrontmatterMap;
}

/** Whether `value` already holds exactly these fields and text. */
export function sameEntry(
  value: LaneEntryValue | null,
  fields: Readonly<Record<string, unknown>>,
  text: string,
  raw?: string,
): boolean {
  return (
    value !== null &&
    value.text === text &&
    canonicalJson(value.fields) === canonicalJson(fields) &&
    value.raw === raw
  );
}

function authorityFor(lane: string): Authority {
  return lane === STANDING_RULE_LANE ? "human" : authorityFromOrigin();
}

/**
 * The authority a record is stored at and, when it is not the writer's own
 * (`own`), that own authority as `actedBy`: the stronger of `own` and the
 * authority of the record that holds the key (design D1, D4).
 */
function keptStanding(
  own: Authority,
  replacedAuthority: Authority | null | undefined,
): { readonly authority: Authority; readonly actedBy?: Authority } {
  const authority = strongerAuthority(own, replacedAuthority);
  return authority === own ? { authority } : { authority, actedBy: own };
}

export function isPrivateEntry(
  vault: string,
  fields: Readonly<Record<string, unknown>>,
  text: string,
  raw?: string,
  configPath?: string,
): boolean {
  return (
    isPrivateFrontmatter(fields) ||
    rowNamesPrivatePage(
      existsSync(vault) ? vault : null,
      lanePrivacyRow(fields, text, raw),
      PAGE_OPAQUE_FIELDS,
      configPath,
    )
  );
}

export function entryRecord(
  vault: string,
  path: string,
  fields: Readonly<Record<string, unknown>>,
  text: string,
  isPrivate: boolean,
  /**
   * `located`: `isPrivate` is where an existing entry lives (a move), and
   * the record stays there; the lane's private-when-held rule would send
   * a shared entry's move, its tombstone included, to `private`, where a
   * device without that partition never sees the old entry removed.
   */
  placement: "judged" | "located" = "judged",
  raw?: string,
  /** The writer's own authority; the lane's own (`authorityFor`) when absent. */
  authority?: Authority,
  /**
   * The authority of the record that holds the key, a live entry or a
   * removal, from the read the record is built from: the record keeps it
   * when it is the stronger (`lane-standing.ts`).
   */
  replacedAuthority?: Authority | null,
): DualWriteRecord {
  const { lane, entry } = placeOf(vault, path);
  const agent =
    typeof fields["agent"] === "string" && fields["agent"].trim() !== ""
      ? fields["agent"].trim()
      : undefined;
  const kept = rawToKeep(path, raw, fields, text);
  return laneEntryRecord({
    lane,
    entry,
    fields,
    text,
    ...(kept !== undefined ? { raw: kept } : {}),
    ...keptStanding(authority ?? authorityFor(lane), replacedAuthority),
    ...(agent !== undefined ? { agent } : {}),
    private: isPrivate,
    // The lanes the migration imports as blobs are private wherever this
    // machine holds the private partition (`surface-map.ts` `blobLane`).
    ...(placement === "judged" && PRIVATE_WHEN_HELD_LANES.has(lane)
      ? { privateWhenHeld: true }
      : {}),
  });
}

/** Lanes whose records go to `private` whenever this machine holds it. */
const PRIVATE_WHEN_HELD_LANES: ReadonlySet<string> = new Set(["source-archive"]);

/**
 * Whether a write to `path` replaces a private lane entry (design D14, one
 * verdict per operation, fail closed). Such an entry stays private whatever
 * the new content says: an overwrite that drops the visibility field must
 * never land the entry's text in `shared`. Nothing lowers an entry's
 * partition; an operator who wants it shared removes it and writes it anew.
 *
 * Two halves, because on an unswitched machine the legacy file is replaced
 * before the dual-write record is built:
 *  - {@link legacyPagePrivate}, read before the write: the legacy page's
 *    own frontmatter (an unswitched machine only; a legacy page has no
 *    partition).
 *  - {@link storedEntryPrivate}, read when the record is built: the live
 *    store entry lives in `private` or its fields reserve it.
 */
export function legacyPagePrivate(vault: string, path: string, configPath?: string): boolean {
  if (!isLaneEntryPath(vault, path) || heldInStore(vault, path, configPath) || !existsSync(path))
    return false;
  try {
    return isPrivateFrontmatter(laneTextParts(path, readFileSync(path, "utf8")).fields);
  } catch {
    // A page that exists but cannot be read cannot be judged: fail closed.
    return true;
  }
}

/**
 * See {@link legacyPagePrivate}. While the fold may miss a record
 * ({@link foldIncomplete}), the entry may be private in it: the write is judged private (on a machine without
 * the `private` partition, refused).
 */
export function storedEntryPrivate(vault: string, path: string, configPath?: string): boolean {
  if (!isLaneEntryPath(vault, path)) return false;
  if (foldIncomplete(configPath)) return true;
  const value = wholeStoreEntry(vault, path, configPath);
  return (
    value !== null && (livesInPrivate(value, configPath) || isPrivateFrontmatter(value.fields))
  );
}

/**
 * Whether the lane entry a writer is about to write at `path` with `text`
 * lives in `private` once written: the entry there does or reserves it,
 * the legacy page there reserves it, or the judge every lane write applies
 * ({@link isPrivateEntry}) finds the text private. A writer that, in the
 * same operation, writes a second record carrying facts of the entry runs
 * that write under this verdict, decided before either is written (design
 * D12 of `lane-private-partition-reach`). A failed judgement answers true.
 */
export function laneTextLandsPrivate(
  vault: string,
  path: string,
  text: string,
  configPath?: string,
): boolean {
  try {
    if (legacyPagePrivate(vault, path, configPath) || storedEntryPrivate(vault, path, configPath))
      return true;
    const { fields, body } = laneTextParts(path, text);
    return isPrivateEntry(vault, fields, body, rawToKeep(path, text, fields, body), configPath);
  } catch {
    return true;
  }
}

/**
 * A lane file's text as an entry's fields and text: a page's frontmatter
 * and body, a JSON object as the fields, anything else (malformed JSON
 * included, which the legacy writer also writes as it is) as text.
 */
export { laneTextParts } from "./lane-raw.ts";
