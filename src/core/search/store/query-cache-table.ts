/**
 * The `query_cache` table (v0.20.0): serialized search payloads keyed by
 * cache key and stamped with the corpus generation that produced them.
 * Storage only - what is cacheable and for how long is `query-cache.ts`'s
 * decision.
 */

import { Database } from "bun:sqlite";

export interface QueryCacheRow {
  readonly generation: string;
  readonly payload: string;
  readonly createdAt: number;
}

export function queryCacheGet(db: Database, key: string): QueryCacheRow | null {
  const row = db
    .query<{ generation: string; payload: string; created_at: number }, [string]>(
      "SELECT generation, payload, created_at FROM query_cache WHERE cache_key = ?",
    )
    .get(key);
  if (!row) return null;
  return {
    generation: row.generation,
    payload: row.payload,
    createdAt: row.created_at,
  };
}

export function queryCachePut(
  db: Database,
  key: string,
  generation: string,
  payload: string,
  createdAtMs: number,
): void {
  db.run(
    "INSERT INTO query_cache(cache_key, generation, payload, created_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(cache_key) DO UPDATE SET generation = excluded.generation, " +
      "payload = excluded.payload, created_at = excluded.created_at",
    [key, generation, payload, createdAtMs],
  );
}

/** Delete rows from a stale generation or created before the cutoff. */
export function queryCacheSweep(
  db: Database,
  currentGeneration: string,
  expiredBeforeMs: number,
): void {
  db.run("DELETE FROM query_cache WHERE generation <> ? OR created_at < ?", [
    currentGeneration,
    expiredBeforeMs,
  ]);
}
