/**
 * The `chunk_entities` table (v0.13.0): the normalised entity set the
 * extractor found in each chunk, and the co-occurrence reads the ranker
 * and the cluster digest build on it.
 */

import { Database } from "bun:sqlite";

import { sqlPlaceholders } from "./sql.ts";

/**
 * Replace a chunk's entity set (v0.13.0). Deletes any prior entries
 * for the chunk, then inserts the deduped list. Entities are expected
 * pre-normalised (lowercased) by the extractor.
 */
export function replaceEntities(
  db: Database,
  chunkId: number,
  entities: ReadonlyArray<string>,
): void {
  db.exec("BEGIN");
  try {
    db.run("DELETE FROM chunk_entities WHERE chunk_id = ?", [chunkId]);
    if (entities.length > 0) {
      const insert = db.prepare<undefined, [number, string]>(
        "INSERT OR IGNORE INTO chunk_entities(chunk_id, entity) VALUES (?, ?)",
      );
      for (const e of entities) insert.run(chunkId, e);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * Distinct entities across one document's chunks, sorted
 * (link-recall-intelligence: shared-entity digest in cluster notes).
 */
export function entitiesForDocument(db: Database, documentId: number): ReadonlyArray<string> {
  return db
    .query<{ entity: string }, [number]>(
      "SELECT DISTINCT e.entity AS entity FROM chunk_entities e " +
        "JOIN chunks c ON c.id = e.chunk_id WHERE c.document_id = ? ORDER BY e.entity ASC",
    )
    .all(documentId)
    .map((r) => r.entity);
}

/**
 * For each candidate chunk, the count of distinct query entities it
 * also carries. Empty `queryEntities` yields an empty map (no work).
 * Pure read; used by the ranker to add a capped entity boost.
 */
export function chunkEntityMatches(
  db: Database,
  candidateChunkIds: ReadonlyArray<number>,
  queryEntities: ReadonlyArray<string>,
): Map<number, number> {
  const out = new Map<number, number>();
  if (candidateChunkIds.length === 0 || queryEntities.length === 0) return out;
  const chunkPlaceholders = sqlPlaceholders(candidateChunkIds);
  const entityPlaceholders = sqlPlaceholders(queryEntities);
  const rows = db
    .query<{ chunk_id: number; c: number }, (number | string)[]>(
      "SELECT chunk_id, COUNT(DISTINCT entity) AS c FROM chunk_entities " +
        `WHERE chunk_id IN (${chunkPlaceholders}) AND entity IN (${entityPlaceholders}) ` +
        "GROUP BY chunk_id",
    )
    .all(...(candidateChunkIds as number[]), ...(queryEntities as string[]));
  for (const r of rows) out.set(r.chunk_id, r.c);
  return out;
}
