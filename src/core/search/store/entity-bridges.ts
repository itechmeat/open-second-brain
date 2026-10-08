/**
 * Entity-bridge edges over the `chunk_entities` table
 * (truth-correctable-time-aware, design decision 11): two documents that
 * mention the same normalized entity get one bridge edge, so the relational
 * fan-out can walk entity co-occurrence beside the declared typed edges.
 *
 * Bridges are machine-derived, never part of the query edge-type
 * vocabulary - `parseRelationalQuery` validation is unaffected, and the
 * walk labels them `entity` (see `ENTITY_BRIDGE_RELATION` in
 * `relational-fanout.ts`). The reader is a pure read: one join over
 * `chunk_entities` twice through `chunks`, deduplicated per document pair
 * (sharing three entities is still one bridge), self pairs excluded, and
 * ordered by source then target document id so the walk that consumes it
 * is deterministic.
 */

import type { Database } from "bun:sqlite";

import { sqlPlaceholders } from "./sql.ts";

/** One deduplicated co-occurrence bridge: source mentions what target mentions. */
export interface EntityBridgePair {
  readonly sourceDocumentId: number;
  readonly targetDocumentId: number;
}

/**
 * The entity bridges of the given source documents: every OTHER document
 * sharing at least one normalized entity with one of them, one pair per
 * document pair, ascending by source then target id. Empty input answers
 * empty without touching the database.
 */
export function entityBridgesForDocuments(
  db: Database,
  documentIds: ReadonlyArray<number>,
): Array<EntityBridgePair> {
  if (documentIds.length === 0) return [];
  const placeholders = sqlPlaceholders(documentIds);
  return db
    .query<{ source_document_id: number; target_document_id: number }, number[]>(
      "SELECT DISTINCT c.document_id AS source_document_id, c2.document_id AS target_document_id " +
        "FROM chunk_entities e " +
        "JOIN chunks c ON c.id = e.chunk_id " +
        "JOIN chunk_entities e2 ON e2.entity = e.entity " +
        "JOIN chunks c2 ON c2.id = e2.chunk_id " +
        `WHERE c.document_id IN (${placeholders}) AND c2.document_id <> c.document_id ` +
        "ORDER BY source_document_id ASC, target_document_id ASC",
    )
    .all(...(documentIds as number[]))
    .map((r) => ({
      sourceDocumentId: r.source_document_id,
      targetDocumentId: r.target_document_id,
    }));
}
