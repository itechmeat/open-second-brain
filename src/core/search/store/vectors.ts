/**
 * The semantic lane: the sqlite-vec extension, the `chunk_vec` virtual
 * table and its `chunk_vec_map` rowid bridge, the `embeddings` metadata
 * rows, and the k-nearest-neighbour query over them.
 *
 * The two-step deletion of `chunk_vec` rows that the SQLite FK cascade
 * does NOT reach (design §5) is centralised here, which is why the
 * document and chunk modules delete through this one.
 */

import { Database } from "bun:sqlite";

import { dropVecTable, ensureVecTable } from "../schema.ts";
import { SearchError } from "../types.ts";
import { assertValidVector } from "../vector-guard.ts";
import {
  deleteState,
  EMBEDDING_DIMENSION_STATE_KEY,
  EMBEDDING_MODEL_STATE_KEY,
  EMBEDDING_PREFIX_PASSAGE_STATE_KEY,
  EMBEDDING_PREFIX_QUERY_STATE_KEY,
  EMBEDDING_VEC_VERSION_STATE_KEY,
  getState,
  setState,
} from "./state.ts";
import { nowIso, sqlPlaceholders } from "./sql.ts";

/** The query/passage instruction prefixes active for an index run. */
export interface EmbeddingPrefixPair {
  readonly query: string;
  readonly passage: string;
}

export interface SemanticHit {
  readonly chunkId: number;
  readonly documentId: number;
  /** L2 distance on unit-normalised vectors. */
  readonly distance: number;
}

export interface ModelChangeOutcome {
  readonly wasChanged: boolean;
  readonly previousModel: string | null;
  readonly previousDimension: number | null;
  readonly currentModel: string | null;
  readonly currentDimension: number | null;
}

/** What an open connection knows about sqlite-vec. */
export interface VecRuntime {
  readonly loaded: boolean;
  /** The version the extension reported, or null when it never loaded. */
  readonly version: string | null;
}

/**
 * Load sqlite-vec and return the version it reports, or `null` when the
 * extension is unavailable.
 *
 * The `vec_version()` probe was always executed and its row always
 * discarded; returning it costs nothing and is what lets the ABI the
 * vectors were written against be stamped rather than assumed
 * (context-integrity-gates, Unit E). `null` doubles as the
 * "not loaded" signal, so there is exactly one source of truth for both
 * facts.
 */
export function loadVecExtension(db: Database): string | null {
  try {
    // sqlite-vec is an optional dependency. Wrap the import + load so
    // a missing platform package degrades to "extension unavailable"
    // instead of crashing the process.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const vec = require("sqlite-vec") as { getLoadablePath(): string };
    db.loadExtension(vec.getLoadablePath());
    // Confirm by calling vec_version() — guards against partial loads.
    const row = db.query<{ v: string }, []>("SELECT vec_version() AS v").get();
    return typeof row?.v === "string" ? row.v : null;
  } catch {
    return null;
  }
}

function vecToBuffer(values: ReadonlyArray<number> | Float32Array): Buffer {
  const arr = values instanceof Float32Array ? values : Float32Array.from(values);
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

export function purgeVecRowsForDocument(
  db: Database,
  vecLoaded: boolean,
  documentId: number,
): void {
  if (!vecLoaded) return;
  const vecRows = db
    .query<{ vec_rowid: number }, [number]>(
      "SELECT vec_rowid FROM chunk_vec_map WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)",
    )
    .all(documentId);
  if (vecRows.length === 0) return;
  purgeVecRowidsRaw(
    db,
    vecLoaded,
    vecRows.map((r) => r.vec_rowid),
  );
}

export function purgeVecRowsByChunkIds(
  db: Database,
  vecLoaded: boolean,
  chunkIds: ReadonlyArray<number>,
): void {
  if (!vecLoaded || chunkIds.length === 0) return;
  const placeholders = sqlPlaceholders(chunkIds);
  const vecRows = db
    .query<{ vec_rowid: number }, number[]>(
      `SELECT vec_rowid FROM chunk_vec_map WHERE chunk_id IN (${placeholders})`,
    )
    .all(...(chunkIds as number[]));
  if (vecRows.length === 0) return;
  purgeVecRowidsRaw(
    db,
    vecLoaded,
    vecRows.map((r) => r.vec_rowid),
  );
}

function purgeVecRowidsRaw(db: Database, vecLoaded: boolean, vecRowids: number[]): void {
  if (!vecLoaded || vecRowids.length === 0) return;
  const placeholders = sqlPlaceholders(vecRowids);
  db.run(`DELETE FROM chunk_vec WHERE rowid IN (${placeholders})`, vecRowids);
}

/**
 * Insert or replace a single embedding. The vec table receives the
 * raw float32 bytes; the metadata row in `embeddings` tracks model /
 * dimension / hash for stale detection.
 *
 * Throws VEC_EXTENSION_UNAVAILABLE if sqlite-vec didn't load. The
 * caller decides whether to surface this (explicit semantic) or warn
 * and skip (implicit semantic).
 */
export function vecUpsert(
  db: Database,
  vecLoaded: boolean,
  chunkId: number,
  vector: ReadonlyArray<number> | Float32Array,
  model: string,
  dimension: number,
  embeddingHash: string,
): void {
  if (!vecLoaded) {
    throw new SearchError(
      "VEC_EXTENSION_UNAVAILABLE",
      "sqlite-vec extension not loaded; cannot store embeddings",
    );
  }
  if (vector.length !== dimension) {
    throw new SearchError(
      "EMBEDDING_DIMENSION_MISMATCH",
      `vector dimension ${vector.length} != configured dimension ${dimension}`,
    );
  }
  assertValidVector(vector, "vecUpsert");
  db.exec("BEGIN");
  try {
    const existing = db
      .query<{ vec_rowid: number }, [number]>(
        "SELECT vec_rowid FROM chunk_vec_map WHERE chunk_id = ?",
      )
      .get(chunkId);
    const buf = vecToBuffer(vector);
    let vecRowid: number;
    if (existing) {
      db.run("UPDATE chunk_vec SET embedding = ? WHERE rowid = ?", [buf, existing.vec_rowid]);
      vecRowid = existing.vec_rowid;
    } else {
      db.run("INSERT INTO chunk_vec(embedding) VALUES (?)", [buf]);
      const row = db.query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get();
      if (!row) throw new SearchError("INDEX_UNREADABLE", "chunk_vec insert returned no rowid");
      vecRowid = row.id;
      db.run("INSERT INTO chunk_vec_map(chunk_id, vec_rowid) VALUES (?, ?)", [chunkId, vecRowid]);
    }
    const now = nowIso();
    db.run(
      "INSERT INTO embeddings(chunk_id, model, dimension, embedding_hash, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(chunk_id) DO UPDATE SET " +
        "  model = excluded.model, dimension = excluded.dimension, " +
        "  embedding_hash = excluded.embedding_hash, updated_at = excluded.updated_at",
      [chunkId, model, dimension, embeddingHash, now, now],
    );
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * The stored embedding for one chunk, or null when the vec layer is
 * unavailable or the chunk was never embedded (surprisal,
 * t_fddfe64a).
 */
export function embeddingForChunk(
  db: Database,
  vecLoaded: boolean,
  chunkId: number,
): Float32Array | null {
  if (!vecLoaded) return null;
  const row = db
    .query<{ embedding: Uint8Array }, [number]>(
      "SELECT v.embedding AS embedding FROM chunk_vec v " +
        "JOIN chunk_vec_map m ON m.vec_rowid = v.rowid WHERE m.chunk_id = ?",
    )
    .get(chunkId);
  if (!row) return null;
  const bytes = row.embedding;
  // Copy instead of viewing: a pooled buffer with a non-4-byte-aligned
  // byteOffset would make the Float32Array constructor throw.
  return new Float32Array(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
}

export function getEmbeddingHash(db: Database, chunkId: number): string | null {
  const row = db
    .query<{ embedding_hash: string }, [number]>(
      "SELECT embedding_hash FROM embeddings WHERE chunk_id = ?",
    )
    .get(chunkId);
  return row?.embedding_hash ?? null;
}

/** Number of chunks with a stored embedding row. */
export function countEmbeddings(db: Database): number {
  return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM embeddings").get()?.n ?? 0;
}

/** Embeddings whose `model`/`dimension` no longer match the current config. */
export function staleEmbeddings(
  db: Database,
  model: string | null,
  dimension: number | null,
): number {
  if (!model || !dimension) {
    // No baseline to compare against: 0 stale by convention.
    return 0;
  }
  const row = db
    .query<{ c: number }, [string, number]>(
      "SELECT count(*) AS c FROM embeddings WHERE model != ? OR dimension != ?",
    )
    .get(model, dimension);
  return row?.c ?? 0;
}

/**
 * Drop all embeddings + vec storage. Used when the configured model
 * or dimension changes. `chunks` and `chunk_fts` are preserved.
 */
export function clearEmbeddings(db: Database, vecLoaded: boolean): void {
  db.exec("BEGIN");
  try {
    db.run("DELETE FROM embeddings");
    db.run("DELETE FROM chunk_vec_map");
    if (vecLoaded) dropVecTable(db);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * Compare the configured embedding model/dimension with what was
 * recorded in `index_state` on the last index run. If they differ
 * and both old + new are non-null, drop embeddings + vec table and
 * log one line per design §13. First-time set just records state.
 */
export function ensureEmbeddingModel(
  db: Database,
  vec: VecRuntime,
  model: string | null,
  dimension: number | null,
  prefixes?: EmbeddingPrefixPair,
): ModelChangeOutcome {
  const prevModel = getState(db, EMBEDDING_MODEL_STATE_KEY);
  const prevDimRaw = getState(db, EMBEDDING_DIMENSION_STATE_KEY);
  const prevDim = prevDimRaw === null ? null : Number(prevDimRaw);

  const modelChanged = prevModel !== null && model !== null && prevModel !== model;
  const dimChanged =
    prevDim !== null && dimension !== null && Number.isFinite(prevDim) && prevDim !== dimension;

  // A prefix change invalidates stored vectors exactly as a model/dimension
  // change does: vectors embedded under the old prefix are not comparable to
  // queries embedded under the new one. Reuse the same clear-and-log path.
  const prevQueryPrefix = getState(db, EMBEDDING_PREFIX_QUERY_STATE_KEY);
  const prevPassagePrefix = getState(db, EMBEDDING_PREFIX_PASSAGE_STATE_KEY);
  // Legacy stores predate prefix metadata: absent state (null) means the
  // existing vectors were embedded with EMPTY prefixes. Treat missing state
  // as the empty pair so a switch to non-empty prefixes (e.g. E5's
  // `query:`/`passage:`) is detected as a change and the now-incompatible
  // unprefixed vectors are cleared, rather than silently marked compatible.
  const effectivePrevQueryPrefix = prevQueryPrefix ?? "";
  const effectivePrevPassagePrefix = prevPassagePrefix ?? "";
  const prefixChanged =
    prefixes !== undefined &&
    countEmbeddings(db) > 0 &&
    (effectivePrevQueryPrefix !== prefixes.query ||
      effectivePrevPassagePrefix !== prefixes.passage);

  if (modelChanged || dimChanged) {
    clearEmbeddings(db, vec.loaded);
    // eslint-disable-next-line no-console
    console.error(
      `embedding model changed from ${prevModel}/${prevDim} to ${model}/${dimension}, embeddings cleared`,
    );
    deleteState(db, EMBEDDING_MODEL_STATE_KEY);
    deleteState(db, EMBEDDING_DIMENSION_STATE_KEY);
    // The recorded sqlite-vec version described the vectors that were
    // just cleared, so it must not outlive them: leaving it would
    // claim an ABI for storage that no longer holds any.
    deleteState(db, EMBEDDING_VEC_VERSION_STATE_KEY);
  } else if (prefixChanged) {
    // Model/dimension unchanged: the prefix change alone triggers the clear.
    clearEmbeddings(db, vec.loaded);
    // eslint-disable-next-line no-console
    console.error(
      `embedding prefixes changed from [${effectivePrevQueryPrefix}|${effectivePrevPassagePrefix}] ` +
        `to [${prefixes.query}|${prefixes.passage}], embeddings cleared`,
    );
  }

  if (model !== null) setState(db, EMBEDDING_MODEL_STATE_KEY, model);
  if (dimension !== null) setState(db, EMBEDDING_DIMENSION_STATE_KEY, String(dimension));
  // Same shape as the model and dimension above: recorded only when
  // this build actually has a value. With the extension unavailable
  // there is nothing to record, and writing a placeholder would be a
  // claim about storage this process never touched.
  if (vec.version !== null) {
    setState(db, EMBEDDING_VEC_VERSION_STATE_KEY, vec.version);
  }
  if (prefixes !== undefined) {
    setState(db, EMBEDDING_PREFIX_QUERY_STATE_KEY, prefixes.query);
    setState(db, EMBEDDING_PREFIX_PASSAGE_STATE_KEY, prefixes.passage);
  }

  // (Re)create vec table when we know the dimension and vec is loaded.
  if (vec.loaded && dimension !== null) {
    ensureVecTable(db, dimension);
  }

  return Object.freeze({
    wasChanged: modelChanged || dimChanged,
    previousModel: prevModel,
    previousDimension: prevDim,
    currentModel: model,
    currentDimension: dimension,
  });
}

/**
 * Total ordering for the rows the KNN returns. Distance ties are not
 * exotic here - two chunks with identical text embed to the same vector
 * and therefore to the same distance - and the caller truncates, so a
 * partial order lets the scan decide which tied neighbour survives.
 * `chunk_id` is `chunks.id`, an `INTEGER PRIMARY KEY`, so the extra sort
 * key needs no schema change.
 */
const VEC_ORDER = "ORDER BY v.distance ASC, m.chunk_id ASC";

/**
 * How much wider than `limit` the `k` of the KNN is asked for.
 *
 * `ORDER BY` alone cannot make the cut deterministic: sqlite-vec selects
 * its `k` nearest rows FIRST, by its own internal order, and the sort
 * only ever reaches the rows that selection already kept. Asking for a
 * wider `k` and cutting here means a group of equidistant neighbours
 * straddling the boundary is resolved by the unique sort key rather than
 * by vec's traversal. The scan is a full one with a k-sized heap either
 * way, so the wider k costs heap, not passes.
 *
 * The prefixed branch has always widened by this factor for the
 * different reason that its path predicate drops rows after the KNN; the
 * two branches now share one constant instead of one of them carrying a
 * bare literal.
 */
const VEC_KNN_OVERFETCH = 4;

export function semanticTopK(
  db: Database,
  vecLoaded: boolean,
  queryVector: ReadonlyArray<number> | Float32Array,
  opts: { readonly limit: number; readonly pathPrefix?: string | null },
): SemanticHit[] {
  if (!vecLoaded) {
    throw new SearchError(
      "VEC_EXTENSION_UNAVAILABLE",
      "sqlite-vec extension not loaded; semantic search unavailable",
    );
  }
  const limit = Math.max(1, opts.limit | 0);
  const knn = limit * VEC_KNN_OVERFETCH;
  const prefix = opts.pathPrefix && opts.pathPrefix.length > 0 ? opts.pathPrefix : null;

  assertValidVector(queryVector, "semanticTopK");
  const buf = vecToBuffer(queryVector);
  if (prefix) {
    const rows = db
      .query<
        { chunk_id: number; document_id: number; distance: number },
        [Buffer, number, string, string]
      >(
        "SELECT m.chunk_id AS chunk_id, c.document_id AS document_id, v.distance AS distance " +
          "FROM chunk_vec v " +
          "JOIN chunk_vec_map m ON m.vec_rowid = v.rowid " +
          "JOIN chunks c ON c.id = m.chunk_id " +
          "JOIN documents d ON d.id = c.document_id " +
          "WHERE v.embedding MATCH ? AND k = ? AND substr(d.path, 1, length(?)) = ? " +
          VEC_ORDER,
      )
      .all(buf, knn, prefix, prefix);
    return rows.slice(0, limit).map((r) => ({
      chunkId: r.chunk_id,
      documentId: r.document_id,
      distance: r.distance,
    }));
  }

  const rows = db
    .query<{ chunk_id: number; document_id: number; distance: number }, [Buffer, number]>(
      "SELECT m.chunk_id AS chunk_id, c.document_id AS document_id, v.distance AS distance " +
        "FROM chunk_vec v " +
        "JOIN chunk_vec_map m ON m.vec_rowid = v.rowid " +
        "JOIN chunks c ON c.id = m.chunk_id " +
        "WHERE v.embedding MATCH ? AND k = ? " +
        VEC_ORDER,
    )
    .all(buf, knn);
  return rows.slice(0, limit).map((r) => ({
    chunkId: r.chunk_id,
    documentId: r.document_id,
    distance: r.distance,
  }));
}
