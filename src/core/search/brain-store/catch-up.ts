/**
 * Catch-up before reads (design D5, task 1.8): before a search or a change
 * probe answers, the index ingests every record appended to the brain
 * store since its watermark for each shard.
 *
 * The cheap path is the common one. At most once per
 * {@link catchUpIntervalMs} per process and index, the shards are listed
 * (directory listings cached by directory mtime) and stat'ed, and the
 * stats are compared with the watermarks this process last saw. When
 * nothing moved, the check ends there: no store file is opened and the
 * index is not opened either.
 *
 * When a shard moved, the index is opened for writing (only when no other
 * writer holds it, so a running rebuild never blocks a read) and each
 * changed shard is read from its stored offset through the store reader.
 * A shard whose identity changed, that shrank below its offset, or whose
 * verified prefix no longer hashes the same is re-read from offset 0; the
 * re-read is idempotent by record id, and records the shard no longer
 * holds are removed. A shard that disappeared takes its records with it,
 * except those a sibling shard still holds (`orphans.ts`).
 *
 * An index that is missing or not at the current schema is left alone:
 * the read's self-heal builds or upgrades it, and the rebuild ingests the
 * store into the staging file before the swap ({@link ingestStoreInto}).
 */

import { Database } from "bun:sqlite";

import { readDeviceId } from "../../config.ts";
import { closeDatabase } from "../../sqlite-close.ts";
import { observeClock } from "../../store/clock-store.ts";
import { compareHlc, parseHlc } from "../../store/hlc.ts";
import { readBlobBody, readShard } from "../../store/reader.ts";
import { blobPath, partitionDir } from "../../store/store-paths.ts";
import { SIGNAL_KIND, type StorePartition } from "../../store/constants.ts";
import { SIGNAL_STATE_KIND } from "../../store/fold-signals.ts";
import { LANE_ENTRY_KIND } from "../../store/lane-records.ts";
import { TOMBSTONE_KINDS, voidedRecordIds } from "../../store/removal-backlog.ts";
import { LATEST_SCHEMA_VERSION, readSchemaVersion } from "../schema.ts";
import { Store } from "../store.ts";
import {
  deleteWatermark,
  getRecord,
  hasBrainRecordTables,
  holdsRecordKind,
  pendingRecords,
  readWatermarks,
  recordIdsOfShard,
  writeWatermark,
  type StoreWatermark,
} from "../store/brain-records.ts";
import { isWriterLockHeld } from "../store/writer-lock.ts";
import { SearchError, type ResolvedSearchConfig } from "../types.ts";
import { STORE_CATCH_UP_INTERVAL_ENV, STORE_CATCH_UP_INTERVAL_MS } from "./constants.ts";
import { completePendingRecord, ingestRecord, removeRecord } from "./ingest.ts";
import type { IndexedStore } from "./location.ts";
import { settleOrphans, type Orphans } from "./orphans.ts";
import { prefixHash } from "./prefix-hash.ts";
import { ShardScanner, statShardFile, type ShardStat } from "./shard-scan.ts";

/** Why a catch-up did not look at, or did not write, the store. */
export type CatchUpSkip =
  | "no-store"
  | "throttled"
  | "no-index"
  | "not-current"
  | "locked"
  | "failed";

export interface CatchUpResult {
  /** Null when the check ran to the end (whether or not anything changed). */
  readonly skipped: CatchUpSkip | null;
  /** Shards read in this pass. */
  readonly shardsRead: number;
  /** Records added to the index. */
  readonly added: number;
  /** Records removed because their shard no longer holds them. */
  readonly removed: number;
  /** Pending blob bodies that arrived and were indexed. */
  readonly completed: number;
  /** The failure, when {@link skipped} is `failed`. */
  readonly error?: string;
}

export interface CatchUpOptions {
  /** Ignore the throttle (a write path that must see the store now). */
  readonly force?: boolean;
}

type FileStat = Pick<ShardStat, "identity" | "size" | "mtimeMs">;

/** Per-process memory of one index's catch-up. */
interface ProcessState {
  readonly scanner: ShardScanner;
  readonly storeRoot: string;
  lastCheckMs: number;
  indexIdentity: string | null;
  /** Shard stats as of the watermarks last seen, or null when unknown. */
  known: Map<string, FileStat> | null;
  /**
   * Blob files whose arrival would complete a pending record, each with
   * its stat when last looked at (null: absent or not looked at yet). A
   * blob that is present but fails verification keeps its stat here, so
   * it triggers a write pass again only once it changes.
   */
  pendingBlobs: ReadonlyMap<string, FileStat | null>;
}

const states = new Map<string, ProcessState>();

const NOTHING = { shardsRead: 0, added: 0, removed: 0, completed: 0 } as const;

/**
 * Forget what this process last saw of the index at `dbPath`, so the next
 * catch-up reads its watermarks again: for a writer that emptied the
 * store tables behind catch-up's back.
 */
export function forgetCatchUpState(dbPath: string): void {
  states.delete(dbPath);
}

/** The throttle between two metadata passes, from the environment or the default. */
export function catchUpIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[STORE_CATCH_UP_INTERVAL_ENV]?.trim();
  if (raw === undefined || raw === "") return STORE_CATCH_UP_INTERVAL_MS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : STORE_CATCH_UP_INTERVAL_MS;
}

function stateFor(config: ResolvedSearchConfig, store: IndexedStore): ProcessState {
  const existing = states.get(config.dbPath);
  if (existing !== undefined && existing.storeRoot === store.root) return existing;
  const fresh: ProcessState = {
    scanner: new ShardScanner(store),
    storeRoot: store.root,
    lastCheckMs: Number.NEGATIVE_INFINITY,
    indexIdentity: null,
    known: null,
    pendingBlobs: new Map(),
  };
  states.set(config.dbPath, fresh);
  return fresh;
}

function sameStat(a: FileStat, b: FileStat): boolean {
  return a.identity === b.identity && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/** Whether any pending blob looks different from when it was last looked at. */
function blobMoved(pendingBlobs: ReadonlyMap<string, FileStat | null>): boolean {
  for (const [path, before] of pendingBlobs) {
    const now = statShardFile(path);
    if (now === null ? before !== null : before === null || !sameStat(before, now)) return true;
  }
  return false;
}

function unchanged(known: Map<string, FileStat>, shards: ReadonlyArray<ShardStat>): boolean {
  if (known.size !== shards.length) return false;
  return shards.every((s) => {
    const k = known.get(s.key);
    return k !== undefined && sameStat(k, s);
  });
}

function knownFrom(marks: Map<string, StoreWatermark>): Map<string, FileStat> {
  const out = new Map<string, FileStat>();
  for (const [key, m] of marks)
    out.set(key, { identity: m.identity, size: m.size, mtimeMs: m.mtimeMs });
  return out;
}

function pendingBlobPaths(store: IndexedStore, db: Database): string[] {
  return pendingRecords(db).map((r) =>
    blobPath(partitionDir(store.root, r.partition as StorePartition), r.sum),
  );
}

/** Watermarks and pending blobs of a current index, read-only; null when it is not current. */
function peekIndex(
  dbPath: string,
  store: IndexedStore,
): { known: Map<string, FileStat>; pendingBlobs: Map<string, FileStat | null> } | null {
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }
  try {
    if (readSchemaVersion(db) !== LATEST_SCHEMA_VERSION || !hasBrainRecordTables(db)) return null;
    // Not looked at yet: a blob already present triggers one pass.
    const pendingBlobs = new Map(pendingBlobPaths(store, db).map((p) => [p, null] as const));
    return { known: knownFrom(readWatermarks(db)), pendingBlobs };
  } catch {
    return null;
  } finally {
    closeDatabase(db);
  }
}

interface SyncTotals {
  shardsRead: number;
  /** Tombstones (`signal-removed`, `preference-remove`, `lane-entry-remove`) ingested this pass. */
  tombstones: number;
  added: number;
  /** Records added this pass of a kind a tombstone can void (a signal, a preference, a lane entry). */
  voidableAdded: number;
  removed: number;
  completed: number;
  /** Largest clock ingested from another device. */
  remoteHlc: string | null;
  /**
   * The blobs still pending after the pass, each stat'ed just BEFORE the
   * read that found it missing or broken: a blob that arrives between that
   * read and the end of the pass then looks moved on the next check, so it
   * is read again instead of being taken as already looked at.
   */
  pendingBlobs: Map<string, FileStat | null>;
}

/**
 * Read one changed shard and ingest its records. Records it was credited
 * with and no longer holds go to `orphans` rather than out of the index:
 * a compaction may hold them in a sibling shard. Returns the watermark to
 * write once the orphans are settled.
 */
function readOneShard(
  index: Store,
  config: ResolvedSearchConfig,
  store: IndexedStore,
  shard: ShardStat,
  mark: StoreWatermark | undefined,
  totals: SyncTotals,
  device: string | null,
  orphans: Orphans,
): { watermark: StoreWatermark; fromStart: boolean } {
  const db = index.brainRecordsConnection();
  const resume =
    mark !== undefined &&
    mark.identity === shard.identity &&
    shard.size >= mark.offset &&
    prefixHash(shard.path, mark.offset) === mark.prefixHash;
  const from = resume ? mark.offset : 0;
  const read = readShard(shard.path, {
    offset: from,
    partitionRoot: partitionDir(store.root, shard.partition),
  });
  totals.shardsRead++;
  const seen = new Set<string>();
  for (const r of read.records) {
    const outcome = ingestRecord(index, config, r.record, shard, r.bodyState === "pending");
    // A copy refused for sitting in the other partition does not hold the
    // record: it must not keep an orphaned row alive.
    if (outcome === "refused") continue;
    if (TOMBSTONE_KINDS.has(r.record.kind)) totals.tombstones++;
    seen.add(r.record.id);
    orphans.delete(r.record.id);
    if (outcome === "added") {
      totals.added++;
      if (isVoidableKind(r.record.kind)) totals.voidableAdded++;
    }
    if (r.record.device !== device) {
      const hlc = parseHlc(r.record.hlc);
      const best = totals.remoteHlc === null ? null : parseHlc(totals.remoteHlc);
      if (hlc !== null && (best === null || compareHlc(hlc, best) > 0))
        totals.remoteHlc = r.record.hlc;
    }
  }
  if (!resume && mark !== undefined) {
    for (const id of recordIdsOfShard(db, shard.key)) if (!seen.has(id)) orphans.set(id, shard.key);
  }
  const count = (kind: string): number => read.diagnostics.filter((d) => d.kind === kind).length;
  const post = statShardFile(shard.path) ?? shard;
  // The stat (and the prefix hash) are taken after the read, so they may
  // describe a newer file than the one read. Only an untouched file may
  // vouch for the read; an append keeps the prefix, so the next pass
  // resumes; anything else (a same-size swap or rewrite by a sync tool)
  // leaves no prefix hash, so the next pass reads the shard from 0.
  const sameFile = post.identity === shard.identity;
  const untouched =
    sameFile &&
    post.size === read.size &&
    (shard.size !== read.size || post.mtimeMs === shard.mtimeMs);
  const appended = sameFile && post.size > read.size;
  const watermark: StoreWatermark = {
    shard: shard.key,
    partition: shard.partition,
    identity: post.identity,
    size: read.size,
    mtimeMs: untouched ? post.mtimeMs : -1,
    offset: read.nextOffset,
    prefixHash: untouched || appended ? prefixHash(shard.path, read.nextOffset) : "",
    unknownVersions: (resume ? mark.unknownVersions : 0) + count("unknown-version"),
    corruptLines: (resume ? mark.corruptLines : 0) + count("corrupt-line"),
  };
  return { watermark, fromStart: !resume };
}

/** Every preference record kind starts with it (`preference-set`, `preference-evidence`, ...). */
const PREFERENCE_KIND_PREFIX = "preference-";

/** A record kind a tombstone can void: a signal's, a preference's, a lane entry's. */
function isVoidableKind(kind: string): boolean {
  return (
    kind === SIGNAL_KIND ||
    kind === SIGNAL_STATE_KIND ||
    kind === LANE_ENTRY_KIND ||
    kind.startsWith(PREFERENCE_KIND_PREFIX)
  );
}

/**
 * Take out of `index` every record a tombstone voided (a forgotten
 * signal, a removed preference, a removed lane entry), over all `events`
 * shards. Returns how many rows
 * left the index.
 */
function dropVoidedRecords(
  index: Store,
  store: IndexedStore,
  shards: ReadonlyArray<ShardStat>,
): number {
  const records = shards
    .filter((shard) => shard.stream === "events")
    .flatMap((shard) =>
      readShard(shard.path, {
        partitionRoot: partitionDir(store.root, shard.partition),
      }).records.map((r) => r.record),
    );
  const db = index.brainRecordsConnection();
  let removed = 0;
  for (const id of voidedRecordIds(records)) {
    const row = getRecord(db, id);
    if (row === null) continue;
    removeRecord(index, row);
    removed++;
  }
  return removed;
}

/** Bring `index` level with the shards in `shards`; returns what changed. */
function syncShards(
  index: Store,
  config: ResolvedSearchConfig,
  store: IndexedStore,
  shards: ReadonlyArray<ShardStat>,
): SyncTotals {
  const db = index.brainRecordsConnection();
  const marks = readWatermarks(db);
  const device = readDeviceId(config.configPath);
  const totals: SyncTotals = {
    shardsRead: 0,
    tombstones: 0,
    added: 0,
    voidableAdded: 0,
    removed: 0,
    completed: 0,
    remoteHlc: null,
    pendingBlobs: new Map(),
  };
  try {
    const orphans: Orphans = new Map();
    const present = new Set<string>();
    // Every shard read from its start this pass (the orphan settling skips
    // re-reading them), and of those the `events` shards, the only ones
    // holding records a tombstone voids.
    const readInFull = new Set<string>();
    const eventsReadInFull = new Set<string>();
    const next: StoreWatermark[] = [];
    for (const shard of shards) {
      present.add(shard.key);
      const mark = marks.get(shard.key);
      if (mark !== undefined && sameStat(mark, shard)) continue;
      const read = readOneShard(index, config, store, shard, mark, totals, device, orphans);
      if (read.fromStart) {
        readInFull.add(shard.key);
        if (shard.stream === "events") eventsReadInFull.add(shard.key);
      }
      next.push(read.watermark);
    }
    const vanished = [...marks.keys()].filter((key) => !present.has(key));
    for (const key of vanished) {
      for (const id of recordIdsOfShard(db, key)) if (!orphans.has(id)) orphans.set(id, key);
    }
    const settled = settleOrphans(index, config, store, shards, orphans, readInFull);
    totals.removed += settled.removed;
    // A forgotten signal leaves the index with its tombstone (FORMAT.md,
    // "Removal"): after a pass that read one, that re-read an events shard
    // from its start, or that added a record a known tombstone may void (a
    // line from before the tombstone that synced in late, appended to a
    // shard already read), every record the tombstones voided is taken out.
    if (
      totals.tombstones > 0 ||
      ((eventsReadInFull.size > 0 || totals.voidableAdded > 0) &&
        [...TOMBSTONE_KINDS].some((kind) => holdsRecordKind(db, kind)))
    ) {
      totals.removed += dropVoidedRecords(index, store, shards);
    }
    // Watermarks move only once the orphans are settled: a pass that
    // stops before that reads the same shards again next time, and a
    // shard whose orphans could not be settled keeps its old watermark
    // (a vanished one keeps its row), so the next pass meets them again.
    for (const w of next) if (!settled.retry.has(w.shard)) writeWatermark(db, w);
    for (const key of vanished) if (!settled.retry.has(key)) deleteWatermark(db, key);
    for (const pending of pendingRecords(db)) {
      const partitionRoot = partitionDir(store.root, pending.partition as StorePartition);
      const path = blobPath(partitionRoot, pending.sum);
      const before = statShardFile(path);
      // A blob that is absent, still arriving, or that can never hold the
      // body (hash-valid but not the record's JSON object) keeps the
      // record pending; it never throws out of the pass.
      const blob = readBlobBody(partitionRoot, pending.sum);
      if (blob.status !== "ok") {
        totals.pendingBlobs.set(path, before);
        continue;
      }
      completePendingRecord(index, config, pending, blob.body);
      totals.completed++;
    }
  } finally {
    // Whatever was already written moves the revision, even when a later
    // shard throws: the next pass finds those shards level and changes
    // nothing, so it would never bump for them.
    if (totals.added + totals.removed + totals.completed > 0) index.bumpIndexRevision();
  }
  if (device !== null && totals.remoteHlc !== null) {
    try {
      observeClock(store.deviceStateDir, device, parseHlc(totals.remoteHlc)!);
    } catch {
      // The receive rule is best effort here: the next catch-up raises it.
    }
  }
  return totals;
}

/**
 * Ingest the whole store into an index that is open for writing: the
 * rebuild path, which builds a staging index before the swap. Every
 * shard is read from offset 0 there, so records an older binary skipped
 * for an unknown format version are picked up.
 */
export function ingestStoreInto(index: Store, config: ResolvedSearchConfig): void {
  const store = config.brainStore;
  if (store === null || store === undefined) return;
  syncShards(index, config, store, new ShardScanner(store).scan());
}

/** Catch the index of `config` up with its brain store; never throws. */
export async function catchUpBrainStore(
  config: ResolvedSearchConfig,
  opts: CatchUpOptions = {},
): Promise<CatchUpResult> {
  const store = config.brainStore;
  if (store === null || store === undefined) return { skipped: "no-store", ...NOTHING };
  const state = stateFor(config, store);
  const now = Date.now();
  if (opts.force !== true && now - state.lastCheckMs < catchUpIntervalMs()) {
    return { skipped: "throttled", ...NOTHING };
  }
  state.lastCheckMs = now;
  try {
    const indexIdentity = statShardFile(config.dbPath)?.identity ?? null;
    if (indexIdentity === null) {
      state.known = null;
      return { skipped: "no-index", ...NOTHING };
    }
    if (indexIdentity !== state.indexIdentity) {
      state.known = null;
      state.indexIdentity = indexIdentity;
    }
    const shards = state.scanner.scan();
    if (state.known === null) {
      const peek = peekIndex(config.dbPath, store);
      if (peek === null) return { skipped: "not-current", ...NOTHING };
      state.known = peek.known;
      state.pendingBlobs = peek.pendingBlobs;
    }
    if (!blobMoved(state.pendingBlobs) && unchanged(state.known, shards)) {
      return { skipped: null, ...NOTHING };
    }
    if (isWriterLockHeld(config.dbPath)) return { skipped: "locked", ...NOTHING };
    const index = await Store.open(config, { mode: "write" });
    try {
      const totals = syncShards(index, config, store, shards);
      state.known = knownFrom(readWatermarks(index.brainRecordsConnection()));
      state.pendingBlobs = totals.pendingBlobs;
      return {
        skipped: null,
        shardsRead: totals.shardsRead,
        added: totals.added,
        removed: totals.removed,
        completed: totals.completed,
      };
    } finally {
      await index.close();
    }
  } catch (e) {
    state.known = null;
    if (e instanceof SearchError && e.code === "INDEX_LOCKED")
      return { skipped: "locked", ...NOTHING };
    return { skipped: "failed", ...NOTHING, error: e instanceof Error ? e.message : String(e) };
  }
}
