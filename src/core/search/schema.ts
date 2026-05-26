/**
 * DDL and migrations for the search index. The SQLite database itself
 * is managed by `store.ts`; this module is data + pure functions over
 * a connection so future minor versions can append migrations without
 * touching the store class.
 *
 * Anchored in docs/plans/2026-05-16-brain-search-design.md §5.
 */

import type { Database } from "bun:sqlite";

import { SearchError } from "./types.ts";

/**
 * Latest schema version this code understands. A DB with a value above
 * this raises `SCHEMA_MISMATCH` on open — the operator must reindex
 * with a newer binary.
 */
export const LATEST_SCHEMA_VERSION = 2;

const DDL_V1 = `
CREATE TABLE IF NOT EXISTS documents (
  id            INTEGER PRIMARY KEY,
  path          TEXT NOT NULL UNIQUE,
  title         TEXT,
  content_hash  TEXT NOT NULL,
  mtime         INTEGER NOT NULL,
  size          INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  indexed_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_path ON documents(path);
CREATE INDEX IF NOT EXISTS idx_documents_mtime ON documents(mtime);

CREATE TABLE IF NOT EXISTS chunks (
  id            INTEGER PRIMARY KEY,
  document_id   INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index   INTEGER NOT NULL,
  content       TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  start_line    INTEGER NOT NULL,
  end_line      INTEGER NOT NULL,
  token_count   INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE(document_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id);

CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
  content,
  content='chunks',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunk_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunk_fts(chunk_fts, rowid, content) VALUES('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunk_fts(chunk_fts, rowid, content) VALUES('delete', old.id, old.content);
  INSERT INTO chunk_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TABLE IF NOT EXISTS embeddings (
  chunk_id        INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  model           TEXT NOT NULL,
  dimension       INTEGER NOT NULL,
  embedding_hash  TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_embeddings_model ON embeddings(model);

CREATE TABLE IF NOT EXISTS chunk_vec_map (
  chunk_id   INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  vec_rowid  INTEGER NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS links (
  id                  INTEGER PRIMARY KEY,
  source_document_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  source_chunk_id     INTEGER REFERENCES chunks(id) ON DELETE CASCADE,
  target_path         TEXT,
  target_document_id  INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  link_text           TEXT,
  link_type           TEXT NOT NULL CHECK(link_type IN ('wikilink','markdown_link','tag')),
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_links_source ON links(source_document_id);
CREATE INDEX IF NOT EXISTS idx_links_target_doc ON links(target_document_id);
CREATE INDEX IF NOT EXISTS idx_links_target_path ON links(target_path);

CREATE TABLE IF NOT EXISTS index_state (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
`;

interface Migration {
  readonly version: number;
  readonly up: (db: Database) => void;
}

/**
 * v2 (v0.13.0) - recall-quality backing store. Adds the parallel
 * `chunk_entities` table feeding entity-boosted retrieval. Existing
 * rows carry no entities until a reindex repopulates them, so a
 * pre-migration index ranks bit-identically until then.
 */
const DDL_V2 = `
CREATE TABLE IF NOT EXISTS chunk_entities (
  chunk_id   INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  entity     TEXT NOT NULL,
  PRIMARY KEY (chunk_id, entity)
);
CREATE INDEX IF NOT EXISTS idx_chunk_entities_entity ON chunk_entities(entity);
`;

export const MIGRATIONS: ReadonlyArray<Migration> = Object.freeze([
  {
    version: 1,
    up(db) {
      db.exec(DDL_V1);
    },
  },
  {
    version: 2,
    up(db) {
      db.exec(DDL_V2);
    },
  },
]);

/** Read the current schema version from `index_state`. Returns 0 if not yet recorded. */
export function readSchemaVersion(db: Database): number {
  const row = db
    .query<{ value: string }, []>(
      "SELECT value FROM index_state WHERE key = 'schema_version' LIMIT 1",
    )
    .get();
  if (!row) return 0;
  const n = Number(row.value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new SearchError(
      "INDEX_UNREADABLE",
      `index_state.schema_version is not an integer: '${row.value}'`,
    );
  }
  return n;
}

function setSchemaVersion(db: Database, version: number): void {
  const now = new Date().toISOString();
  db.run(
    "INSERT INTO index_state(key, value, updated_at) VALUES('schema_version', ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    [String(version), now],
  );
}

/**
 * Apply every pending migration in a single transaction. On a fresh
 * database (no `index_state`), v1 creates the entire schema. On an
 * existing one we run only those with `version > current`.
 *
 * Returns the version after migration.
 */
export function applyMigrations(db: Database): number {
  const hasIndexState = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='index_state'",
    )
    .get();

  const current = hasIndexState ? readSchemaVersion(db) : 0;

  if (current > LATEST_SCHEMA_VERSION) {
    throw new SearchError(
      "SCHEMA_MISMATCH",
      `index schema version ${current} is newer than this binary supports (${LATEST_SCHEMA_VERSION}). ` +
        `Run: o2b search reindex`,
    );
  }

  if (current === LATEST_SCHEMA_VERSION) return current;

  db.exec("BEGIN");
  try {
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      migration.up(db);
      setSchemaVersion(db, migration.version);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return LATEST_SCHEMA_VERSION;
}

/**
 * Create the `chunk_vec` virtual table at the given dimension. Caller
 * must have already loaded sqlite-vec; this only issues the DDL.
 *
 * No-op if the table already exists.
 */
export function ensureVecTable(db: Database, dimension: number): void {
  if (!Number.isInteger(dimension) || dimension <= 0) {
    throw new SearchError(
      "INVALID_INPUT",
      `vec dimension must be a positive integer, got ${dimension}`,
    );
  }
  const exists = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='chunk_vec'",
    )
    .get();
  if (exists) return;
  db.exec(`CREATE VIRTUAL TABLE chunk_vec USING vec0(embedding float[${dimension}])`);
}

/** Drop the `chunk_vec` virtual table if it exists. */
export function dropVecTable(db: Database): void {
  db.exec("DROP TABLE IF EXISTS chunk_vec");
}
