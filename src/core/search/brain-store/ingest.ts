/**
 * Write one brain store record into the index, or take one out (design
 * D5): the `records` row, and for a searchable stream the document and
 * chunks its text is searched through.
 *
 * Idempotent by record id. Records are immutable (their id names one
 * envelope and its checksum), so a record already indexed with its body
 * only has its shard attribution refreshed on a re-read; it is re-chunked
 * only when its body was a pending blob that has since arrived.
 */

import { posix } from "node:path";

import { REMOTE_DENY_VISIBILITY_TOKEN } from "../../graph/visibility.ts";
import { sha256Hex } from "../../integrity/digest.ts";
import { STORE_FORMAT_VERSION } from "../../store/constants.ts";
import type { StoreRecord } from "../../store/envelope.ts";
import { chunkMarkdown } from "../chunker.ts";
import { expandTextForCjkFts } from "../cjk-tokenizer.ts";
import { extractEntities } from "../entities.ts";
import type { Store } from "../store.ts";
import {
  clearStoreTables,
  deleteRecordRow,
  getRecord,
  holdsStoreRows,
  storeRecordDocumentPaths,
  upsertRecord,
  type RecordRow,
  type StoredRecord,
} from "../store/brain-records.ts";
import type { ChunkInput } from "../store/chunks.ts";
import type { ResolvedSearchConfig } from "../types.ts";
import { SEARCHABLE_STORE_STREAMS, STORE_RECORD_PATH_PREFIX } from "./constants.ts";
import { renderRecordText } from "./record-text.ts";
import type { ShardStat } from "./shard-scan.ts";

/** The `documents.path` a store record's text is indexed under. */
export function storeRecordPath(partition: string, id: string): string {
  return posix.join(STORE_RECORD_PATH_PREFIX, partition, id);
}

function authorityOf(record: StoreRecord): string | null {
  const value = record.body["authority"];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function physicalSeconds(hlc: string): number {
  const ms = Number(hlc.split(".")[0]);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

/** Where a record was read from: the parts of a {@link ShardStat} ingest needs. */
export type RecordPlace = Pick<ShardStat, "key" | "partition" | "stream" | "ledger">;

/**
 * What {@link ingestRecord} did. `refused`: the id is already indexed
 * from the other partition. Records never move between partitions, so the
 * second copy is not indexed (it could otherwise relabel or shadow the
 * first); doctor reports such ids.
 */
export type IngestOutcome = "added" | "refreshed" | "unchanged" | "refused";

function indexText(
  store: Store,
  config: ResolvedSearchConfig,
  record: StoreRecord,
  shard: RecordPlace,
  pending: boolean,
): number {
  const { title, content } = renderRecordText(record, shard.stream, pending);
  const docId = store.upsertDocument({
    path: storeRecordPath(shard.partition, record.id),
    title,
    contentHash: sha256Hex(content),
    mtime: physicalSeconds(record.hlc),
    size: Buffer.byteLength(content),
    pageType: null,
    eventAnchor: null,
    // A private-partition record is reserved exactly like a page that
    // declares `visibility: private`.
    visibility: shard.partition === "private" ? [REMOTE_DENY_VISIBILITY_TOKEN] : [],
    pinned: false,
  });
  const chunked = chunkMarkdown(content, title, {
    maxTokens: config.chunkSize,
    minTokens: config.chunkMinSize,
    overlapTokens: config.chunkOverlap,
  });
  const inputs: ChunkInput[] = chunked.chunks.map((c) => ({
    chunkIndex: c.chunkIndex,
    content: c.content,
    ftsContent: expandTextForCjkFts(c.content),
    contentHash: sha256Hex(c.content),
    startLine: c.startLine,
    endLine: c.endLine,
    tokenCount: c.tokenCount,
    headingPath: c.headingPath,
  }));
  const replaced = store.replaceDocumentChunks(docId, inputs);
  replaced.chunkIds.forEach((cid, i) => {
    if (!replaced.keptChunkIds.has(cid)) {
      store.replaceEntities(cid, extractEntities(chunked.chunks[i]!.content));
    }
  });
  return docId;
}

/** Ingest one verified record read from `shard`. */
export function ingestRecord(
  store: Store,
  config: ResolvedSearchConfig,
  record: StoreRecord,
  shard: RecordPlace,
  pending: boolean,
): IngestOutcome {
  const db = store.brainRecordsConnection();
  const existing = getRecord(db, record.id);
  if (existing !== null && existing.partition !== shard.partition) return "refused";
  const row: RecordRow = {
    id: record.id,
    partition: shard.partition,
    stream: shard.stream,
    ledger: shard.ledger,
    kind: record.kind,
    scope: record.scope,
    topic: record.topic,
    hlc: record.hlc,
    device: record.device,
    agent: record.agent,
    authority: pending ? (existing?.authority ?? null) : authorityOf(record),
    sum: record.sum,
    shard: shard.key,
    bodyPending: pending,
  };
  const searchable = SEARCHABLE_STORE_STREAMS.has(shard.stream);
  if (existing !== null && !existing.bodyPending && (existing.documentId !== null || !searchable)) {
    if (existing.shard !== shard.key)
      upsertRecord(db, { ...row, bodyPending: false }, existing.documentId);
    return "unchanged";
  }
  if (existing !== null && existing.bodyPending && pending) {
    if (existing.shard !== shard.key) upsertRecord(db, row, existing.documentId);
    return "unchanged";
  }
  const docId = searchable ? indexText(store, config, record, shard, pending) : null;
  upsertRecord(db, row, docId);
  return existing === null ? "added" : "refreshed";
}

/**
 * Index the body of a record that was ingested while its blob was still
 * pending, now that the blob has arrived.
 */
export function completePendingRecord(
  store: Store,
  config: ResolvedSearchConfig,
  stored: StoredRecord,
  body: StoreRecord["body"],
): void {
  const record: StoreRecord = {
    v: STORE_FORMAT_VERSION,
    id: stored.id,
    hlc: stored.hlc,
    device: stored.device,
    agent: stored.agent,
    kind: stored.kind,
    scope: stored.scope,
    topic: stored.topic,
    sum: stored.sum,
    body,
  };
  const place: RecordPlace = {
    key: stored.shard,
    partition: stored.partition as RecordPlace["partition"],
    stream: stored.stream as RecordPlace["stream"],
    ledger: stored.ledger,
  };
  ingestRecord(store, config, record, place, false);
}

/** Remove one record and its document from the index. */
export function removeRecord(store: Store, record: StoredRecord): void {
  if (record.documentId !== null)
    store.deleteDocument(storeRecordPath(record.partition, record.id));
  deleteRecordRow(store.brainRecordsConnection(), record.id);
}

/**
 * Take every brain store record out of an index whose vault no longer
 * reads a store (the store was turned off, removed, or no longer
 * resolves). Only an index file shared by both modes (an explicit
 * `search_db_path`) can be in that state; the vault sweep never removes
 * these documents, so this is their cleanup. Returns the number of
 * documents removed, or null when the index held nothing of a store.
 */
export function purgeStoreRecords(store: Store): number | null {
  const db = store.brainRecordsConnection();
  const paths = storeRecordDocumentPaths(db, `${STORE_RECORD_PATH_PREFIX}/`);
  if (paths.length === 0 && !holdsStoreRows(db)) return null;
  for (const path of paths) store.deleteDocument(path);
  clearStoreTables(db);
  return paths.length;
}
