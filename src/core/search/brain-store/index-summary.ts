/**
 * How far the search index has caught up with the brain store (task 2.11):
 * the records it holds, the shards it has read, and when catch-up last
 * moved a shard watermark. `second_brain_status` and `o2b status` report
 * it beside the store's location.
 *
 * Read-only by contract: the index is opened read-only, nothing is
 * created when it is missing, and catch-up is not run. A summary is a
 * look at the index as it is, so a catch-up that found nothing new leaves
 * the time of the last one that did.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

import { closeDatabase } from "../../sqlite-close.ts";
import { RECORDS_TABLE, STORE_WATERMARKS_TABLE } from "../schema.ts";
import { hasBrainRecordTables } from "../store/brain-records.ts";

export interface StoreIndexSummary {
  /** The index file is there. */
  readonly exists: boolean;
  /** Store records in the index; `null` when unknown (no index, or one that predates the store tables). */
  readonly recordsIndexed: number | null;
  /** Store shards with a watermark; `null` when unknown. */
  readonly shardsRead: number | null;
  /** When catch-up last advanced a watermark (ISO 8601), or `null`. */
  readonly lastCatchUpAt: string | null;
  /** Why the index could not be read, when it exists but could not be. */
  readonly error?: string;
}

const ABSENT: StoreIndexSummary = Object.freeze({
  exists: false,
  recordsIndexed: null,
  shardsRead: null,
  lastCatchUpAt: null,
});

/** Summarise the store tables of the index at `dbPath`. Never throws. */
export function readStoreIndexSummary(dbPath: string): StoreIndexSummary {
  if (!existsSync(dbPath)) return ABSENT;
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (err) {
    return { ...ABSENT, exists: true, error: (err as Error).message };
  }
  try {
    if (!hasBrainRecordTables(db)) {
      return { ...ABSENT, exists: true };
    }
    const records = db
      .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${RECORDS_TABLE}`)
      .get()!.n;
    const shards = db
      .query<{ n: number; last: string | null }, []>(
        `SELECT COUNT(*) AS n, MAX(updated_at) AS last FROM ${STORE_WATERMARKS_TABLE}`,
      )
      .get()!;
    return {
      exists: true,
      recordsIndexed: records,
      shardsRead: shards.n,
      lastCatchUpAt: shards.last,
    };
  } catch (err) {
    return { ...ABSENT, exists: true, error: (err as Error).message };
  } finally {
    closeDatabase(db);
  }
}
