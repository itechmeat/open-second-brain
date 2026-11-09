/**
 * The store side of the lane page store: the path helpers the store side
 * needs (`lanePagesInStore`, `heldInStore`, `insideBrain`, `brainRelOf`,
 * `placeOf`, `isLaneEntryPath`), the fold accessors and the record
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
import { parseFrontmatterText } from "../vault.ts";
import { laneStoreFold } from "./lane-fold-cache.ts";
import { lanePlaceOf } from "./lane-paths.ts";
import {
  laneEntryKey,
  laneEntryRecord,
  laneEntryRemoveRecord,
  STANDING_RULE_LANE,
  type LaneEntryValue,
} from "./lane-records.ts";
import { opaqueFields } from "./operation-privacy.ts";
import { isPrivateFrontmatter } from "./private-page.ts";
import { rowNamesPrivatePage } from "./reference-privacy.ts";
import { storeOnlyMode } from "./store-only.ts";
import type { Authority, StorePartition } from "./constants.ts";
import { authorityFromOrigin, type DualWriteRecord } from "./dual-write.ts";

/** Whether lane pages of `vault` live in the store on this machine. */
export function lanePagesInStore(vault: string): boolean {
  return storeOnlyMode({ vault }).storeOnly;
}

/** Fields of a lane page that are stamps and ids, never page references. */
const PAGE_OPAQUE_FIELDS = opaqueFields("slug", "date", "valid_from", "content_hash", "revision");

/**
 * Does the store hold `path` on this machine: a store-only machine and a
 * path under `<vault>/Brain/`. Any other path (a user's `skills/` or
 * `runbooks/` page a lane module also reads) stays a file in both modes.
 */
export function heldInStore(vault: string, path: string): boolean {
  return lanePagesInStore(vault) && insideBrain(vault, path);
}

/** Whether `path` lies under `<vault>/Brain/` (or is it). */
export function insideBrain(vault: string, path: string): boolean {
  const rel = relative(join(vault, BRAIN_ROOT_REL), path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function brainRelOf(vault: string, path: string): string {
  return relative(join(vault, BRAIN_ROOT_REL), path).split(sep).join("/");
}

function placeOf(vault: string, path: string): { lane: string; entry: string } {
  const place = lanePlaceOf(brainRelOf(vault, path));
  if (place === null) throw new Error(`not a Brain lane page: ${path}`);
  return place;
}

function isLaneEntryPath(vault: string, path: string): boolean {
  return insideBrain(vault, path) && lanePlaceOf(brainRelOf(vault, path)) !== null;
}

// ----- The store side -----------------------------------------------------------

/** The live lane entries of the configured store, by `<lane>/<entry>`. */
export function storeEntries(): ReadonlyMap<string, LaneEntryValue> {
  return laneStoreFold().entries;
}

/**
 * The physical time (ms) of the newest record of the live lane entry at
 * `path`, the store's stand-in for a file's mtime; `null` when there is no
 * such entry. A file's mtime on a path the store does not hold.
 */
export function laneEntryClockMs(vault: string, path: string): number | null {
  if (!heldInStore(vault, path)) {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return null;
    }
  }
  const { lane, entry } = placeOf(vault, path);
  return laneStoreFold().clocks.get(laneEntryKey(lane, entry)) ?? null;
}

export function storeEntry(vault: string, path: string): LaneEntryValue | null {
  const { lane, entry } = placeOf(vault, path);
  return storeEntries().get(laneEntryKey(lane, entry)) ?? null;
}

/**
 * Whether the lane fold misses an `events` shard (unreadable, or gone
 * since this machine read it): an entry's private records may be in it,
 * so every privacy verdict over the fold fails closed (design D14).
 */
export function foldIncomplete(): boolean {
  return laneStoreFold().unreadable.length > 0;
}

/** Whether the live entry `value` was written to the `private` partition. */
export function livesInPrivate(value: LaneEntryValue): boolean {
  return laneStoreFold().privateKeys.has(laneEntryKey(value.lane, value.entry));
}

/**
 * Whether the store holds `path` on this machine as a live entry of the
 * `private` partition. An entry can be private by partition alone, with no
 * `visibility:` in its fields, so an exporter that turns entries back into
 * pages asks here to keep the privacy (review finding F333). A path the
 * store does not hold is no private entry. While the fold misses a shard,
 * every lane entry reads as private (fail closed).
 */
export function laneEntryInPrivate(vault: string, path: string): boolean {
  if (!heldInStore(vault, path)) return false;
  if (lanePlaceOf(brainRelOf(vault, path)) === null) return false;
  if (foldIncomplete()) return true;
  const value = storeEntry(vault, path);
  return value !== null && livesInPrivate(value);
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
 * when the replacement lands in another partition.
 */
export function tombstoneOf(value: LaneEntryValue, onlyIfApart = false): DualWriteRecord {
  const partition = partitionOf(value);
  return {
    ...laneEntryRemoveRecord({
      lane: value.lane,
      entry: value.entry,
      authority: authorityFor(value.lane),
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
export function replacedShared(vault: string, path: string): DualWriteRecord[] {
  if (!isLaneEntryPath(vault, path)) return [];
  const prior = storeEntry(vault, path);
  return prior !== null && !livesInPrivate(prior) ? [tombstoneOf(prior, true)] : [];
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
): boolean {
  return (
    value !== null && value.text === text && canonicalJson(value.fields) === canonicalJson(fields)
  );
}

function authorityFor(lane: string): Authority {
  return lane === STANDING_RULE_LANE ? "human" : authorityFromOrigin();
}

export function isPrivateEntry(
  vault: string,
  fields: Readonly<Record<string, unknown>>,
  text: string,
): boolean {
  return (
    isPrivateFrontmatter(fields) ||
    rowNamesPrivatePage(existsSync(vault) ? vault : null, { fields, text }, PAGE_OPAQUE_FIELDS)
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
): DualWriteRecord {
  const { lane, entry } = placeOf(vault, path);
  const agent =
    typeof fields["agent"] === "string" && fields["agent"].trim() !== ""
      ? fields["agent"].trim()
      : undefined;
  return laneEntryRecord({
    lane,
    entry,
    fields,
    text,
    authority: authorityFor(lane),
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
export function legacyPagePrivate(vault: string, path: string): boolean {
  if (!isLaneEntryPath(vault, path) || heldInStore(vault, path) || !existsSync(path)) return false;
  try {
    return isPrivateFrontmatter(laneTextParts(path, readFileSync(path, "utf8")).fields);
  } catch {
    // A page that exists but cannot be read cannot be judged: fail closed.
    return true;
  }
}

/**
 * See {@link legacyPagePrivate}. While the fold misses a shard, the entry
 * may be private in it: the write is judged private (on a machine without
 * the `private` partition, refused).
 */
export function storedEntryPrivate(vault: string, path: string): boolean {
  if (!isLaneEntryPath(vault, path)) return false;
  if (foldIncomplete()) return true;
  const value = storeEntry(vault, path);
  return value !== null && (livesInPrivate(value) || isPrivateFrontmatter(value.fields));
}

/**
 * A lane file's text as an entry's fields and text: a page's frontmatter
 * and body, a JSON object as the fields, anything else (malformed JSON
 * included, which the legacy writer also writes as it is) as text.
 */
export function laneTextParts(
  path: string,
  text: string,
): { fields: Record<string, unknown>; body: string } {
  if (path.endsWith(".md")) {
    const [frontmatter, rest] = parseFrontmatterText(text);
    return { fields: frontmatter, body: rest };
  }
  if (path.endsWith(".json")) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { fields: {}, body: text };
    }
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { fields: parsed as Record<string, unknown>, body: "" };
    }
  }
  return { fields: {}, body: text };
}
