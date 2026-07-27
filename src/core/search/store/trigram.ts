/**
 * The `chunk_trigram` FTS5 shadow (v9): an opt-in candidate source that
 * broadens large-vault keyword recall with the substring / partial-token
 * matches the word tokenizer misses.
 */

import { Database } from "bun:sqlite";

import type { KeywordHit } from "./keyword.ts";

/**
 * What the lane returns: the candidates it gathered plus the warnings its
 * caller owes the query. Same shape as the keyword lane's own outcome,
 * because the two fill the same candidate pool.
 */
export interface TrigramCandidateOutcome {
  readonly hits: KeywordHit[];
  readonly warnings: ReadonlyArray<string>;
}

const NO_WARNINGS: ReadonlyArray<string> = Object.freeze([]);

/**
 * The one condition this lane stays SILENT for: `chunk_trigram` itself is
 * absent, which is a store migrated to v9 but never rebuilt - the table
 * is documented as optional. Anchored on the right, because a message
 * naming `chunk_trigram_data` / `_idx` / `_content` / `_docsize` names an
 * FTS5 shadow the index has LOST: the index HAS the trigram table and
 * cannot read it, which is corruption and must be reported, not silently
 * answered with an empty candidate list.
 */
export function isMissingTrigramTable(message: string): boolean {
  return /no such table:?\s*(?:main\.)?chunk_trigram(?![A-Za-z0-9_])/i.test(message);
}

/**
 * Why the lane could not answer, as a closed vocabulary. The SQLite
 * message itself never reaches the warning: FTS5 reports a rejected MATCH
 * by echoing the expression, and that expression is built from the
 * caller's query, while other messages can name the index file - a
 * warning travels into logs and MCP payloads, so it carries a cause and
 * never content.
 */
type TrigramFault =
  | "locked"
  | "tokenizer_unavailable"
  | "corrupt"
  | "shadow_incomplete"
  | "unknown";

function classifyTrigramFault(message: string): TrigramFault {
  if (/\bis locked\b|SQLITE_BUSY/i.test(message)) return "locked";
  if (/no such tokenizer/i.test(message)) return "tokenizer_unavailable";
  if (/malformed|corrupt/i.test(message)) return "corrupt";
  if (/no such (?:table|column|module)/i.test(message)) return "shadow_incomplete";
  return "unknown";
}

/**
 * The lane only ever ADDS to a pool the keyword lane already filled, so a
 * fault degrades the lane instead of failing the query - but visibly:
 * `trigram_degraded` is the greppable flag, alongside `hybrid_degraded`
 * for the semantic lane. A silent empty list here would narrow recall
 * while reading as a vault with nothing to match.
 */
function degradeWarning(fault: TrigramFault): string {
  return `trigram_degraded [${fault}]: trigram candidate lane skipped; keyword candidates unaffected`;
}

/**
 * Trigram candidate lookup over the `chunk_trigram` FTS5 shadow (v9).
 * Returns bm25-ordered keyword hits whose content matches the trigram
 * query - a strict superset of exact substring matches for the query's
 * terms, used as an opt-in candidate source that broadens large-vault
 * keyword recall (substring / partial-token matches the word tokenizer
 * misses). Yields no candidates and no warning when the trigram table is
 * absent; any other fault yields no candidates and one warning naming
 * the cause.
 */
export function trigramCandidates(
  db: Database,
  trigramQuery: string,
  opts: { readonly limit: number; readonly pathPrefix?: string | null },
): TrigramCandidateOutcome {
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
      return {
        hits: rows.map((r) => ({ chunkId: r.chunk_id, documentId: r.document_id, bm25: r.bm25 })),
        warnings: NO_WARNINGS,
      };
    }
    const rows = db
      .query<{ chunk_id: number; document_id: number; bm25: number }, [string, number]>(
        "SELECT c.id AS chunk_id, c.document_id AS document_id, bm25(chunk_trigram) AS bm25 " +
          "FROM chunk_trigram JOIN chunks c ON c.id = chunk_trigram.rowid " +
          "WHERE chunk_trigram MATCH ? ORDER BY bm25 ASC LIMIT ?",
      )
      .all(trigramQuery, limit);
    return {
      hits: rows.map((r) => ({ chunkId: r.chunk_id, documentId: r.document_id, bm25: r.bm25 })),
      warnings: NO_WARNINGS,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (isMissingTrigramTable(msg)) return { hits: [], warnings: NO_WARNINGS };
    return { hits: [], warnings: Object.freeze([degradeWarning(classifyTrigramFault(msg))]) };
  }
}
