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

import {
  BLOCKED_TIER_ERROR_CODE,
  isBlockedCapability,
  resolveSemanticCapability,
} from "../capability-tier.ts";
import { LOCAL_EMBEDDING_MODEL } from "../embeddings/signature.ts";
import { dropVecTable, ensureVecTable } from "../schema.ts";
import { SearchError, type ResolvedEmbeddingConfig, type SearchErrorCode } from "../types.ts";
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
  /**
   * Present when the verify-before-replace gate refused a clear: the
   * stored vectors and the recorded model were kept, and the store opened
   * anyway so keyword indexing goes on. The same sentence is logged.
   */
  readonly refusal?: EmbeddingRebuildRefusal;
}

/** A refused clear, named by the blocked tier's error code. */
export interface EmbeddingRebuildRefusal {
  readonly code: SearchErrorCode;
  readonly message: string;
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
  return vectorFromBlob(row.embedding);
}

/** Copy a stored vec0 blob into a `Float32Array`. */
function vectorFromBlob(bytes: Uint8Array): Float32Array {
  // Copy instead of viewing: a pooled buffer with a non-4-byte-aligned
  // byteOffset would make the Float32Array constructor throw.
  return new Float32Array(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
}

/** One stored chunk vector with the identity its `embeddings` row recorded. */
export interface StoredChunkEmbedding {
  readonly chunkId: number;
  readonly vector: Float32Array;
  readonly model: string;
  readonly dimension: number;
}

/**
 * Every stored vector of one document's chunks, in `chunk_index` order,
 * each with the model and dimension recorded when it was written. A
 * reader that scores against a fresh query vector needs the identity per
 * row: a vector left by an older model is not comparable and must be
 * told apart from a current one, which {@link embeddingForChunk} cannot.
 */
export function storedEmbeddingsForDocument(
  db: Database,
  vecLoaded: boolean,
  documentId: number,
): StoredChunkEmbedding[] {
  if (!vecLoaded) {
    throw new SearchError(
      "VEC_EXTENSION_UNAVAILABLE",
      "sqlite-vec extension not loaded; cannot read stored embeddings",
    );
  }
  return db
    .query<{ chunk_id: number; embedding: Uint8Array; model: string; dimension: number }, [number]>(
      "SELECT c.id AS chunk_id, v.embedding AS embedding, e.model AS model, " +
        "e.dimension AS dimension FROM chunks c " +
        "JOIN chunk_vec_map m ON m.chunk_id = c.id " +
        "JOIN chunk_vec v ON v.rowid = m.vec_rowid " +
        "JOIN embeddings e ON e.chunk_id = c.id " +
        "WHERE c.document_id = ? ORDER BY c.chunk_index",
    )
    .all(documentId)
    .map((r) => ({
      chunkId: r.chunk_id,
      vector: vectorFromBlob(r.embedding),
      model: r.model,
      dimension: r.dimension,
    }));
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

/**
 * Embeddings whose `model`/`dimension` no longer match the current config.
 *
 * With no model there is no baseline, and the count is 0 by convention -
 * a caller that must not read that as healthy checks the model first.
 * With a model but no dimension (none configured, none stored), the
 * vectors are compared by model alone: a model switch on a default
 * configuration is exactly the case a dimension-gated zero used to hide.
 */
export function staleEmbeddings(
  db: Database,
  model: string | null,
  dimension: number | null,
): number {
  if (!model) return 0;
  if (!dimension) {
    return (
      db
        .query<{ c: number }, [string]>("SELECT count(*) AS c FROM embeddings WHERE model != ?")
        .get(model)?.c ?? 0
    );
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
 * Evidence a caller must hand the model-change gate: the resolved
 * embedding configuration of THIS process, from which the gate derives
 * the one capability verdict (`resolveSemanticCapability`) that decides
 * whether a cleared corpus could actually be rebuilt.
 *
 * Callers that open write connections (the `Store` wrapper every
 * production path funnels through) must pass `{ semantic }` from their
 * resolved config. A caller that passes no gate supplies no capability
 * evidence, and the legacy clear contract applies unchanged - the gate
 * is evidence-driven, so absence of evidence is never read as evidence
 * of rebuildability.
 */
export interface EmbeddingRebuildGate {
  readonly semantic: ResolvedEmbeddingConfig;
}

/**
 * Whether any `chunks` rows exist - the source-material half of the
 * verify-before-replace gate.
 *
 * Deliberately a local query rather than an import of `countChunks`
 * from `./chunks.ts`: that module already imports this one for the vec
 * purge helpers, and a back-import would close a module cycle for one
 * SQL line. The census spelling stays `countChunks`; this predicate
 * only answers presence.
 */
function hasChunkRows(db: Database): boolean {
  const row = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM chunks").get();
  return (row?.n ?? 0) > 0;
}

/**
 * The verify-before-replace gate (t_2fbdaf70): a clear that destroys
 * stored vectors must not run unless the corpus can be rebuilt.
 *
 * Loss-bearing trigger: the stored embeddings row count. A store without
 * embeddings loses nothing to a clear. In an FK-enforced store
 * (`PRAGMA foreign_keys = ON`, `embeddings.chunk_id REFERENCES chunks`)
 * stored embeddings imply chunk rows, so the design's chunk-material
 * assertion cannot flip the verdict in a healthy store - it surfaces in
 * the refusal detail instead, naming the one corruption state
 * (embeddings without chunks) where the rebuild would have no source.
 *
 * The verdict is the capability tier: a `disabled` or
 * `credential-missing` configuration cannot recompute the vectors, so
 * the clear would be destruction without a recovery path. The refusal
 * is returned, named by the tier's error code, BEFORE any mutation: the
 * old vectors and the old recorded model both survive, the store still
 * opens (keyword indexing does not depend on vectors), and every later
 * open names it again until the operator restores a rebuilding
 * configuration or reverts the model.
 */
function rebuildRefusalBeforeClear(
  db: Database,
  gate: EmbeddingRebuildGate | undefined,
  context: {
    readonly previousModel: string | null;
    readonly previousDimension: number | null;
    readonly model: string | null;
    readonly dimension: number | null;
  },
): EmbeddingRebuildRefusal | null {
  if (gate === undefined) return null;
  const stored = countEmbeddings(db);
  if (stored === 0) return null;
  const capability = resolveSemanticCapability(gate.semantic);
  if (!isBlockedCapability(capability)) return null;
  const material = hasChunkRows(db) ? "" : "; no chunk material remains to rebuild from";
  return {
    code: BLOCKED_TIER_ERROR_CODE[capability.tier],
    message:
      `embedding model change from ${context.previousModel}/${context.previousDimension} to ` +
      `${context.model}/${context.dimension} refused: ${stored} stored embedding(s) cannot be ` +
      `rebuilt while the semantic capability is ${capability.tier}${material}; the stored ` +
      `embeddings and the recorded model are kept; restore the previous model or the provider ` +
      `credential, then reindex`,
  };
}

/**
 * Compare the configured embedding model/dimension with what was
 * recorded in `index_state` on the last index run. If they differ
 * and both old + new are non-null, drop embeddings + vec table and
 * log one line per design §13. First-time set just records state.
 *
 * Two guarded edges (t_2fbdaf70):
 * - The clear is gated on rebuildability when the caller passes an
 *   {@link EmbeddingRebuildGate}: with stored vectors present and a
 *   capability tier that cannot recompute them, the clear is refused:
 *   nothing is mutated, the refusal is logged and returned on the
 *   outcome under the tier's error code, and the caller's open goes on.
 * - A named-model -> null-model transition is not a detected change
 *   (the ladder requires both sides non-null), but under the gate's own
 *   logic it must not clear either - rebuildability cannot be verified
 *   with no model configured. It warns one line naming the last recorded
 *   model and keeps the vectors; with nothing stored it stays silent.
 */
export function ensureEmbeddingModel(
  db: Database,
  vec: VecRuntime,
  model: string | null,
  dimension: number | null,
  prefixes?: EmbeddingPrefixPair,
  gate?: EmbeddingRebuildGate,
): ModelChangeOutcome {
  const prevModel = getState(db, EMBEDDING_MODEL_STATE_KEY);
  const prevDimRaw = getState(db, EMBEDDING_DIMENSION_STATE_KEY);
  const prevDim = prevDimRaw === null ? null : Number(prevDimRaw);

  const modelChanged = prevModel !== null && model !== null && prevModel !== model;
  const dimChanged =
    prevDim !== null && dimension !== null && Number.isFinite(prevDim) && prevDim !== dimension;
  // A named-model -> null-model transition (t_2fbdaf70). The local
  // embedder's model is implicit - the config never names it - so a
  // recorded LOCAL_EMBEDDING_MODEL meeting a null incoming model is the
  // steady state of every local-provider vault, not a removed model;
  // warning there would be recurring noise on every write open.
  const modelRemoved = prevModel !== null && model === null && prevModel !== LOCAL_EMBEDDING_MODEL;

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

  const refusalContext = {
    previousModel: prevModel,
    previousDimension: prevDim,
    model,
    dimension,
  };
  const refusal =
    modelChanged || dimChanged || (!modelRemoved && prefixChanged)
      ? rebuildRefusalBeforeClear(db, gate, refusalContext)
      : null;
  if (refusal !== null) {
    // eslint-disable-next-line no-console
    console.error(`${refusal.code}: ${refusal.message}`);
    return Object.freeze({
      wasChanged: false,
      previousModel: prevModel,
      previousDimension: prevDim,
      currentModel: prevModel,
      currentDimension: prevDim,
      refusal,
    });
  }

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
  } else if (modelRemoved && countEmbeddings(db) > 0) {
    // Named-model -> null-model: never a clear (see docblock), never silent.
    // This branch also deliberately precedes the prefix branch: with no
    // model configured there is nothing to verify a prefix clear against.
    // eslint-disable-next-line no-console
    console.error(
      `embedding model removed from config (was ${prevModel}); ` +
        `${countEmbeddings(db)} stored embedding(s) kept - rebuildability cannot be verified ` +
        `with no model configured`,
    );
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
