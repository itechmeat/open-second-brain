/**
 * Turn a freshly built index into one an older binary left behind, so the
 * upgrade path can be exercised without an old checkout.
 */
import { Database } from "bun:sqlite";

import { sqliteVecLoadable } from "./sqlite-vec.ts";

/** The schema version before v14's artifacts existed. */
export const PRE_V14_SCHEMA_VERSION = 13;

/** Open `dbPath` read-write with sqlite-vec loaded when available. */
function openWithVec(dbPath: string): Database {
  const db = new Database(dbPath);
  if (sqliteVecLoadable()) {
    // DDL on a file holding a vec0 table needs the module registered.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const vec = require("sqlite-vec") as { getLoadablePath(): string };
    db.loadExtension(vec.getLoadablePath());
  }
  return db;
}

/** Drop the v14 artifacts and stamp schema 13, as a v13 binary wrote it. */
export function rewindToPreV14Schema(dbPath: string): void {
  const db = openWithVec(dbPath);
  try {
    db.exec("DROP INDEX IF EXISTS idx_chunks_kind");
    db.exec("DROP INDEX IF EXISTS idx_documents_page_type");
    db.exec("DROP INDEX IF EXISTS idx_document_attributes_key_value");
    db.exec("DROP TABLE IF EXISTS document_attributes");
    db.exec("ALTER TABLE chunks DROP COLUMN chunk_kind");
    db.query("UPDATE index_state SET value = ? WHERE key = 'schema_version'").run(
      String(PRE_V14_SCHEMA_VERSION),
    );
  } finally {
    db.close();
  }
}

/** Stamp an arbitrary schema version without touching the tables. */
export function stampSchemaVersion(dbPath: string, version: number): void {
  const db = new Database(dbPath);
  try {
    db.query("UPDATE index_state SET value = ? WHERE key = 'schema_version'").run(String(version));
  } finally {
    db.close();
  }
}
