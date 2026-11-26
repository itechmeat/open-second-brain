/**
 * The store side of the lane page store (`lane-pages.ts`): the fold of
 * every `lane-entry` and `lane-entry-remove` record of the configured
 * store, cached per store root until an `events` shard changes, and the
 * device-local lock targets lane writes take on a store-only machine.
 *
 * Two folds come from one builder. {@link laneStoreFold} is the caller's
 * fold: for a caller below local reach (`privateWithheld()`) it folds the
 * `shared` partition only, judged by the fold of every partition (a key
 * whose winning record is held in `private` is left out, and nothing is
 * left while that fold may miss a record), so every lane read answers
 * that caller as a machine holding only `shared` would, whatever reader
 * asks; otherwise it is the fold of every partition. {@link wholeLaneStoreFold} is always
 * the fold of every partition, for the work that needs it whatever the
 * scope (privacy verdicts, a write's placement and checks, record
 * builders, repairs). Each is cached under its own key, and their
 * fingerprints never match, so a memo keyed by the caller's stamp keeps a
 * value built for one scope away from the other.
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
import { privateWithheld } from "./caller-reach.ts";
import { STORE_PARTITIONS, type Authority, type StorePartition } from "./constants.ts";
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
import { partitionDir, blobStamp, pendingBlobStampLines } from "./store-paths.ts";

export interface LaneFolded {
  readonly fingerprint: string;
  readonly entries: ReadonlyMap<string, LaneEntryValue>;
  /** Physical ms of the newest record of each live entry (its "mtime"). */
  readonly clocks: ReadonlyMap<string, number>;
  /** Keys of the live entries whose winning record is in `private`. */
  readonly privateKeys: ReadonlySet<string>;
  /**
   * Keys whose winning record is a removal held in `private`: the entry
   * was private when it went, so a `shared` value of the key is stale.
   */
  readonly privateRemovals: ReadonlySet<string>;
  /**
   * Set on the caller's fold below local reach while the fold of every
   * partition may miss a record: the view then holds no entry at all, and
   * names no `private` gap ({@link laneStoreFold}).
   */
  readonly partitionUnknown?: true;
  /**
   * The authority of each live entry's winning record: a rewrite that only
   * adds to an entry (a privacy restamp) keeps it, so a later writer of the
   * same standing can still replace the entry.
   */
  readonly authorities: ReadonlyMap<string, Authority>;
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

/**
 * Whether `fold` may miss a record that makes a lane entry private: an
 * `events` shard it could not see (in either partition), or a record in
 * `private` whose body blob has not arrived (quarantined on this machine
 * or not; a quarantine lets the shard read as whole, yet the record is
 * still left out). Every lane privacy verdict over such a fold fails
 * closed: the one test of "the fold is complete enough to place in
 * `shared`" for every lane write, move and privacy read.
 *
 * A pending blob in `shared` is no such gap. A record in `shared` never
 * carries a value a write would place in `private` (every writer judges
 * the fields first), and leaving one record out changes an entry's
 * winner only when it is that winner, so the fold without it is at least
 * as private as the fold with it. So a quarantined blob in `shared` does
 * not block lane writes on a machine that holds only `shared`.
 */
export function laneFoldIncomplete(fold: LaneFolded): boolean {
  return (
    fold.unreadable.length > 0 || fold.pendingBlobs.some((blob) => blob.startsWith("private/"))
  );
}

const EMPTY_FOLD: LaneFolded = {
  fingerprint: "",
  entries: new Map(),
  clocks: new Map(),
  privateKeys: new Set(),
  privateRemovals: new Set(),
  authorities: new Map(),
  unreadable: [],
  pendingBlobs: [],
};

const cache = new Map<string, LaneFolded>();

/** The records a lane fold reads: lane entries and their tombstones. */
function isLaneRecord(record: StoreRecord): boolean {
  return record.kind === LANE_ENTRY_KIND || record.kind === LANE_ENTRY_REMOVE_KIND;
}

/**
 * A stamp of every `events` shard of `store` and the quarantine ledger:
 * the shard-and-quarantine part of a stored fold's fingerprint. The
 * availability of the blobs a fold skipped is appended when the fold is
 * stored (`pendingBlobStampLines`), so the stored stamp moves the moment
 * one is delivered and stays put while it is absent.
 */
function laneFingerprintOf(
  store: StoreInspection,
  partitions: ReadonlyArray<StorePartition>,
): string {
  const parts: string[] = [store.storeId, `quarantine=${quarantineStamp(store.root)}`];
  for (const partition of [...store.partitions].toSorted()) {
    if (!partitions.includes(partition)) continue;
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
 * The caller's lane fold of the configured store: below local reach
 * (`privateWithheld()`) the fold of the `shared` partition only, cached
 * under its own key, its fingerprint marked apart and stamped over the
 * `shared` shards only, its `privateKeys` empty and its `unreadable` and
 * `pendingBlobs` naming `shared` gaps only; otherwise the fold of every
 * partition ({@link wholeLaneStoreFold}). Every lane read goes through it,
 * so a reader nobody listed is narrowed by construction.
 */
export function laneStoreFold(configPath?: string): LaneFolded {
  if (!privateWithheld()) return wholeLaneStoreFold(configPath);
  return sharedView(foldOf(configPath, ["shared"]), wholeLaneStoreFold(configPath));
}

const views = new Map<string, LaneFolded>();

/**
 * The caller's fold below local reach: the fold of `shared` (`narrow`)
 * judged by the fold of every partition (`whole`), so a reader that binds
 * no reach rule of its own is narrowed too. While `whole` may miss a
 * record ({@link laneFoldIncomplete}) the view holds no entry at all (a
 * shared value may be the stale copy of an entry raised in a record the
 * fold cannot see), marked {@link LaneFolded.partitionUnknown}, its gaps
 * still the `shared` ones only. Otherwise every key whose winning record
 * in `whole` is held in `private` (a live entry, or a removal) is left
 * out: a `shared` value of it is stale (a raise or a removal whose
 * `shared` tombstone this machine has not read). The verdict is part of
 * the view's fingerprint, so a memo keyed by it never serves a value
 * built before the verdict changed.
 */
function sharedView(narrow: LaneFolded, whole: LaneFolded): LaneFolded {
  // The view is a function of the two folds, which their fingerprints
  // name, so the memo is asked before any key is scanned. A fold of a
  // store that could not be opened has no fingerprint: never memoized,
  // so two such results never share a key.
  const memoKey =
    narrow.fingerprint === "" || whole.fingerprint === ""
      ? null
      : `${narrow.fingerprint}\u0000${whole.fingerprint}`;
  const memo = memoKey === null ? undefined : views.get(memoKey);
  if (memo !== undefined) return memo;
  const remember = (view: LaneFolded): LaneFolded => {
    views.clear();
    if (memoKey !== null) views.set(memoKey, view);
    return view;
  };
  const unknown = laneFoldIncomplete(whole);
  const dropped = unknown
    ? [...narrow.entries.keys()]
    : [...narrow.entries.keys()].filter(
        (key) => whole.privateKeys.has(key) || whole.privateRemovals.has(key),
      );
  if (!unknown && dropped.length === 0) return remember(narrow);
  const verdict = unknown
    ? "withheld=all"
    : `withheld=${createHash("sha256").update(dropped.toSorted().join("\n")).digest("hex")}`;
  const fingerprint = `${narrow.fingerprint}\n${verdict}`;
  const gone = new Set(dropped);
  const keep = <V>(map: ReadonlyMap<string, V>): Map<string, V> =>
    new Map([...map].filter(([key]) => !gone.has(key)));
  const view: LaneFolded = {
    fingerprint,
    entries: keep(narrow.entries),
    clocks: keep(narrow.clocks),
    privateKeys: new Set(),
    privateRemovals: new Set(),
    authorities: keep(narrow.authorities),
    unreadable: narrow.unreadable,
    pendingBlobs: narrow.pendingBlobs,
    ...(unknown ? { partitionUnknown: true as const } : {}),
  };
  return remember(view);
}

/**
 * The lane fold of every partition this machine holds, whatever the scope
 * (empty with no store; on a switched machine whose store cannot be
 * opened, empty with that reason in `unreadable`): for a privacy verdict,
 * a write's placement and version checks, a record builder or a repair,
 * which must see every entry the store holds.
 */
export function wholeLaneStoreFold(configPath?: string): LaneFolded {
  return foldOf(configPath, STORE_PARTITIONS);
}

/**
 * The lane fold of `partitions` of the configured store. The fold of
 * every partition is cached under the store root; any narrower one under
 * the root plus its partitions, with its fingerprint prefixed by a line
 * naming them (`shared-only` for the caller's fold below local reach),
 * which no fold of every partition carries.
 */
function foldOf(
  configPath: string | undefined,
  partitions: ReadonlyArray<StorePartition>,
): LaneFolded {
  const narrow = STORE_PARTITIONS.some((partition) => !partitions.includes(partition));
  let store: StoreInspection | null;
  try {
    store = protectionStore(configPath, { needShared: true });
  } catch (err) {
    if (!(err instanceof StoreUnavailableError)) throw err;
    // A switched machine whose store cannot be opened sees no shard at
    // all: every privacy decision over the fold fails closed. Not cached.
    // The reach-safe twin of the error's message goes into the list: it
    // reaches callers at remote reach.
    return { ...EMPTY_FOLD, unreadable: [err.publicMessage] };
  }
  if (store === null) return EMPTY_FOLD;
  const cacheKey = narrow ? `${store.root}\u0000${partitions.join(",")}` : store.root;
  const prefix = narrow ? `${partitions.join(",")}-only\n` : "";
  const cached = cache.get(cacheKey);
  // The stamp a stored fold must still match: the shard part plus the
  // availability of the blobs that fold skipped (one stat each, no shard
  // is read). A fold whose stored stamp lists no blob lines is uncached.
  const cachedLines =
    cached === undefined ? null : pendingBlobStampLines(store.root, cached.pendingBlobs);
  const shardStamp = laneFingerprintOf(store, partitions);
  const fingerprint = cachedLines === null ? null : `${prefix}${shardStamp}\n${cachedLines}`;
  if (cached !== undefined && cached.fingerprint === fingerprint) return cached;
  const records: StoreRecord[] = [];
  const inPrivate = new Set<string>();
  const unreadable: string[] = [];
  const pendingBlobs: string[] = [];
  for (const partition of STORE_PARTITIONS) {
    if (!store.partitions.has(partition) || !partitions.includes(partition)) continue;
    // Only the lane records are held: the rest of `events` (signals, the
    // log, preferences) is parsed and dropped as it streams by, so a hook
    // that reads one lane entry never holds the whole stream. A record of
    // another kind waiting for its blob opens no gap in a lane entry, so
    // it is not counted among the skipped blobs either.
    const read = readStreamRecords(
      store.root,
      partition,
      { stream: "events" },
      { keep: isLaneRecord },
    );
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
  const privateRemovals = new Set<string>();
  const authorities = new Map<string, Authority>();
  for (const [key, state] of foldLaneEntries(records).entries) {
    if (state.value === null) {
      if (inPrivate.has(state.winner)) privateRemovals.add(key);
      continue;
    }
    entries.set(key, state.value);
    const winner = state.history.find((h) => h.record.id === state.winner);
    if (winner !== undefined) authorities.set(key, winner.authority);
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
  // is never reused either. An uncached fold still carries a
  // deterministic stamp (`incompleteFingerprint`), so the memos keyed by
  // `laneStoreStamp` keep hitting while the degraded state stays the same
  // instead of forcing a full rebuild on every read.
  const blobLines = pendingBlobStampLines(store.root, pendingBlobs);
  const storedFingerprint =
    prefix +
    (blobLines === null || unreadable.length > 0
      ? incompleteFingerprint(store, shardStamp, unreadable, pendingBlobs, records)
      : `${shardStamp}\n${blobLines}`);
  const folded = {
    fingerprint: storedFingerprint,
    entries,
    clocks,
    privateKeys,
    privateRemovals,
    authorities,
    unreadable,
    pendingBlobs,
  };
  if (unreadable.length === 0 && blobLines !== null) cache.set(cacheKey, folded);
  else cache.delete(cacheKey);
  return folded;
}

/**
 * The deterministic fingerprint of a fold that is left uncached (an
 * `events` shard this machine cannot read or read before and that is gone,
 * or a skipped blob that is present but refused): an `incomplete` prefix -
 * which no healthy fold's fingerprint can carry - then the shard stamp,
 * the shards the fold could not see, a digest of the records the fold
 * DID see, and one full `lstat` identity (`blobStamp`) per refused blob.
 * The record digest is what lets two degraded folds over identically
 * stamped shards disagree: a transient read failure of a shard and a read
 * gap inside it (one corrupt line) both name that shard `unreadable`
 * while its size and mtime stay put, but the first leaves the fold with
 * none of its records and the second with its readable ones - so the
 * stamp moves the moment the contributing records change, and a memo
 * keyed by it never serves a fold built over different records. It moves
 * when a shard reads again or a refused blob's identity changes, and
 * never collides with a stored fingerprint, so a memo keyed by it serves
 * the same degraded build while the state lasts and drops it the moment
 * it lifts.
 */
function incompleteFingerprint(
  store: StoreInspection,
  shardStamp: string,
  unreadable: ReadonlyArray<string>,
  pendingBlobs: ReadonlyArray<string>,
  records: ReadonlyArray<StoreRecord>,
): string {
  const recordDigest = createHash("sha256");
  for (const record of records) {
    recordDigest.update(`${record.id}\u0000${record.hlc}\u0001`);
  }
  const parts = [
    "incomplete",
    shardStamp,
    `unreadable=${unreadable.toSorted().join(",")}`,
    `records=${recordDigest.digest("hex")}`,
  ];
  for (const identity of pendingBlobs.toSorted()) {
    const slashAt = identity.indexOf("/");
    const partition = identity.slice(0, slashAt) as (typeof STORE_PARTITIONS)[number];
    const sha = identity.slice(slashAt + 1);
    parts.push(`blob ${identity}=${blobStamp(partitionDir(store.root, partition), sha)}`);
  }
  return parts.join("\n");
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
