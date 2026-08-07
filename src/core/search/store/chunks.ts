/**
 * The `chunks` table: the units search actually ranks. Owns their
 * atomic replacement per document (the FTS5 shadow follows via the
 * chunks_ai/ad/au triggers) and the hydration reads that turn ids back
 * into rendered text.
 */

import { Database } from "bun:sqlite";

import { SearchError } from "../types.ts";
import { nowIso, sqlPlaceholders } from "./sql.ts";
import { purgeVecRowsByChunkIds, purgeVecRowsForDocument } from "./vectors.ts";

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
   * chronology, S1). Feeds the exact-tie recency tie-break in the ranker
   * and is surfaced on the search result. Null for notes with no turn
   * instant, keeping their ordering byte-identical.
   */
  readonly authoredAt?: number | null;
  /**
   * sha256 of the chunk content, written on every index run since schema
   * v1 (`chunks.content_hash`). Projected by {@link hydrateChunks} so the
   * assembly stage can fold byte-identical passages into one result row.
   * ABSENT - not null - on reads that do not project it (the
   * representative-chunk read behind traversal expansion), keeping those
   * rows byte-identical to what they were before the projection existed.
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

/**
 * Atomically replace every chunk for a document. Old vec rows are
 * removed first; FTS5 stays in sync via the chunks_ai/ad/au triggers.
 * Returns the new chunk ids in `chunkIndex` order.
 */
export function replaceChunks(
  db: Database,
  vecLoaded: boolean,
  documentId: number,
  chunks: ReadonlyArray<ChunkInput>,
): number[] {
  const ids: number[] = [];
  db.exec("BEGIN");
  try {
    purgeVecRowsForDocument(db, vecLoaded, documentId);
    db.run("DELETE FROM chunks WHERE document_id = ?", [documentId]);
    const insert = db.prepare<
      { id: number },
      [number, number, string, string, string, number, number, number, string, string, string]
    >(
      "INSERT INTO chunks(document_id, chunk_index, content, fts_content, content_hash, start_line, end_line, token_count, heading_path, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
    );
    const now = nowIso();
    for (const c of chunks) {
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
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return ids;
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
 * Chunks that have no row in `embeddings`. Used by the indexer to
 * populate vectors after a fresh index or after the model-change drop.
 */
export function findChunksWithoutEmbeddings(
  db: Database,
): Array<{ chunkId: number; content: string }> {
  const rows = db
    .query<{ id: number; content: string }, []>(
      "SELECT c.id AS id, c.content AS content FROM chunks c " +
        "LEFT JOIN embeddings e ON e.chunk_id = c.id " +
        "WHERE e.chunk_id IS NULL ORDER BY c.id",
    )
    .all();
  return rows.map((r) => ({ chunkId: r.id, content: r.content }));
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
      },
      number[]
    >(
      "SELECT c.id AS chunk_id, c.document_id AS document_id, d.path AS path, " +
        "d.title AS title, c.content AS content, c.start_line AS start_line, " +
        "c.end_line AS end_line, d.mtime AS mtime " +
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
      }),
    );
  }
  return out;
}
