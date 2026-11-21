/**
 * Re-extract every chunk's entities in place (chunker version 3 -> 4).
 *
 * Version 4 changed only how entities are extracted (whole tokens, see
 * `entities.ts`); the chunks themselves are version 3's. An index whose
 * entity rows were written by the old rules answers entity-boosted
 * queries with a vocabulary the query side no longer produces, so it is
 * brought current. A rebuild would do it too, but a rebuild without paid
 * provider calls drops every stored embedding, so the self-heal uses this
 * refresh on an index that holds any, and keeps them all.
 *
 * The new rows are written into a separate WITHOUT ROWID table in
 * batches, while searches keep reading the old table, and the two are
 * exchanged in one short transaction at the end, so every search answers
 * from one complete entity set. The whole refresh holds the writer lock
 * (it is one write open), checking in between batches; an interrupted
 * refresh leaves the old table in force, and the next one starts over. A
 * refresh that finds the index already stamped current once it holds the
 * lock does nothing.
 */

import { Database } from "bun:sqlite";

import { closeDatabase } from "../sqlite-close.ts";
import { CHUNKER_VERSION, ENTITY_ONLY_CHUNKER_VERSIONS } from "./chunker.ts";
import { extractEntities } from "./entities.ts";
import { consolidateWal, openWriteDatabase } from "./store/lifecycle.ts";
import { bumpIndexRevision, CHUNKER_VERSION_STATE_KEY, getState, setState } from "./store/state.ts";
import { writerLeaseCheckIn } from "./store/writer-lock.ts";
import { SearchError } from "./search-error.ts";
import type { ResolvedSearchConfig } from "./types.ts";

/** The table the refreshed rows are written into before the exchange. */
const REFRESH_TABLE = "chunk_entities_refresh";

/** Chunks read and written per transaction. */
const REFRESH_BATCH_CHUNKS = 2_000;

/** What one refresh did. */
export interface EntityRefreshStats {
  readonly chunks: number;
  readonly entityRows: number;
  readonly durationMs: number;
}

/**
 * Re-extract the entities of every chunk in the index at `config.dbPath`
 * and stamp it with this binary's chunker version. Throws what the write
 * open throws (`INDEX_LOCKED` while another writer holds the index).
 */
export async function refreshEntitiesInPlace(
  config: ResolvedSearchConfig,
): Promise<EntityRefreshStats> {
  const startedAt = Date.now();
  const opened = await openWriteDatabase(config, false);
  try {
    // Re-checked under the writer lock: a second healer that queued behind
    // the first finds the index current and refreshes nothing.
    const storedVersion = getState(opened.db, CHUNKER_VERSION_STATE_KEY);
    if (storedVersion === String(CHUNKER_VERSION)) {
      return { chunks: 0, entityRows: 0, durationMs: Date.now() - startedAt };
    }
    if (storedVersion === null || !ENTITY_ONLY_CHUNKER_VERSIONS.has(storedVersion)) {
      throw new SearchError(
        "INDEX_LOCKED",
        `the index chunker version changed to ${storedVersion ?? "unknown"} before entity refresh; refusing to stamp it as current`,
      );
    }
    const stats = refreshEntities(opened.db);
    consolidateWal(opened.db);
    return { ...stats, durationMs: Date.now() - startedAt };
  } finally {
    // Closed on every path, a failed batch included, before the lock goes.
    closeDatabase(opened.db);
    await opened.release();
  }
}

function refreshEntities(db: Database): { chunks: number; entityRows: number } {
  db.exec(`DROP TABLE IF EXISTS ${REFRESH_TABLE}`);
  db.exec(
    `CREATE TABLE ${REFRESH_TABLE} (` +
      "chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE, " +
      "entity TEXT NOT NULL, PRIMARY KEY (chunk_id, entity)) WITHOUT ROWID",
  );
  const read = db.query<{ id: number; content: string }, [number, number]>(
    "SELECT id, content FROM chunks WHERE id > ? ORDER BY id LIMIT ?",
  );
  const insert = db.query<undefined, [number, string]>(
    `INSERT OR IGNORE INTO ${REFRESH_TABLE}(chunk_id, entity) VALUES (?, ?)`,
  );
  let after = 0;
  let chunks = 0;
  let entityRows = 0;
  for (;;) {
    const batch = read.all(after, REFRESH_BATCH_CHUNKS);
    if (batch.length === 0) break;
    db.transaction(() => {
      for (const row of batch) {
        for (const entity of extractEntities(row.content)) {
          insert.run(row.id, entity);
          entityRows++;
        }
      }
    })();
    chunks += batch.length;
    after = batch[batch.length - 1]!.id;
    writerLeaseCheckIn();
  }
  // The exchange: one transaction, so a search sees the old set or the
  // new one, never a part of either. A chunk deleted since its batch was
  // read cannot be: the refresh holds the writer lock throughout.
  db.transaction(() => {
    db.exec("DROP TABLE chunk_entities");
    db.exec(`ALTER TABLE ${REFRESH_TABLE} RENAME TO chunk_entities`);
    db.exec("CREATE INDEX idx_chunk_entities_entity ON chunk_entities(entity)");
    setState(db, CHUNKER_VERSION_STATE_KEY, String(CHUNKER_VERSION));
    // Entity rows feed the ranking, so answers cached before are stale.
    bumpIndexRevision(db);
  })();
  return { chunks, entityRows };
}
