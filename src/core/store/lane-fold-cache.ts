/**
 * The store side of the lane page store (`lane-pages.ts`): the fold of
 * every `lane-entry` and `lane-entry-remove` record of the configured
 * store, cached per store root until an `events` shard changes, and the
 * device-local lock targets lane writes take on a store-only machine.
 *
 * The fold remembers which live entries were written to the `private`
 * partition: a removal or a move writes its tombstone where the entry
 * lives, so a device that holds only `shared` sees a shared entry's
 * tombstone (forgetting reaches every device that saw the entry).
 *
 * It also names the `events` shards it could not read, or that this
 * machine read before and that are gone now: an entry's records in one
 * are unknown, so a privacy decision over the fold fails closed while any
 * is listed. Such a fold is never cached, so a shard that reads again is
 * folded at once. A fold that left out a record whose body is a pending
 * blob is cached against the availability of every blob it skipped
 * (`pendingBlobs`): the stamp moves the moment a blob arrives, so the fold
 * is rebuilt then, and it stays cached while every one is absent. A
 * switched machine whose store cannot be opened lists that reason the same
 * way (`read/protection-store.ts`).
 */

import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { join, resolve } from "node:path";

import { processDirsEnv, stateRootDir } from "../platform-dirs.ts";
import { STORE_PARTITIONS } from "./constants.ts";
import type { StoreRecord } from "./envelope.ts";
import { parseHlc } from "./hlc.ts";
import {
  foldLaneEntries,
  LANE_ENTRY_KIND,
  LANE_ENTRY_REMOVE_KIND,
  type LaneEntryValue,
} from "./lane-records.ts";
import { readStreamRecords } from "./read/stream-read.ts";
import { quarantineStamp } from "./shard-quarantine.ts";
import { protectionStore, StoreUnavailableError } from "./read/protection-store.ts";
import { listShards } from "./shard-list.ts";
import type { StoreInspection } from "./store-open.ts";
import { partitionDir, pendingBlobStampLines } from "./store-paths.ts";

export interface LaneFolded {
  readonly fingerprint: string;
  readonly entries: ReadonlyMap<string, LaneEntryValue>;
  /** Physical ms of the newest record of each live entry (its "mtime"). */
  readonly clocks: ReadonlyMap<string, number>;
  /** Keys of the live entries whose winning record is in `private`. */
  readonly privateKeys: ReadonlySet<string>;
  /**
   * `<partition>/<rel>` of every `events` shard whose records the fold
   * could not see (unreadable, or gone since this machine read it).
   */
  readonly unreadable: ReadonlyArray<string>;
  /**
   * `<partition>/<sha>` of every blob a skipped pending record's body
   * still references (the identities the cache fingerprints against, one
   * stat each, instead of rescanning the shards).
   */
  readonly pendingBlobs: ReadonlyArray<string>;
}

const EMPTY_FOLD: LaneFolded = {
  fingerprint: "",
  entries: new Map(),
  clocks: new Map(),
  privateKeys: new Set(),
  unreadable: [],
  pendingBlobs: [],
};

const cache = new Map<string, LaneFolded>();

/**
 * A stamp of every `events` shard of `store` and the quarantine ledger:
 * the shard-and-quarantine part of a stored fold's fingerprint. The
 * availability of the blobs a fold skipped is appended when the fold is
 * stored (`pendingBlobStampLines`), so the stored stamp moves the moment
 * one is delivered and stays put while it is absent.
 */
function laneFingerprintOf(store: StoreInspection): string {
  const parts: string[] = [store.storeId, `quarantine=${quarantineStamp(store.root)}`];
  for (const partition of [...store.partitions].toSorted()) {
    for (const shard of listShards(partitionDir(store.root, partition), { stream: "events" })) {
      let stamp = "missing";
      try {
        const stat = statSync(shard.path);
        stamp = `${stat.size}:${stat.mtimeMs}`;
      } catch {
        // gone between the listing and the stat: reads as changed
      }
      parts.push(`${partition}/${shard.rel}=${stamp}`);
    }
  }
  return parts.join("\n");
}

/**
 * The lane fold of the configured store (empty with no store; on a
 * switched machine whose store cannot be opened, empty with that reason
 * in `unreadable`).
 */
export function laneStoreFold(): LaneFolded {
  let store: StoreInspection | null;
  try {
    store = protectionStore(undefined, { needShared: true });
  } catch (err) {
    if (!(err instanceof StoreUnavailableError)) throw err;
    // A switched machine whose store cannot be opened sees no shard at
    // all: every privacy decision over the fold fails closed. Not cached.
    // The reach-safe twin of the error's message goes into the list: it
    // reaches callers at remote reach.
    return { ...EMPTY_FOLD, unreadable: [err.publicMessage] };
  }
  if (store === null) return EMPTY_FOLD;
  const cached = cache.get(store.root);
  // The stamp a stored fold must still match: the shard part plus the
  // availability of the blobs that fold skipped (one stat each, no shard
  // is read). A fold whose stored stamp lists no blob lines is uncached.
  const cachedLines =
    cached === undefined ? null : pendingBlobStampLines(store.root, cached.pendingBlobs);
  const shardStamp = laneFingerprintOf(store);
  const fingerprint = cachedLines === null ? null : `${shardStamp}\n${cachedLines}`;
  if (cached !== undefined && cached.fingerprint === fingerprint) return cached;
  const records: StoreRecord[] = [];
  const inPrivate = new Set<string>();
  const unreadable: string[] = [];
  const pendingBlobs: string[] = [];
  for (const partition of STORE_PARTITIONS) {
    if (!store.partitions.has(partition)) continue;
    const read = readStreamRecords(store.root, partition, { stream: "events" });
    for (const rel of read.unreadable) unreadable.push(`${partition}/${rel}`);
    for (const sha of read.pendingBlobs) pendingBlobs.push(`${partition}/${sha}`);
    for (const record of read.records) {
      if (record.kind !== LANE_ENTRY_KIND && record.kind !== LANE_ENTRY_REMOVE_KIND) continue;
      records.push(record);
      if (partition === "private") inPrivate.add(record.id);
    }
  }
  const entries = new Map<string, LaneEntryValue>();
  const clocks = new Map<string, number>();
  const privateKeys = new Set<string>();
  for (const [key, state] of foldLaneEntries(records).entries) {
    if (state.value === null) continue;
    entries.set(key, state.value);
    if (inPrivate.has(state.winner)) privateKeys.add(key);
    let newest = 0;
    for (const h of state.history) newest = Math.max(newest, parseHlc(h.record.hlc)?.physical ?? 0);
    clocks.set(key, newest);
  }
  // The fold is cached against the availability of every blob it skipped,
  // stamped now: a blob absent after the build was absent during it, so
  // the skip was correct and those lines belong with the shard stamp. A
  // blob present after the build arrived during it (or is there but
  // refused), so no stored stamp can describe the fold - it is left
  // uncached and rebuilt on the next read. A shard that reads again after
  // a permission change keeps its size and mtime, so an incomplete fold
  // is never reused either.
  const blobLines = pendingBlobStampLines(store.root, pendingBlobs);
  const storedFingerprint =
    blobLines === null ? `${Date.now()}:${Math.random()}` : `${shardStamp}\n${blobLines}`;
  const folded = {
    fingerprint: storedFingerprint,
    entries,
    clocks,
    privateKeys,
    unreadable,
    pendingBlobs,
  };
  if (unreadable.length === 0 && blobLines !== null) cache.set(store.root, folded);
  else cache.delete(store.root);
  return folded;
}

/**
 * The device-local lock target of the lane file at `path` (`salt` keeps a
 * create lock apart from the page lock). The path is resolved, and case
 * folded on Windows, so two spellings of one file take one lock.
 */
export function laneLockTarget(path: string, salt = ""): string {
  const resolved = resolve(path);
  const spelled = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const key = createHash("sha256").update(`${salt}${spelled}`).digest("hex").slice(0, 32);
  return join(stateRootDir(processDirsEnv()), "lane-locks", key);
}
