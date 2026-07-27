/**
 * The `chunk_trigram` FTS5 shadow (v9): an opt-in candidate source that
 * broadens large-vault keyword recall with the substring / partial-token
 * matches the word tokenizer misses.
 */

import { Database } from "bun:sqlite";

import { SearchError } from "../types.ts";
import type { KeywordHit } from "./keyword.ts";

/**
 * The one condition this lane fails soft on: an index whose
 * `chunk_trigram` shadow is absent (a store migrated to v9 but never
 * rebuilt). Any OTHER failure is a real index fault and is raised - an
 * empty candidate list there would silently narrow recall and read as a
 * vault with nothing to match.
 */
function isMissingTrigramTable(message: string): boolean {
  return /no such table:?\s*(main\.)?chunk_trigram/i.test(message);
}

/**
 * Trigram candidate lookup over the `chunk_trigram` FTS5 shadow (v9).
 * Returns bm25-ordered keyword hits whose content matches the trigram
 * query - a strict superset of exact substring matches for the query's
 * terms, used as an opt-in candidate source that broadens large-vault
 * keyword recall (substring / partial-token matches the word tokenizer
 * misses). Fails soft to an empty list if the trigram table is absent
 * (a migrated-but-not-reindexed index always has it via the v9 rebuild).
 */
export function trigramCandidates(
  db: Database,
  trigramQuery: string,
  opts: { readonly limit: number; readonly pathPrefix?: string | null },
): KeywordHit[] {
  const limit = Math.max(1, opts.limit | 0);
  const prefix = opts.pathPrefix && opts.pathPrefix.length > 0 ? opts.pathPrefix : null;
  try {
    if (prefix) {
      const rows = db
        .query<
          { chunk_id: number; document_id: number; bm25: number },
          [string, string, string, number]
        >(
          "SELECT c.id AS chunk_id, c.document_id AS document_id, bm25(chunk_trigram) AS bm25 " +
            "FROM chunk_trigram " +
            "JOIN chunks c ON c.id = chunk_trigram.rowid " +
            "JOIN documents d ON d.id = c.document_id " +
            "WHERE chunk_trigram MATCH ? AND substr(d.path, 1, length(?)) = ? " +
            "ORDER BY bm25 ASC LIMIT ?",
        )
        .all(trigramQuery, prefix, prefix, limit);
      return rows.map((r) => ({ chunkId: r.chunk_id, documentId: r.document_id, bm25: r.bm25 }));
    }
    const rows = db
      .query<{ chunk_id: number; document_id: number; bm25: number }, [string, number]>(
        "SELECT c.id AS chunk_id, c.document_id AS document_id, bm25(chunk_trigram) AS bm25 " +
          "FROM chunk_trigram JOIN chunks c ON c.id = chunk_trigram.rowid " +
          "WHERE chunk_trigram MATCH ? ORDER BY bm25 ASC LIMIT ?",
      )
      .all(trigramQuery, limit);
    return rows.map((r) => ({ chunkId: r.chunk_id, documentId: r.document_id, bm25: r.bm25 }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (isMissingTrigramTable(msg)) return [];
    throw new SearchError("INDEX_UNREADABLE", `trigram candidate lookup failed: ${msg}`);
  }
}
