/**
 * The `chunk_trigram` FTS5 shadow (v9): an opt-in candidate source that
 * broadens large-vault keyword recall with the substring / partial-token
 * matches the word tokenizer misses.
 */

import { Database } from "bun:sqlite";

import { RETRIEVAL_DEGRADATION } from "../retrieval-trail.ts";
import type { RetrievalDegradation } from "../retrieval-trail.ts";
import type { KeywordHit } from "./keyword.ts";

/**
 * What the lane returns: the candidates it gathered, the warnings its
 * caller owes the query, and the same faults as machine codes. Same shape
 * as the keyword lane's own outcome, because the two fill the same
 * candidate pool.
 */
export interface TrigramCandidateOutcome {
  readonly hits: KeywordHit[];
  readonly warnings: ReadonlyArray<string>;
  /**
   * The typed half of {@link warnings}: the classification below survives
   * to the caller instead of being destroyed by the sentence it is
   * interpolated into.
   */
  readonly degraded: ReadonlyArray<RetrievalDegradation>;
}

const NO_WARNINGS: ReadonlyArray<string> = Object.freeze([]);
const NO_DEGRADATIONS: ReadonlyArray<RetrievalDegradation> = Object.freeze([]);

/**
 * Total ordering for the top-K cut, for the reason the keyword lane's
 * own `CHUNK_ORDER` gives: BM25 ties are common in a trigram index -
 * every chunk sharing the same trigram profile scores alike - and
 * `LIMIT` over a partial order picks by scan artefact. `chunks.id` is
 * `INTEGER PRIMARY KEY`, so no schema change is involved.
 */
const CHUNK_ORDER = "ORDER BY bm25 ASC, chunk_id ASC";

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
 * The same fault as a machine code. The classification is what the caller
 * actually needs, and it already existed here: until the retrieval trail
 * it survived only as far as the sentence above, where the last typed
 * step of this lane was interpolated away.
 */
function degradation(fault: TrigramFault): RetrievalDegradation {
  return Object.freeze({
    code: RETRIEVAL_DEGRADATION.keywordTrigramLaneFault,
    detail: Object.freeze({ fault }),
  });
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
            `${CHUNK_ORDER} LIMIT ?`,
        )
        .all(trigramQuery, prefix, prefix, limit);
      return {
        hits: rows.map((r) => ({ chunkId: r.chunk_id, documentId: r.document_id, bm25: r.bm25 })),
        warnings: NO_WARNINGS,
        degraded: NO_DEGRADATIONS,
      };
    }
    const rows = db
      .query<{ chunk_id: number; document_id: number; bm25: number }, [string, number]>(
        "SELECT c.id AS chunk_id, c.document_id AS document_id, bm25(chunk_trigram) AS bm25 " +
          "FROM chunk_trigram JOIN chunks c ON c.id = chunk_trigram.rowid " +
          `WHERE chunk_trigram MATCH ? ${CHUNK_ORDER} LIMIT ?`,
      )
      .all(trigramQuery, limit);
    return {
      hits: rows.map((r) => ({ chunkId: r.chunk_id, documentId: r.document_id, bm25: r.bm25 })),
      warnings: NO_WARNINGS,
      degraded: NO_DEGRADATIONS,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (isMissingTrigramTable(msg)) {
      return { hits: [], warnings: NO_WARNINGS, degraded: NO_DEGRADATIONS };
    }
    const fault = classifyTrigramFault(msg);
    return {
      hits: [],
      warnings: Object.freeze([degradeWarning(fault)]),
      degraded: Object.freeze([degradation(fault)]),
    };
  }
}
