/**
 * The brain store tables of the index (schema v17, design D5): the
 * per-shard watermarks catch-up resumes from, and one row per ingested
 * store record. Pure SQL over a connection; `brain-store/catch-up.ts`
 * decides what to write and `brain-store/changes.ts` reads the change
 * probe from here.
 */

import { Database } from "bun:sqlite";

import { DOCUMENT_SOURCE_COLUMN, RECORDS_TABLE, STORE_WATERMARKS_TABLE } from "../schema.ts";
import { STORE_RECORD_SEQ_FLOOR_KEY, type DocumentSource } from "../brain-store/constants.ts";
import { nowIso } from "./sql.ts";

/** Where catch-up stopped in one shard, and what the shard looked like then. */
export interface StoreWatermark {
  /** `<partition>/<partition-relative shard path>`. */
  readonly shard: string;
  readonly partition: string;
  /** File identity (`dev:ino`, or a fallback; see `brain-store/shard-scan.ts`). */
  readonly identity: string;
  readonly size: number;
  readonly mtimeMs: number;
  /** First byte not consumed. */
  readonly offset: number;
  /** Hash of samples of the verified prefix (`brain-store/prefix-hash.ts`). */
  readonly prefixHash: string;
  /** Lines skipped for a newer format version, counted over the whole shard. */
  readonly unknownVersions: number;
  /** Middle lines that failed verification, counted over the whole shard. */
  readonly corruptLines: number;
}

/** One ingested record, as the `records` table holds it. */
export interface RecordRow {
  readonly id: string;
  readonly partition: string;
  readonly stream: string;
  readonly ledger: string | null;
  readonly kind: string;
  readonly scope: string | null;
  readonly topic: string | null;
  readonly hlc: string;
  readonly device: string;
  readonly agent: string;
  readonly authority: string | null;
  /** The envelope checksum; also the blob name of a spilled body. */
  readonly sum: string;
  readonly shard: string;
  readonly bodyPending: boolean;
}

/** A stored record with its ingest sequence and indexed document. */
export interface StoredRecord extends RecordRow {
  readonly seq: number;
  readonly documentId: number | null;
}

interface WatermarkSqlRow {
  shard: string;
  partition: string;
  identity: string;
  size: number;
  mtime_ms: number;
  byte_offset: number;
  prefix_hash: string;
  unknown_versions: number;
  corrupt_lines: number;
}

/** Whether `db` carries the v17 store tables (an older index does not). */
export function hasBrainRecordTables(db: Database): boolean {
  return (
    db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(STORE_WATERMARKS_TABLE)!.n === 1
  );
}

/** Every stored watermark, keyed by shard. */
export function readWatermarks(db: Database): Map<string, StoreWatermark> {
  const rows = db
    .query<WatermarkSqlRow, []>(
      "SELECT shard, partition, identity, size, mtime_ms, byte_offset, prefix_hash, " +
        `unknown_versions, corrupt_lines FROM ${STORE_WATERMARKS_TABLE}`,
    )
    .all();
  const out = new Map<string, StoreWatermark>();
  for (const r of rows) {
    out.set(r.shard, {
      shard: r.shard,
      partition: r.partition,
      identity: r.identity,
      size: r.size,
      mtimeMs: r.mtime_ms,
      offset: r.byte_offset,
      prefixHash: r.prefix_hash,
      unknownVersions: r.unknown_versions,
      corruptLines: r.corrupt_lines,
    });
  }
  return out;
}

export function writeWatermark(db: Database, w: StoreWatermark): void {
  db.query(
    `INSERT INTO ${STORE_WATERMARKS_TABLE}(shard, partition, identity, size, mtime_ms, byte_offset, ` +
      "prefix_hash, unknown_versions, corrupt_lines, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(shard) DO UPDATE SET partition = excluded.partition, identity = excluded.identity, " +
      "size = excluded.size, mtime_ms = excluded.mtime_ms, byte_offset = excluded.byte_offset, " +
      "prefix_hash = excluded.prefix_hash, unknown_versions = excluded.unknown_versions, " +
      "corrupt_lines = excluded.corrupt_lines, updated_at = excluded.updated_at",
  ).run(
    w.shard,
    w.partition,
    w.identity,
    w.size,
    w.mtimeMs,
    w.offset,
    w.prefixHash,
    w.unknownVersions,
    w.corruptLines,
    nowIso(),
  );
}

export function deleteWatermark(db: Database, shard: string): void {
  db.query(`DELETE FROM ${STORE_WATERMARKS_TABLE} WHERE shard = ?`).run(shard);
}

interface RecordSqlRow {
  id: string;
  seq: number;
  document_id: number | null;
  partition: string;
  stream: string;
  ledger: string | null;
  kind: string;
  scope: string | null;
  topic: string | null;
  hlc: string;
  device: string;
  agent: string;
  authority: string | null;
  sum: string;
  shard: string;
  body_pending: number;
}

const RECORD_COLUMNS =
  "id, seq, document_id, partition, stream, ledger, kind, scope, topic, hlc, device, agent, " +
  "authority, sum, shard, body_pending";

function toStored(r: RecordSqlRow): StoredRecord {
  return {
    id: r.id,
    seq: r.seq,
    documentId: r.document_id,
    partition: r.partition,
    stream: r.stream,
    ledger: r.ledger,
    kind: r.kind,
    scope: r.scope,
    topic: r.topic,
    hlc: r.hlc,
    device: r.device,
    agent: r.agent,
    authority: r.authority,
    sum: r.sum,
    shard: r.shard,
    bodyPending: r.body_pending === 1,
  };
}

export function getRecord(db: Database, id: string): StoredRecord | null {
  const row = db
    .query<RecordSqlRow, [string]>(`SELECT ${RECORD_COLUMNS} FROM ${RECORDS_TABLE} WHERE id = ?`)
    .get(id);
  return row === null ? null : toStored(row);
}

/**
 * The next ingest sequence: one above both the highest live row and the
 * highest sequence a removed row ever held ({@link deleteRecordRow} keeps
 * that floor), so a sequence is never handed out twice within one index
 * generation and a change-probe watermark never hides a later record.
 */
const NEXT_SEQ_SQL =
  `(SELECT MAX(COALESCE((SELECT MAX(seq) FROM ${RECORDS_TABLE}), 0), ` +
  "COALESCE((SELECT CAST(value AS INTEGER) FROM index_state WHERE key = ?), 0)) + 1)";

/**
 * Insert a record, or refresh the row of one already ingested. An existing
 * row keeps its ingest sequence, so re-reading a shard never makes the
 * change probe report a record twice.
 */
export function upsertRecord(db: Database, row: RecordRow, documentId: number | null): void {
  db.query(
    `INSERT INTO ${RECORDS_TABLE}(id, seq, document_id, partition, stream, ledger, kind, scope, ` +
      "topic, hlc, device, agent, authority, sum, shard, body_pending, indexed_at) " +
      `VALUES (?, ${NEXT_SEQ_SQL}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ` +
      "ON CONFLICT(id) DO UPDATE SET document_id = excluded.document_id, partition = excluded.partition, " +
      "stream = excluded.stream, ledger = excluded.ledger, kind = excluded.kind, scope = excluded.scope, " +
      "topic = excluded.topic, hlc = excluded.hlc, device = excluded.device, agent = excluded.agent, " +
      "authority = excluded.authority, sum = excluded.sum, shard = excluded.shard, " +
      "body_pending = excluded.body_pending, " +
      "indexed_at = excluded.indexed_at",
  ).run(
    row.id,
    STORE_RECORD_SEQ_FLOOR_KEY,
    documentId,
    row.partition,
    row.stream,
    row.ledger,
    row.kind,
    row.scope,
    row.topic,
    row.hlc,
    row.device,
    row.agent,
    row.authority,
    row.sum,
    row.shard,
    row.bodyPending ? 1 : 0,
    nowIso(),
  );
}

/** Ids of the records last read from `shard`. */
export function recordIdsOfShard(db: Database, shard: string): string[] {
  return db
    .query<{ id: string }, [string]>(`SELECT id FROM ${RECORDS_TABLE} WHERE shard = ?`)
    .all(shard)
    .map((r) => r.id);
}

/** Delete a record row, keeping its sequence as the floor the next sequence starts above. */
export function deleteRecordRow(db: Database, id: string): void {
  db.transaction(() => {
    db.query(
      "INSERT INTO index_state(key, value, updated_at) " +
        `SELECT ?, CAST(seq AS TEXT), ? FROM ${RECORDS_TABLE} WHERE id = ? ` +
        "ON CONFLICT(key) DO UPDATE SET value = CAST(MAX(CAST(index_state.value AS INTEGER), " +
        "CAST(excluded.value AS INTEGER)) AS TEXT), updated_at = excluded.updated_at",
    ).run(STORE_RECORD_SEQ_FLOOR_KEY, nowIso(), id);
    db.query(`DELETE FROM ${RECORDS_TABLE} WHERE id = ?`).run(id);
  })();
}

/** Paths of every indexed document that is a brain store record. */
export function storeRecordDocumentPaths(db: Database, prefix: string): string[] {
  return db
    .query<{ path: string }, [number, string]>(
      "SELECT path FROM documents WHERE substr(path, 1, ?) = ?",
    )
    .all(prefix.length, prefix)
    .map((r) => r.path);
}

/**
 * Empty the store tables: every record row and watermark. The highest
 * sequence is kept as the floor, as {@link deleteRecordRow} keeps it, so
 * records ingested later are still new after any watermark handed out.
 */
export function clearStoreTables(db: Database): void {
  db.transaction(() => {
    db.query(
      "INSERT INTO index_state(key, value, updated_at) " +
        `SELECT ?, CAST(MAX(seq) AS TEXT), ? FROM ${RECORDS_TABLE} WHERE true HAVING MAX(seq) IS NOT NULL ` +
        "ON CONFLICT(key) DO UPDATE SET value = CAST(MAX(CAST(index_state.value AS INTEGER), " +
        "CAST(excluded.value AS INTEGER)) AS TEXT), updated_at = excluded.updated_at",
    ).run(STORE_RECORD_SEQ_FLOOR_KEY, nowIso());
    db.query(`DELETE FROM ${RECORDS_TABLE}`).run();
    db.query(`DELETE FROM ${STORE_WATERMARKS_TABLE}`).run();
  })();
}

/** Whether any store record or watermark is held. */
export function holdsStoreRows(db: Database): boolean {
  return (
    db
      .query<{ n: number }, []>(
        `SELECT EXISTS(SELECT 1 FROM ${RECORDS_TABLE}) OR EXISTS(SELECT 1 FROM ${STORE_WATERMARKS_TABLE}) AS n`,
      )
      .get()!.n === 1
  );
}

/** Records whose body was a blob that had not arrived yet. */
export function pendingRecords(db: Database): StoredRecord[] {
  return db
    .query<RecordSqlRow, []>(
      `SELECT ${RECORD_COLUMNS} FROM ${RECORDS_TABLE} WHERE body_pending = 1 ORDER BY seq`,
    )
    .all()
    .map(toStored);
}

/** Records ingested after sequence `since`, oldest first, at most `limit`. */
export function recordsAfter(db: Database, since: number, limit: number): StoredRecord[] {
  return db
    .query<RecordSqlRow, [number, number]>(
      `SELECT ${RECORD_COLUMNS} FROM ${RECORDS_TABLE} WHERE seq > ? ORDER BY seq LIMIT ?`,
    )
    .all(since, limit)
    .map(toStored);
}

/** The source of each of `documentIds` that is indexed. */
export function documentSources(
  db: Database,
  documentIds: ReadonlyArray<number>,
): Map<number, DocumentSource> {
  const out = new Map<number, DocumentSource>();
  if (documentIds.length === 0) return out;
  // One statement for the whole candidate pool, not one per document.
  const rows = db
    .query<{ id: number; source: DocumentSource }, [string]>(
      `SELECT id, ${DOCUMENT_SOURCE_COLUMN} AS source FROM documents ` +
        "WHERE id IN (SELECT value FROM json_each(?))",
    )
    .all(JSON.stringify([...new Set(documentIds)]));
  for (const row of rows) out.set(row.id, row.source);
  return out;
}

/** Whether the index holds any record of `kind` (one indexed row is enough). */
export function holdsRecordKind(db: Database, kind: string): boolean {
  return (
    db
      .query<{ n: number }, [string]>(
        `SELECT EXISTS(SELECT 1 FROM ${RECORDS_TABLE} WHERE kind = ?) AS n`,
      )
      .get(kind)!.n === 1
  );
}
