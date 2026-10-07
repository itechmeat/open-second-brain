/**
 * The `chunks` table: the units search actually ranks. Owns their
 * atomic replacement per document (the FTS5 shadow follows via the
 * chunks_ai/ad/au triggers) and the hydration reads that turn ids back
 * into rendered text.
 */

import { Database } from "bun:sqlite";

import { SearchError } from "../types.ts";
import { nowIso, sqlPlaceholders } from "./sql.ts";
import {
  matchCarriedVectors,
  readCarryCandidates,
  restoreCarriedVectors,
} from "./vector-carry-over.ts";
import { purgeVecRowsByChunkIds } from "./vectors.ts";

export interface ChunkInput {
  readonly chunkIndex: number;
  readonly content: string;
  readonly ftsContent?: string;
  readonly contentHash: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly tokenCount: number;
  /**
   * Heading breadcrumb in effect at the chunk (v0.13.0). Indexed in the
   * dedicated FTS column; defaults to "" so callers that do not supply
   * it (and pre-v0.13.0 fixtures) index an empty heading column.
   */
  readonly headingPath?: string;
}

export interface ChunkRow {
  readonly id: number;
  readonly documentId: number;
  readonly chunkIndex: number;
  readonly content: string;
  readonly contentHash: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly tokenCount: number;
}

export interface HydratedChunk {
  readonly chunkId: number;
  readonly documentId: number;
  readonly path: string;
  readonly title: string | null;
  readonly content: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly mtime: number;
  /**
   * Transcript turn instant (unix seconds) or null (conversation
   * chronology, S1). It is the ranker's freshness anchor - age is
   * measured from it, falling back to {@link HydratedChunk.mtime} when it
   * is null - it separates an exact score tie, and it is surfaced on the
   * search result. Null for notes with no turn instant, which keeps their
   * ranking and their ordering byte-identical.
   *
   * BOTH reads project it (D1). It was once absent from the
   * representative-chunk read, which left that row unable to distinguish
   * "this document declares no instant" from "this read did not ask" -
   * and a consumer that routed such a row through the ranker would have
   * silently got the storage clock back. Optional in the type only
   * because a caller may construct a row without one.
   */
  readonly authoredAt?: number | null;
  /**
   * sha256 of the chunk content, written on every index run since schema
   * v1 (`chunks.content_hash`). Projected by {@link hydrateChunks} so the
   * assembly stage can fold byte-identical passages into one result row.
   * ABSENT - not null - on reads that do not project it (the
   * representative-chunk read behind traversal expansion), keeping those
   * rows byte-identical to what they were before the projection existed.
   * That absence is load-bearing: {@link HydratedChunk.authoredAt} is the
   * one field that has since left this rule, and it left it deliberately,
   * for the reason stated above.
   */
  readonly contentHash?: string;
  /**
   * sha256 of the WHOLE source file of this chunk's document, frontmatter
   * included (`documents.content_hash`, also schema v1). The chunk hash
   * alone cannot tell a copied file from two distinct records that happen
   * to share a body: frontmatter is stripped before chunking, so two notes
   * with the same prose but different `authored_at`, `freshness_trend` or
   * declared dates hash their chunks identically while ranking - correctly -
   * differently. Pairing the two hashes makes the duplicate merge fire only
   * on a genuine copy. Absent under the same rule as `contentHash`.
   */
  readonly documentHash?: string;
}

export function getChunksByDocument(db: Database, documentId: number): ChunkRow[] {
  const rows = db
    .query<
      {
        id: number;
        document_id: number;
        chunk_index: number;
        content: string;
        content_hash: string;
        start_line: number;
        end_line: number;
        token_count: number;
      },
      [number]
    >(
      "SELECT id, document_id, chunk_index, content, content_hash, start_line, end_line, token_count " +
        "FROM chunks WHERE document_id = ? ORDER BY chunk_index",
    )
    .all(documentId);
  return rows.map((r) => ({
    id: r.id,
    documentId: r.document_id,
    chunkIndex: r.chunk_index,
    content: r.content,
    contentHash: r.content_hash,
    startLine: r.start_line,
    endLine: r.end_line,
    tokenCount: r.token_count,
  }));
}

/** What one document's chunk replacement wrote. */
export interface ChunkReplacement {
  /** The chunk ids, in `chunkIndex` order: kept rows keep theirs. */
  readonly chunkIds: number[];
  /**
   * Chunks that kept a stored vector: kept in place with a vector of the
   * recorded identity, or new rows that carried the vector of an old chunk
   * with the same `content_hash` (vector carry-over). The embedding phase
   * will not pay for them again.
   */
  readonly embeddingsReused: number;
  /**
   * Ids of the chunks kept in place: same position, same content, same
   * lines and heading. Nothing derived from their content (full-text row,
   * entities, vector) needs to be written again.
   */
  readonly keptChunkIds: ReadonlySet<number>;
}

interface StoredChunk {
  id: number;
  chunk_index: number;
  content_hash: string;
  start_line: number;
  end_line: number;
  token_count: number;
  heading_path: string;
  fts_content: string;
}

/**
 * Replace a document's chunks, rewriting only the ones that changed.
 *
 * A chunk at the same `chunkIndex` with the same content hash, lines,
 * token count, heading and full-text form is KEPT: its row, id, full-text row, entities
 * and vector stay as they are (a kept vector of another embedding
 * identity is dropped, as a replaced one would be). Every other old chunk
 * is deleted and every other new chunk inserted, carrying the stored
 * vector of an old chunk with the same content where the identity allows
 * (the rule and its guard live in `vector-carry-over.ts`). A daily log
 * that grows all day therefore costs its appended tail per run, not the
 * whole file. The old `chunk_vec_map` and `embeddings` rows of deleted
 * chunks go with them through the FK cascade; FTS5 stays in sync through
 * the chunks_ai/ad/au triggers.
 */
export function replaceDocumentChunks(
  db: Database,
  vecLoaded: boolean,
  documentId: number,
  chunks: ReadonlyArray<ChunkInput>,
): ChunkReplacement {
  const ids: number[] = [];
  let embeddingsReused = 0;
  const kept = new Set<number>();
  db.exec("BEGIN");
  try {
    const stored = db
      .query<StoredChunk, [number]>(
        "SELECT id, chunk_index, content_hash, start_line, end_line, token_count, heading_path, " +
          "fts_content FROM chunks WHERE document_id = ?",
      )
      .all(documentId);
    const byIndex = new Map(stored.map((r) => [r.chunk_index, r]));
    const keepAt = chunks.map((c) => {
      const old = byIndex.get(c.chunkIndex);
      const same =
        old !== undefined &&
        old.content_hash === c.contentHash &&
        old.start_line === c.startLine &&
        old.end_line === c.endLine &&
        old.token_count === c.tokenCount &&
        old.heading_path === (c.headingPath ?? "") &&
        // The stored full-text form is derived from the content; a release
        // that derives it differently must not leave kept rows behind.
        old.fts_content === (c.ftsContent ?? c.content);
      if (same) kept.add(old.id);
      return same ? old.id : null;
    });

    const candidates = readCarryCandidates(db, vecLoaded, documentId);
    // A kept chunk whose vector is not of the recorded identity loses it,
    // exactly as a replaced chunk's vector would not be carried.
    const validKept = new Set(candidates.filter((c) => kept.has(c.chunkId)).map((c) => c.chunkId));
    const keptStale = [...kept].filter((id) => !validKept.has(id));
    if (keptStale.length > 0) {
      purgeVecRowsByChunkIds(db, vecLoaded, keptStale);
      const placeholders = sqlPlaceholders(keptStale);
      db.run(`DELETE FROM chunk_vec_map WHERE chunk_id IN (${placeholders})`, keptStale);
      db.run(`DELETE FROM embeddings WHERE chunk_id IN (${placeholders})`, keptStale);
    }

    const newPositions: number[] = [];
    keepAt.forEach((id, position) => {
      if (id === null) newPositions.push(position);
    });
    const carried = matchCarriedVectors(
      candidates.filter((c) => !kept.has(c.chunkId)),
      newPositions.map((p) => chunks[p]!.contentHash),
    ).map((m) => ({ position: newPositions[m.position]!, candidate: m.candidate }));
    const carriedOld = new Set(carried.map((m) => m.candidate.chunkId));
    const removed = stored.map((r) => r.id).filter((id) => !kept.has(id));
    purgeVecRowsByChunkIds(
      db,
      vecLoaded,
      removed.filter((id) => !carriedOld.has(id)),
    );
    if (removed.length > 0) {
      db.run(`DELETE FROM chunks WHERE id IN (${sqlPlaceholders(removed)})`, removed);
    }

    const insert = db.prepare<
      { id: number },
      [number, number, string, string, string, number, number, number, string, string, string]
    >(
      "INSERT INTO chunks(document_id, chunk_index, content, fts_content, content_hash, start_line, end_line, token_count, heading_path, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
    );
    const now = nowIso();
    chunks.forEach((c, position) => {
      const keptId = keepAt[position];
      if (keptId !== null && keptId !== undefined) {
        ids.push(keptId);
        return;
      }
      const row = insert.get(
        documentId,
        c.chunkIndex,
        c.content,
        c.ftsContent ?? c.content,
        c.contentHash,
        c.startLine,
        c.endLine,
        c.tokenCount,
        c.headingPath ?? "",
        now,
        now,
      );
      if (!row) throw new SearchError("INDEX_UNREADABLE", "chunk insert returned no id");
      ids.push(row.id);
    });
    restoreCarriedVectors(db, ids, carried);
    embeddingsReused = validKept.size + carried.length;
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { chunkIds: ids, embeddingsReused, keptChunkIds: kept };
}

/**
 * {@link replaceDocumentChunks} for callers that need only the new ids
 * (in `chunkIndex` order). The carry-over applies all the same.
 */
export function replaceChunks(
  db: Database,
  vecLoaded: boolean,
  documentId: number,
  chunks: ReadonlyArray<ChunkInput>,
): number[] {
  return replaceDocumentChunks(db, vecLoaded, documentId, chunks).chunkIds;
}

/**
 * Delete a set of chunks by id. Vec rows removed first.
 */
export function deleteChunks(
  db: Database,
  vecLoaded: boolean,
  chunkIds: ReadonlyArray<number>,
): void {
  if (chunkIds.length === 0) return;
  db.exec("BEGIN");
  try {
    purgeVecRowsByChunkIds(db, vecLoaded, chunkIds);
    const placeholders = sqlPlaceholders(chunkIds);
    db.run(`DELETE FROM chunks WHERE id IN (${placeholders})`, chunkIds as number[]);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Ordered chunk ids for one document (surprisal, t_fddfe64a). */
export function chunksForDocument(
  db: Database,
  documentId: number,
): ReadonlyArray<{ id: number; chunkIndex: number }> {
  return db
    .query<{ id: number; chunk_index: number }, [number]>(
      "SELECT id, chunk_index FROM chunks WHERE document_id = ? ORDER BY chunk_index ASC",
    )
    .all(documentId)
    .map((r) => ({ id: r.id, chunkIndex: r.chunk_index }));
}

/** Total indexed chunk count - used to judge trigram-prefilter selectivity. */
export function countChunks(db: Database): number {
  return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM chunks").get()?.n ?? 0;
}

/**
 * Optional path scope of the pending-vector census: only chunks whose
 * document path starts with one of the prefixes. An absent or empty list
 * means vault-wide, and then the census SQL is exactly the unscoped form.
 */
export interface PendingVectorScope {
  readonly pathPrefixes?: ReadonlyArray<string>;
}

const PENDING_ANTI_JOIN =
  "FROM chunks c LEFT JOIN embeddings e ON e.chunk_id = c.id WHERE e.chunk_id IS NULL";

/**
 * The anti-join's FROM/WHERE text and bindings for a scope. A scoped
 * census joins `documents` and matches each prefix with the
 * `substr(path, 1, length(?)) = ?` form the vector prefix filter uses,
 * which needs no LIKE wildcard escaping.
 */
function pendingCensusClause(scope: PendingVectorScope | undefined): {
  sql: string;
  bindings: string[];
} {
  const prefixes = scope?.pathPrefixes ?? [];
  if (prefixes.length === 0) return { sql: PENDING_ANTI_JOIN, bindings: [] };
  const matches = prefixes.map(() => "substr(d.path, 1, length(?)) = ?").join(" OR ");
  return {
    sql:
      "FROM chunks c JOIN documents d ON d.id = c.document_id " +
      "LEFT JOIN embeddings e ON e.chunk_id = c.id " +
      `WHERE e.chunk_id IS NULL AND (${matches})`,
    bindings: prefixes.flatMap((prefix) => [prefix, prefix]),
  };
}

/**
 * Chunks that have no row in `embeddings`. Used by the indexer to
 * populate vectors after a fresh index or after the model-change drop,
 * optionally scoped to path prefixes.
 */
export function findChunksWithoutEmbeddings(
  db: Database,
  scope?: PendingVectorScope,
): Array<{ chunkId: number; content: string }> {
  const { sql, bindings } = pendingCensusClause(scope);
  const rows = db
    .query<{ id: number; content: string }, string[]>(
      `SELECT c.id AS id, c.content AS content ${sql} ORDER BY c.id`,
    )
    .all(...bindings);
  return rows.map((r) => ({ chunkId: r.id, content: r.content }));
}

/**
 * How MANY chunks have no row in `embeddings`, without materialising a
 * single one of their bodies.
 *
 * The same anti-join {@link findChunksWithoutEmbeddings} walks, under the
 * same scope, as a `COUNT(*)`. The row-returning form is the indexer's
 * work queue and loads every pending chunk's full `content` into JS
 * memory to hand it to a provider; a diagnostic that only wants the
 * number must not pay that, which is the whole reason this second query
 * exists rather than a `.length` on the first.
 */
export function countChunksWithoutEmbeddings(db: Database, scope?: PendingVectorScope): number {
  const { sql, bindings } = pendingCensusClause(scope);
  return db.query<{ n: number }, string[]>(`SELECT COUNT(*) AS n ${sql}`).get(...bindings)?.n ?? 0;
}

export function hydrateChunks(
  db: Database,
  chunkIds: ReadonlyArray<number>,
): Map<number, HydratedChunk> {
  const out = new Map<number, HydratedChunk>();
  if (chunkIds.length === 0) return out;
  const placeholders = sqlPlaceholders(chunkIds);
  const rows = db
    .query<
      {
        chunk_id: number;
        document_id: number;
        path: string;
        title: string | null;
        content: string;
        start_line: number;
        end_line: number;
        mtime: number;
        authored_at: number | null;
        content_hash: string;
        document_hash: string;
      },
      number[]
    >(
      "SELECT c.id AS chunk_id, c.document_id, d.path AS path, d.title AS title, " +
        "       c.content AS content, c.start_line AS start_line, c.end_line AS end_line, d.mtime AS mtime, " +
        "       d.authored_at AS authored_at, c.content_hash AS content_hash, " +
        "       d.content_hash AS document_hash " +
        "FROM chunks c JOIN documents d ON d.id = c.document_id " +
        `WHERE c.id IN (${placeholders})`,
    )
    .all(...(chunkIds as number[]));
  for (const r of rows) {
    out.set(r.chunk_id, {
      chunkId: r.chunk_id,
      documentId: r.document_id,
      path: r.path,
      title: r.title,
      content: r.content,
      startLine: r.start_line,
      endLine: r.end_line,
      mtime: r.mtime,
      authoredAt: r.authored_at,
      contentHash: r.content_hash,
      documentHash: r.document_hash,
    });
  }
  return out;
}

/**
 * One representative chunk per document - the lowest `chunk_index`,
 * which for markdown is the document head (title / opening section).
 * The traversal layer surfaces this when a linked document is not
 * already a relevance hit.
 *
 * Projects `authored_at` (D1) on the join that already fetches `mtime`,
 * so both producers of a {@link HydratedChunk} report the same freshness
 * anchor. Today's consumers - traversal expansion, the graph pre-pass and
 * the relational arm - read `path`, `content` and the ids, so this
 * changes no current ranking; what it removes is the trap that a row from
 * here silently answers the storage clock for a question about content
 * age. The chunk and document hashes stay unprojected, for the reason
 * given on {@link HydratedChunk.contentHash}.
 */
export function representativeChunks(
  db: Database,
  documentIds: ReadonlyArray<number>,
): Map<number, HydratedChunk> {
  const out = new Map<number, HydratedChunk>();
  if (documentIds.length === 0) return out;
  const placeholders = sqlPlaceholders(documentIds);
  const rows = db
    .query<
      {
        chunk_id: number;
        document_id: number;
        path: string;
        title: string | null;
        content: string;
        start_line: number;
        end_line: number;
        mtime: number;
        authored_at: number | null;
      },
      number[]
    >(
      "SELECT c.id AS chunk_id, c.document_id AS document_id, d.path AS path, " +
        "d.title AS title, c.content AS content, c.start_line AS start_line, " +
        "c.end_line AS end_line, d.mtime AS mtime, d.authored_at AS authored_at " +
        "FROM chunks c JOIN documents d ON d.id = c.document_id " +
        `WHERE c.document_id IN (${placeholders}) ` +
        "ORDER BY c.document_id, c.chunk_index ASC",
    )
    .all(...(documentIds as number[]));
  for (const r of rows) {
    if (out.has(r.document_id)) continue; // first row per doc = lowest chunk_index
    out.set(
      r.document_id,
      Object.freeze({
        chunkId: r.chunk_id,
        documentId: r.document_id,
        path: r.path,
        title: r.title,
        content: r.content,
        startLine: r.start_line,
        endLine: r.end_line,
        mtime: r.mtime,
        authoredAt: r.authored_at,
      }),
    );
  }
  return out;
}
