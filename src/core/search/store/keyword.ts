/**
 * The keyword lane: the `chunk_fts` FTS5 index - its availability probe,
 * its BM25 top-K query, its corpus document frequencies, and the
 * integrity counts and rebuild that repair it.
 */

import { Database } from "bun:sqlite";

import { SearchError } from "../types.ts";
import { acquireWriterLockSync } from "./writer-lock.ts";

export interface KeywordHit {
  readonly chunkId: number;
  readonly documentId: number;
  /** Lower is better (FTS5 returns negative bm25). */
  readonly bm25: number;
}

/**
 * BM25 column weights for `chunk_fts`: body first, heading breadcrumb
 * discounted. Named once so the prefixed and unprefixed queries below
 * cannot rank the same row two ways.
 */
const CHUNK_FTS_BM25 = "bm25(chunk_fts, 1.0, 0.3)";

export function ensureFts5(db: Database): void {
  // Probe FTS5 by attempting a benign expression. bun:sqlite ships with
  // FTS5 enabled in the embedded amalgamation; failing here means a
  // custom build without FTS5 and the index is unusable.
  try {
    db.query("SELECT fts5_source('chunk_fts')").get();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Older SQLite returns "no such function" or "no such table" depending
    // on whether FTS5 is even compiled in. We treat any failure here as
    // FTS5-unavailable rather than guessing the build flag.
    if (!/fts5|chunk_fts/i.test(msg)) {
      throw new SearchError("INDEX_UNREADABLE", `FTS5 probe failed: ${msg}`);
    }
  }
}

export function ftsIntegrityCounts(db: Database): {
  readonly chunks: number;
  readonly ftsRows: number;
} {
  const chunks = db.query<{ c: number }, []>("SELECT count(*) AS c FROM chunks").get()?.c ?? 0;
  const ftsRows =
    db.query<{ c: number }, []>("SELECT count(*) AS c FROM chunk_fts_docsize").get()?.c ?? 0;
  return Object.freeze({ chunks, ftsRows });
}

export function rebuildFtsIndex(db: Database): void {
  db.run("INSERT INTO chunk_fts(chunk_fts) VALUES('rebuild')");
}

/**
 * Rebuild under the writer lock when the caller does not already hold it
 * (a read-mode store repairing the index in place). `heldWriterLock` is
 * the caller's own ownership of the lock on `dbPath`: a write-mode store
 * holds it for its whole session and would contend with itself here,
 * since the lock is a file lock and re-entry from the holder is
 * INDEX_LOCKED like any other contender.
 */
export function rebuildFtsIndexWithWriterLock(
  db: Database,
  dbPath: string,
  heldWriterLock: boolean,
): void {
  if (heldWriterLock) {
    rebuildFtsIndex(db);
    return;
  }
  const release = acquireWriterLockSync(dbPath);
  try {
    rebuildFtsIndex(db);
  } finally {
    release();
  }
}

/**
 * Top-K BM25 keyword hits. `fts5Query` is an already-escaped FTS5
 * MATCH expression; building it is fts.ts's job.
 */
export function keywordTopK(
  db: Database,
  fts5Query: string,
  opts: { readonly limit: number; readonly pathPrefix?: string | null },
): KeywordHit[] {
  const limit = Math.max(1, opts.limit | 0);
  const prefix = opts.pathPrefix && opts.pathPrefix.length > 0 ? opts.pathPrefix : null;

  if (prefix) {
    const rows = db
      .query<
        { chunk_id: number; document_id: number; bm25: number },
        [string, string, string, number]
      >(
        `SELECT c.id AS chunk_id, c.document_id AS document_id, ${CHUNK_FTS_BM25} AS bm25 ` +
          "FROM chunk_fts " +
          "JOIN chunks c ON c.id = chunk_fts.rowid " +
          "JOIN documents d ON d.id = c.document_id " +
          "WHERE chunk_fts MATCH ? AND substr(d.path, 1, length(?)) = ? " +
          "ORDER BY bm25 ASC LIMIT ?",
      )
      .all(fts5Query, prefix, prefix, limit);
    return rows.map((r) => ({
      chunkId: r.chunk_id,
      documentId: r.document_id,
      bm25: r.bm25,
    }));
  }

  const rows = db
    .query<{ chunk_id: number; document_id: number; bm25: number }, [string, number]>(
      `SELECT c.id AS chunk_id, c.document_id AS document_id, ${CHUNK_FTS_BM25} AS bm25 ` +
        "FROM chunk_fts JOIN chunks c ON c.id = chunk_fts.rowid " +
        "WHERE chunk_fts MATCH ? ORDER BY bm25 ASC LIMIT ?",
    )
    .all(fts5Query, limit);
  return rows.map((r) => ({
    chunkId: r.chunk_id,
    documentId: r.document_id,
    bm25: r.bm25,
  }));
}

/**
 * Corpus document frequency per term (recall-trust-suite, coverage
 * engine): how many distinct documents match each term in FTS. Each
 * term is quoted so FTS5 metacharacters stay literal. A term that
 * fails to query (e.g. tokenizer edge case) counts as 0 rather than
 * failing the search.
 */
export function documentFrequencies(
  db: Database,
  terms: ReadonlyArray<string>,
): Map<string, number> {
  const out = new Map<string, number>();
  if (terms.length === 0) return out;
  const q = db.query<{ n: number }, [string]>(
    "SELECT COUNT(DISTINCT c.document_id) AS n " +
      "FROM chunk_fts JOIN chunks c ON c.id = chunk_fts.rowid " +
      "WHERE chunk_fts MATCH ?",
  );
  for (const term of terms) {
    try {
      out.set(term, q.get(`"${term.replace(/"/g, '""')}"`)?.n ?? 0);
    } catch {
      out.set(term, 0);
    }
  }
  return out;
}
