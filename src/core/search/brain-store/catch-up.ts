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

import { accessSync, constants as fsConstants, lstatSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";

import { Database } from "bun:sqlite";

import { readDeviceId } from "../../config.ts";
import { closeDatabase } from "../../sqlite-close.ts";
import { observeClock } from "../../store/clock-store.ts";
import { compareHlc, parseHlc } from "../../store/hlc.ts";
import { readBlobBody, scanShard, type ShardScan } from "../../store/reader.ts";
import { isReadableDeviceDir, isShardFileName } from "../../store/shard-list.ts";
import { quarantineStamp } from "../../store/shard-quarantine.ts";
import { blobPath, blobStamp, partitionDir } from "../../store/store-paths.ts";
import { SIGNAL_KIND, type StorePartition } from "../../store/constants.ts";
import { SIGNAL_STATE_KIND } from "../../store/fold-signals.ts";
import { LANE_ENTRY_KIND } from "../../store/lane-records.ts";
import { TOMBSTONE_KINDS } from "../../store/removal-backlog.ts";
import { isBlobRef, type StoreRecord } from "../../store/envelope.ts";
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
import {
  isWriterLockHeld,
  keepWriterLeasesFresh,
  WRITER_LEASE_BLOCKING_BUDGET_MS,
  writerLeaseCheckIn,
} from "../store/writer-lock.ts";
import { SearchError, type ResolvedSearchConfig } from "../types.ts";
import {
  STORE_CATCH_UP_INTERVAL_ENV,
  STORE_CATCH_UP_INTERVAL_MS,
  STORE_FOLD_CLEANUP_KEY,
  STORE_LIFECYCLE_MARKS_KEY,
} from "./constants.ts";
import {
  carriesLifecycleMark,
  forgetting,
  type ForgottenRefs,
  isForgettingFoldInput,
  isForgettingFoldKind,
} from "./forgotten.ts";
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
  /** The partitions the scanner lists: a machine that leaves one gets a new state. */
  readonly partitions: string;
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
  /** The index owes a forgetting fold an earlier pass did not finish (`STORE_FOLD_CLEANUP_KEY`). */
  cleanupOwed: boolean;
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
  const partitions = store.partitions.join(",");
  if (
    existing !== undefined &&
    existing.storeRoot === store.root &&
    existing.partitions === partitions
  ) {
    return existing;
  }
  const fresh: ProcessState = {
    scanner: new ShardScanner(store),
    storeRoot: store.root,
    partitions,
    lastCheckMs: Number.NEGATIVE_INFINITY,
    indexIdentity: null,
    known: null,
    pendingBlobs: new Map(),
    cleanupOwed: false,
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
): {
  known: Map<string, FileStat>;
  pendingBlobs: Map<string, FileStat | null>;
  cleanupOwed: boolean;
} | null {
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
    const owed =
      db
        .query<{ value: string }, [string]>("SELECT value FROM index_state WHERE key = ?")
        .get(STORE_FOLD_CLEANUP_KEY)?.value === "1";
    return { known: knownFrom(readWatermarks(db)), pendingBlobs, cleanupOwed: owed };
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
  /**
   * Records read this pass that set or clear an entity's lifecycle status
   * (`_status: tombstoned` and its undoing, `forgotten.ts`), skipped ones
   * included.
   */
  lifecycleMarks: number;
  added: number;
  /** Records read this pass (added, refreshed or already indexed) of a kind a tombstone can void (a signal, a preference, a lane entry). */
  voidableRead: number;
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
  /** The pass's progress callback, called after each record read. */
  readonly progress?: ShardProgress;
  /**
   * Record ids this pass must not index: a rebuild's ids its store's
   * tombstones already voided ({@link ingestStoreInto}).
   */
  readonly skip?: ReadonlySet<string>;
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
  const seen = new Set<string>();
  // Read record by record (a shard read from its start can hold every
  // record the store has, and none is kept past its ingest), and ingested
  // in batches of one transaction each: a commit per record synced the
  // index once per record, minutes for a migrated store.
  const batch = new IngestBatch(db);
  let read: ShardScan;
  try {
    read = scanShard(
      shard.path,
      { offset: from, partitionRoot: partitionDir(store.root, shard.partition) },
      (r) => {
        // The writer lock this pass runs under beats as it goes.
        writerLeaseCheckIn();
        if (carriesLifecycleMark(r.record)) totals.lifecycleMarks++;
        if (totals.skip?.has(r.record.id) === true) {
          totals.progress?.(shard, r.offset + r.length, totals.added);
          return;
        }
        batch.tick();
        const outcome = ingestRecord(index, config, r.record, shard, r.bodyState === "pending");
        // A copy refused for sitting in the other partition does not hold
        // the record: it must not keep an orphaned row alive.
        if (outcome === "refused") return;
        if (TOMBSTONE_KINDS.has(r.record.kind)) totals.tombstones++;
        seen.add(r.record.id);
        orphans.delete(r.record.id);
        if (outcome === "added") totals.added++;
        // Counted whatever the outcome: a record a read that failed later
        // already committed reads as unchanged on the retry, and the
        // tombstone cleanup it needs must still run then.
        if (isVoidableKind(r.record.kind)) totals.voidableRead++;
        if (r.record.device !== device) {
          const hlc = parseHlc(r.record.hlc);
          const best = totals.remoteHlc === null ? null : parseHlc(totals.remoteHlc);
          if (hlc !== null && (best === null || compareHlc(hlc, best) > 0))
            totals.remoteHlc = r.record.hlc;
        }
        totals.progress?.(shard, r.offset + r.length, totals.added);
      },
    );
    batch.end();
  } catch (e) {
    batch.abandon();
    throw e;
  }
  totals.shardsRead++;
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

/** Records ingested per transaction of a catch-up. */
const INGEST_BATCH_RECORDS = 500;

/**
 * The transactions a shard's ingest runs in: one per
 * {@link INGEST_BATCH_RECORDS} records. A batch that fails is rolled back
 * whole; its shard's watermark has not moved, so the next pass reads those
 * records again (ingest is idempotent by record id). Inside a transaction
 * the caller holds already, it opens none.
 */
class IngestBatch {
  private open = false;
  private count = 0;
  private readonly owned: boolean;

  constructor(private readonly db: Database) {
    this.owned = !db.inTransaction;
  }

  /** Before each record: open the batch, or commit a full one and open the next. */
  tick(): void {
    if (!this.owned) return;
    if (this.open && this.count >= INGEST_BATCH_RECORDS) {
      this.db.exec("COMMIT");
      this.open = false;
    }
    if (!this.open) {
      this.db.exec("BEGIN");
      this.open = true;
      this.count = 0;
    }
    this.count += 1;
  }

  end(): void {
    if (this.open) this.db.exec("COMMIT");
    this.open = false;
  }

  abandon(): void {
    if (this.open && this.db.inTransaction) this.db.exec("ROLLBACK");
    this.open = false;
  }
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
 * The body fields the forgetting folds read (`forgotten.ts`): a signal's
 * capture and state moves, a preference's sets, evidence and removal, a
 * lane entry's content and removal. A lane entry's text is kept as an
 * empty string (its fold only checks it is one).
 */
const FOLD_BODY_FIELDS = [
  "authority",
  "id",
  // A signal's page path: a forgotten signal's events are found by it too.
  "path",
  "staged",
  "frontmatter",
  "signal",
  "state",
  "fields",
  "preference",
  "result",
  "lane",
  "entry",
  "text",
] as const;

/**
 * `record` with only the body fields the folds read: the pass holds every
 * fold record of the store at once, and a signal's raw text or a lane
 * entry's page body is most of its size.
 */
function slimForFold(record: StoreRecord): StoreRecord {
  // A body still a blob reference is kept whole: the folds set it aside as pending.
  if (isBlobRef(record.body)) return record;
  const body: Record<string, unknown> = {};
  for (const field of FOLD_BODY_FIELDS) {
    if (!(field in record.body)) continue;
    const value = record.body[field];
    body[field] = field === "text" && typeof value === "string" ? "" : value;
  }
  return { ...record, body };
}

/** A record of a fold the forgetting reads, by id, with the shard it was read from. */
interface PlacedRecord {
  readonly id: string;
  readonly shard: ShardStat;
  /** Its body is a blob that has not arrived: the folds set it aside. */
  readonly pending: boolean;
}

/** What {@link forgottenInShards} read. */
interface ForgettingRead {
  /** Ids of the records the index must not hold. */
  readonly ids: ReadonlySet<string>;
  /** How log events reference the forgotten entities (`forgotten.ts`, `Forgetting.refs`). */
  readonly refs: ForgottenRefs;
  readonly records: ReadonlyArray<PlacedRecord>;
  /**
   * False when a shard left a gap the folds cannot see past: it could not
   * be opened or read at all (permissions, a sharing violation), it was
   * not a regular file when opened (a link or special file replaced it),
   * or it holds a corrupt line that is neither torn nor quarantined. A
   * tombstone, mark or approval may sit in the gap. Judged only by
   * {@link foldComplete}.
   */
  readonly complete: boolean;
  /**
   * `<partition root>\0<sha>` of the blob of every fold record whose body
   * is a blob, arrived (`blob`) or not (`pending`): each is an input of
   * the fold, as present or as absent.
   */
  readonly spilledBlobs: ReadonlyArray<{ readonly key: string; readonly pending: boolean }>;
}

/**
 * The records of the `events` shards among `shards` that the forgetting
 * folds read (`forgotten.ts`), each with its shard, and the ids of those
 * the index must not hold. Read record by record, keeping only what the
 * folds read: the `events` stream also holds every other kind of the
 * store's history. Never throws for a shard it cannot read: that shard is
 * a gap ({@link ForgettingRead.complete}).
 */
function forgottenInShards(store: IndexedStore, shards: ReadonlyArray<ShardStat>): ForgettingRead {
  const slim: StoreRecord[] = [];
  const records: PlacedRecord[] = [];
  const spilledBlobs: Array<{ key: string; pending: boolean }> = [];
  let complete = true;
  for (const shard of shards) {
    if (shard.stream !== "events") continue;
    const partitionRoot = partitionDir(store.root, shard.partition);
    let read: ShardScan;
    try {
      read = scanShard(shard.path, { partitionRoot }, (r) => {
        if (!isForgettingFoldInput(r.record)) return;
        const pending = r.bodyState === "pending";
        slim.push(slimForFold(r.record));
        records.push({ id: r.record.id, shard, pending });
        if (r.bodyState !== "inline") {
          spilledBlobs.push({ key: `${partitionRoot}\0${r.record.sum}`, pending });
        }
      });
    } catch {
      complete = false;
      continue;
    }
    if (
      read.diagnostics.some(
        (d) =>
          d.kind === "not-a-file" ||
          (d.kind === "corrupt-line" && d.torn !== true && d.quarantined !== true),
      )
    ) {
      complete = false;
    }
  }
  const { ids, refs } = forgetting(slim);
  return { ids, refs, records, complete, spilledBlobs };
}

/**
 * The one decision every writer of the forgetting fold goes through:
 * whether a fold read may drive the index. Removals, revivals and the
 * clearing of the owed-fold flag (`STORE_FOLD_CLEANUP_KEY`) happen only
 * after a complete read; an incomplete one writes nothing and leaves the
 * fold owed, so a later catch-up retries it once the gap is gone. Search
 * fails closed meanwhile (`storeRecordVisibility` answers null for the
 * same read).
 */
function foldComplete(read: ForgettingRead): boolean {
  return read.complete;
}

/** Record that the index owes a forgetting fold (`STORE_FOLD_CLEANUP_KEY`). */
function oweFold(index: Store): void {
  if (index.getState(STORE_FOLD_CLEANUP_KEY) !== "1") index.setState(STORE_FOLD_CLEANUP_KEY, "1");
}

/** The owed fold is paid: cleared only by a fold whose read was complete. */
function settleFold(index: Store, outcome: FoldOutcome): void {
  if (outcome.complete) index.deleteState(STORE_FOLD_CLEANUP_KEY);
}

/** Whether an `events` shard name of a held partition is no regular file. */
function eventsShardNotRegular(store: IndexedStore): boolean {
  // Read straight from the directory entries, never opening one: the
  // shard listing admits only regular files and links, and the scanner
  // only regular files, so a shard-named FIFO, socket, device or folder,
  // and a device folder that is a link or a file, are in no listing.
  for (const partition of store.partitions) {
    const streamDir = join(partitionDir(store.root, partition), "events");
    const st = lstatSync(streamDir, { throwIfNoEntry: false });
    if (st === undefined) continue;
    if (!st.isDirectory()) return true;
    for (const device of readdirSync(streamDir, { withFileTypes: true })) {
      if (!isReadableDeviceDir(device.name)) continue;
      if (!device.isDirectory()) return true;
      for (const file of readdirSync(join(streamDir, device.name), { withFileTypes: true })) {
        if (isShardFileName(file.name) && !file.isFile()) return true;
      }
    }
  }
  return false;
}

/** The availability stamp of each blob `blobs` names (`blobStamp`: `absent` when it is not there). */
function blobStamps(blobs: ReadonlyArray<string>): string[] {
  return blobs.map((key) => {
    const [root, sha] = key.split("\0") as [string, string];
    return blobStamp(root, sha);
  });
}

/** What one fold did to the index, written only after a complete read. */
interface FoldOutcome {
  readonly complete: boolean;
  readonly removed: number;
  readonly added: number;
  /** Blob paths of the records revived with their body still pending. */
  readonly pendingBlobs: ReadonlyArray<string>;
}

/**
 * Take out of `index` every record its store's entity readers no longer
 * show (`forgotten.ts`: a forgotten signal, a removed preference or lane
 * entry, an entity marked tombstoned, a staged signal), over all `events`
 * shards. With `revive`, a record of those folds that is not forgotten
 * and that the index does not hold (an entity whose mark was undone since
 * it left) is read again from its shard and indexed. Writes nothing and
 * owes the fold when the read is incomplete ({@link foldComplete}).
 */
function dropForgotten(
  index: Store,
  config: ResolvedSearchConfig,
  store: IndexedStore,
  shards: ReadonlyArray<ShardStat>,
  revive: boolean,
): FoldOutcome {
  const read = forgottenInShards(store, shards);
  if (!foldComplete(read)) {
    oweFold(index);
    return { complete: false, removed: 0, added: 0, pendingBlobs: [] };
  }
  const { ids, records } = read;
  const db = index.brainRecordsConnection();
  const revivedPending: string[] = [];
  let removed = 0;
  for (const id of ids) {
    const row = getRecord(db, id);
    if (row === null) continue;
    removeRecord(index, row);
    removed++;
  }
  let added = 0;
  if (!revive) return { complete: true, removed, added, pendingBlobs: revivedPending };
  const wanted = new Map<ShardStat, Set<string>>();
  for (const placed of records) {
    if (ids.has(placed.id) || getRecord(db, placed.id) !== null) continue;
    let set = wanted.get(placed.shard);
    if (set === undefined) wanted.set(placed.shard, (set = new Set()));
    set.add(placed.id);
  }
  const batch = new IngestBatch(db);
  try {
    for (const [shard, set] of wanted) {
      scanShard(shard.path, { partitionRoot: partitionDir(store.root, shard.partition) }, (r) => {
        if (!set.has(r.record.id)) return;
        set.delete(r.record.id);
        writerLeaseCheckIn();
        batch.tick();
        const pending = r.bodyState === "pending";
        const outcome = ingestRecord(index, config, r.record, shard, pending);
        if (outcome === "added") added++;
        if (pending)
          revivedPending.push(blobPath(partitionDir(store.root, shard.partition), r.record.sum));
      });
    }
    batch.end();
  } catch (e) {
    batch.abandon();
    throw e;
  }
  return { complete: true, removed, added, pendingBlobs: revivedPending };
}

/**
 * What a search may show of the store's fold records (`entity-filter.ts`),
 * by the same rule the ingest applies: `hidden` are the ids the index must
 * not hold (`forgotten.ts`), `known` the ids of every fold record read
 * whole. A fold record that is not known (a body still pending, a record
 * of a shard written since) is not shown either.
 */
export interface StoreVisibility {
  readonly hidden: ReadonlySet<string>;
  readonly known: ReadonlySet<string>;
  /** How log events reference the forgotten entities: one that does is not shown (`forgotten.ts`). */
  readonly hiddenRefs: ForgottenRefs;
}

/**
 * The last visibility read per store root, with every input of the cold
 * read it came from ({@link visibilityInputs}).
 *
 * THE INVARIANT: a cached visibility answer is served only if a cold read
 * now would give the same answer or fail closed. A cold read
 * ({@link forgottenInShards}) depends on exactly these inputs, and the
 * cache key covers each one:
 *
 *  1. which partitions this machine holds, and the shard quarantine
 *     ledger (a quarantined line reads differently);
 *  2. the set of `events` shard names, regular or not (a name that is no
 *     regular file is a gap: no cache, no answer);
 *  3. each listed shard's identity, size and mtime (its bytes);
 *  4. each listed shard's readability (a shard that cannot be opened now
 *     is a gap even with its stat unchanged);
 *  5. every blob that supplies a fold input, present or absent: the body
 *     of a spilled record is read from it, and one that appears or goes
 *     changes what the folds see.
 *
 * Inputs 2 to 5 are checked on every hit; inputs 1 and 3 form the stamp.
 * A read is cached only when the blob stamps taken right after it still
 * describe what it read (every pending blob still absent, every arrived
 * one still present), so a blob that moved during the read never vouches
 * for it. Cost: the check is one directory listing per device folder, one
 * stat and one access check per shard and two `lstat`s per spilled fold
 * blob, against a full read of every `events` shard for a cold read.
 */
const visibilityCache = new Map<
  string,
  {
    readonly stamp: string;
    readonly blobs: ReadonlyArray<string>;
    readonly blobsStamp: string;
    readonly value: StoreVisibility;
  }
>();

/** Inputs 1 and 3 of the cold read ({@link visibilityCache}), as one stamp. */
function visibilityInputs(store: IndexedStore, shards: ReadonlyArray<ShardStat>): string {
  return [
    store.partitions.join(","),
    `quarantine=${quarantineStamp(store.root)}`,
    ...shards.map((s) => `${s.key}:${s.identity}:${s.size}:${s.mtimeMs}`),
  ].join("\n");
}

/** Input 4: whether every shard of `paths` can be opened for reading now. */
function shardsReadable(paths: ReadonlyArray<string>): boolean {
  for (const path of paths) {
    try {
      accessSync(path, fsConstants.R_OK);
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * The {@link StoreVisibility} of `store`, from the cache only under its
 * invariant ({@link visibilityCache}); null when a shard cannot be listed
 * or read, or one is no regular file (the caller then shows no fold
 * record: fail closed).
 */
export function storeRecordVisibility(store: IndexedStore): StoreVisibility | null {
  try {
    // Input 2: a shard-named entry that is no regular file is in no
    // listing of the scanner, and a tombstone, mark or approval may sit
    // in it: no answer, cached or not.
    if (eventsShardNotRegular(store)) {
      visibilityCache.delete(store.root);
      return null;
    }
    const shards = new ShardScanner(store).scan().filter((s) => s.stream === "events");
    const stamp = visibilityInputs(store, shards);
    const shardPaths = shards.map((s) => s.path);
    // Input 4, before any answer: a cold read of an unreadable shard
    // fails closed, so the cache must not answer either.
    if (!shardsReadable(shardPaths)) {
      visibilityCache.delete(store.root);
      return null;
    }
    const cached = visibilityCache.get(store.root);
    if (
      cached !== undefined &&
      cached.stamp === stamp &&
      blobStamps(cached.blobs).join("\n") === cached.blobsStamp
    ) {
      return cached.value;
    }
    const read = forgottenInShards(store, shards);
    // A gap in a shard may hide the record that hides another: no answer.
    if (!foldComplete(read)) {
      visibilityCache.delete(store.root);
      return null;
    }
    const value: StoreVisibility = {
      hidden: read.ids,
      hiddenRefs: read.refs,
      known: new Set(read.records.filter((p) => !p.pending).map((p) => p.id)),
    };
    // Input 5, stamped right after the read. It vouches for the read only
    // when it still says what the read saw: each pending blob absent, each
    // arrived one present; otherwise the answer is served but not kept.
    const blobKeys = read.spilledBlobs.map((b) => b.key);
    const blobs = blobStamps(blobKeys);
    const consistent = read.spilledBlobs.every((b, i) =>
      b.pending ? blobs[i] === "absent" : blobs[i] !== "absent",
    );
    if (consistent && visibilityInputs(store, shards) === stamp) {
      visibilityCache.set(store.root, {
        stamp,
        blobs: blobKeys,
        blobsStamp: blobs.join("\n"),
        value,
      });
    } else {
      visibilityCache.delete(store.root);
    }
    return value;
  } catch {
    visibilityCache.delete(store.root);
    return null;
  }
}

/**
 * Take out of `index`, open for writing, every record its store's entity
 * readers no longer show: for a staging index a rebuild resumes, which an
 * earlier run built before records it holds may have been forgotten.
 * Returns how many rows left the index; 0 without a store.
 */
export function dropForgottenRecords(index: Store, config: ResolvedSearchConfig): number {
  const store = config.brainStore;
  if (store === null || store === undefined) return 0;
  const { removed } = keepWriterLeasesFresh(WRITER_LEASE_BLOCKING_BUDGET_MS, () =>
    dropForgotten(index, config, store, new ShardScanner(store).scan(), false),
  );
  if (removed > 0) index.bumpIndexRevision();
  return removed;
}

/**
 * Bring `index` level with the shards in `shards`; returns what changed.
 *
 * A shard read from its start is one synchronous read of the whole file,
 * which a check-in cannot interrupt, so the pass runs with the writer lock
 * it holds kept fresh off this thread; the check-ins below cover the rest.
 */
function syncShards(
  index: Store,
  config: ResolvedSearchConfig,
  store: IndexedStore,
  shards: ReadonlyArray<ShardStat>,
  onShard?: ShardProgress,
  skip?: ReadonlySet<string>,
): SyncTotals {
  return keepWriterLeasesFresh(WRITER_LEASE_BLOCKING_BUDGET_MS, () =>
    syncShardsInPass(index, config, store, shards, onShard, skip),
  );
}

/**
 * Progress of a pass: called after each record and at the end of each
 * shard with the bytes of that shard read so far and the records added.
 */
type ShardProgress = (shard: ShardStat, bytesRead: number, added: number) => void;

function syncShardsInPass(
  index: Store,
  config: ResolvedSearchConfig,
  store: IndexedStore,
  shards: ReadonlyArray<ShardStat>,
  onShard?: ShardProgress,
  skip?: ReadonlySet<string>,
): SyncTotals {
  const db = index.brainRecordsConnection();
  const marks = readWatermarks(db);
  const device = readDeviceId(config.configPath);
  const totals: SyncTotals = {
    shardsRead: 0,
    tombstones: 0,
    lifecycleMarks: 0,
    added: 0,
    voidableRead: 0,
    removed: 0,
    completed: 0,
    remoteHlc: null,
    pendingBlobs: new Map(),
    ...(onShard !== undefined ? { progress: onShard } : {}),
    ...(skip !== undefined ? { skip } : {}),
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
      writerLeaseCheckIn();
      present.add(shard.key);
      const mark = marks.get(shard.key);
      if (mark !== undefined && sameStat(mark, shard)) continue;
      const read = readOneShard(index, config, store, shard, mark, totals, device, orphans);
      if (read.fromStart) {
        readInFull.add(shard.key);
        if (shard.stream === "events") eventsReadInFull.add(shard.key);
      }
      next.push(read.watermark);
      onShard?.(shard, shard.size, totals.added);
    }
    const vanished = [...marks.keys()].filter((key) => !present.has(key));
    for (const key of vanished) {
      for (const id of recordIdsOfShard(db, key)) if (!orphans.has(id)) orphans.set(id, key);
    }
    writerLeaseCheckIn();
    const settled = settleOrphans(index, config, store, shards, orphans, readInFull);
    writerLeaseCheckIn();
    totals.removed += settled.removed;
    // A forgotten signal leaves the index with its tombstone (FORMAT.md,
    // "Removal"), and an entity marked tombstoned with its mark
    // (`forgotten.ts`): after a pass that read either, that re-read an
    // events shard from its start, or that added a record a known
    // tombstone or mark may void (a line from before it that synced in
    // late, appended to a shard already read), every record the entity
    // readers no longer show is taken out. A pass that read a mark also
    // brings back what a mark undone since had taken out.
    // A fold read of this pass that met a gap: the fold is owed, and the
    // rest of the pass does not read the same gap again.
    let foldGapThisPass = false;
    const marked = totals.lifecycleMarks > 0;
    if (marked && index.getState(STORE_LIFECYCLE_MARKS_KEY) !== "1") {
      index.setState(STORE_LIFECYCLE_MARKS_KEY, "1");
    }
    if (
      totals.tombstones > 0 ||
      marked ||
      ((eventsReadInFull.size > 0 || totals.voidableRead > 0) &&
        ([...TOMBSTONE_KINDS].some((kind) => holdsRecordKind(db, kind)) ||
          index.getState(STORE_LIFECYCLE_MARKS_KEY) === "1"))
    ) {
      // Once the index has met a mark, every pass that folds again also
      // brings back what a mark undone since had taken out (a preference
      // whose status moved off `tombstoned` carries no mark of its own).
      const revive = marked || index.getState(STORE_LIFECYCLE_MARKS_KEY) === "1";
      const forgotten = dropForgotten(index, config, store, shards, revive);
      totals.removed += forgotten.removed;
      totals.added += forgotten.added;
      if (!forgotten.complete) foldGapThisPass = true;
    }
    // Watermarks move only once the orphans are settled: a pass that
    // stops before that reads the same shards again next time, and a
    // shard whose orphans could not be settled keeps its old watermark
    // (a vanished one keeps its row), so the next pass meets them again.
    for (const w of next) if (!settled.retry.has(w.shard)) writeWatermark(db, w);
    for (const key of vanished) if (!settled.retry.has(key)) deleteWatermark(db, key);
    let foldBodiesCompleted = 0;
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
      // Owed before the body lands: a fold that then throws is retried
      // by the next catch-up, which would otherwise find nothing pending
      // and every shard level, and return at once.
      if (isForgettingFoldKind(pending.kind)) oweFold(index);
      completePendingRecord(index, config, pending, blob.body);
      totals.completed++;
      if (isForgettingFoldKind(pending.kind)) foldBodiesCompleted++;
    }
    // A fold record whose body was pending (a signal-state with tombstone
    // fields, a staged capture) was set aside by every fold so far: now
    // that it is whole the folds run again, taking out what it forgets and
    // bringing back what it clears.
    if (
      !foldGapThisPass &&
      (foldBodiesCompleted > 0 || index.getState(STORE_FOLD_CLEANUP_KEY) === "1")
    ) {
      if (index.getState(STORE_LIFECYCLE_MARKS_KEY) !== "1") {
        index.setState(STORE_LIFECYCLE_MARKS_KEY, "1");
      }
      const forgotten = dropForgotten(index, config, store, shards, true);
      totals.removed += forgotten.removed;
      totals.added += forgotten.added;
      // A record this fold brought back with its body still pending is
      // watched like every other pending body, so its blob's arrival
      // triggers the next pass (the loop above ran before it existed).
      // Watched as not looked at (`null`), never with a stat taken now: a
      // blob that arrived after the revival read it as pending would
      // otherwise read as already seen, and the record would stay pending.
      for (const path of forgotten.pendingBlobs) totals.pendingBlobs.set(path, null);
      settleFold(index, forgotten);
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
export function ingestStoreInto(
  index: Store,
  config: ResolvedSearchConfig,
  onProgress?: (bytesDone: number, bytesTotal: number, records: number) => void,
): void {
  const store = config.brainStore;
  if (store === null || store === undefined) return;
  const shards = buildOrder(new ShardScanner(store).scan());
  const bytesTotal = shards.reduce((sum, s) => sum + s.size, 0);
  // A search can read the staging index while it is built, so a record
  // the store has already forgotten (a removed signal, preference or lane
  // entry, an entity marked tombstoned) is never written into it: the
  // forgetting folds run before the first document. One forgotten while
  // the build runs is taken out at the end of the pass, as a catch-up
  // takes it out of a live index.
  const preScan = keepWriterLeasesFresh(WRITER_LEASE_BLOCKING_BUDGET_MS, () =>
    forgottenInShards(store, shards),
  );
  // A pre-scan with a gap skips what it could read, and the fold is owed:
  // the index the build makes carries that debt until a complete read.
  if (!foldComplete(preScan)) oweFold(index);
  const voided = preScan.ids;
  // The shards finished before the current one, and the current one.
  let finished = 0;
  let current: ShardStat | null = null;
  syncShards(
    index,
    config,
    store,
    shards,
    (shard, bytesRead, added) => {
      if (shard !== current) {
        if (current !== null) finished += current.size;
        current = shard;
      }
      onProgress?.(finished + Math.min(bytesRead, shard.size), bytesTotal, added);
    },
    voided,
  );
}

/** Shards of the `log` stream go last in a rebuild ({@link buildOrder}). */
function buildRank(shard: ShardStat): number {
  return shard.stream === "log" ? 1 : 0;
}

/** `private` shards go first in a rebuild ({@link buildOrder}). */
function partitionRank(shard: ShardStat): number {
  return shard.partition === "private" ? 0 : 1;
}

/**
 * The order a rebuild ingests shards in. A search can answer from the
 * staging index while it is built, so what recall needs most goes first:
 * every stream but `log` (signals, preferences, decisions, topics), then
 * the log, newest month first.
 *
 * The first copy of a record id indexed wins (`ingestRecord` refuses a
 * copy from the other partition), so every `private` shard goes before
 * every `shared` one: an id found in both (an anomaly doctor reports; the
 * two copies are one envelope, so only the partition and with it the
 * visibility differ) is indexed from its private copy, as every catch-up
 * does (it reads the shards in key order, `private/` first) and as every
 * rebuild did before this order. Within one partition a record id has one
 * text (records are immutable), so the order there changes nothing in the
 * finished index.
 */
function buildOrder(shards: ReadonlyArray<ShardStat>): ShardStat[] {
  return shards.toSorted(
    (a, b) =>
      partitionRank(a) - partitionRank(b) ||
      buildRank(a) - buildRank(b) ||
      posix.basename(b.rel).localeCompare(posix.basename(a.rel)) ||
      a.key.localeCompare(b.key),
  );
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
      state.cleanupOwed = peek.cleanupOwed;
    }
    // A forgetting fold an earlier pass owed and did not finish is run
    // before any early return.
    if (!state.cleanupOwed && !blobMoved(state.pendingBlobs) && unchanged(state.known, shards)) {
      return { skipped: null, ...NOTHING };
    }
    if (isWriterLockHeld(config.dbPath)) return { skipped: "locked", ...NOTHING };
    const index = await Store.open(config, { mode: "write" });
    try {
      const totals = syncShards(index, config, store, shards);
      state.known = knownFrom(readWatermarks(index.brainRecordsConnection()));
      state.pendingBlobs = totals.pendingBlobs;
      state.cleanupOwed = index.getState(STORE_FOLD_CLEANUP_KEY) === "1";
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
