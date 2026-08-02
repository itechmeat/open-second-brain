/**
 * Schema migration v10 -> v11: the materialised event anchor
 * (`documents.event_anchor_start_ms` / `event_anchor_end_ms` /
 * `event_anchor_source`, provenance at the boundary, t_ac1c4176).
 *
 * Additive and reindex-safe: existing rows keep every column they had and
 * default to NULL on the three new ones until a reindex repopulates them,
 * so a vault whose notes declare no dates ranks byte-identically.
 *
 * The rewind case is the one that matters. A migration that strands data
 * on disk passes every fresh-database test there is, so v11 is checked
 * against an index rewound to v10 WITH A ROW IN IT, not only against an
 * empty new one.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyMigrations,
  LATEST_SCHEMA_VERSION,
  readSchemaVersion,
} from "../../../src/core/search/schema.ts";

const ANCHOR_COLUMNS = ["event_anchor_start_ms", "event_anchor_end_ms", "event_anchor_source"];

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-mig-v11-"));
  dbPath = join(tmp, "test.sqlite");
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function hasColumn(db: Database, table: string, name: string): boolean {
  return db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .some((c) => c.name === name);
}

test("latest schema version is 11", () => {
  expect(LATEST_SCHEMA_VERSION).toBe(11);
});

test("fresh migration reaches latest with all three event-anchor columns", () => {
  const db = new Database(dbPath);
  expect(applyMigrations(db)).toBe(LATEST_SCHEMA_VERSION);
  for (const col of ANCHOR_COLUMNS) expect(hasColumn(db, "documents", col)).toBe(true);
  db.close();
});

test("a v10 index rewound and re-migrated preserves existing rows with the new columns null", () => {
  const db = new Database(dbPath);
  applyMigrations(db); // -> latest
  db.run(
    "INSERT INTO documents(id, path, basename, title, content_hash, mtime, size, page_type, authored_at, created_at, updated_at, indexed_at) " +
      "VALUES (1, 'notes/alpha.md', 'alpha', 'A', 'h', 42, 7, 'note', 99, 't1', 't2', 't3')",
  );
  // Simulate an older v10 index: drop the three columns and rewind.
  for (const col of ANCHOR_COLUMNS) db.run(`ALTER TABLE documents DROP COLUMN ${col}`);
  db.run("UPDATE index_state SET value = '10' WHERE key = 'schema_version'");
  expect(readSchemaVersion(db)).toBe(10);

  expect(applyMigrations(db)).toBe(LATEST_SCHEMA_VERSION);
  for (const col of ANCHOR_COLUMNS) expect(hasColumn(db, "documents", col)).toBe(true);

  const row = db
    .query<
      {
        id: number;
        path: string;
        basename: string;
        title: string;
        content_hash: string;
        mtime: number;
        size: number;
        page_type: string | null;
        authored_at: number | null;
        event_anchor_start_ms: number | null;
        event_anchor_end_ms: number | null;
        event_anchor_source: string | null;
      },
      []
    >(
      "SELECT id, path, basename, title, content_hash, mtime, size, page_type, authored_at, " +
        "event_anchor_start_ms, event_anchor_end_ms, event_anchor_source FROM documents WHERE id = 1",
    )
    .get();
  expect(row).toEqual({
    id: 1,
    path: "notes/alpha.md",
    basename: "alpha",
    title: "A",
    content_hash: "h",
    mtime: 42,
    size: 7,
    page_type: "note",
    authored_at: 99,
    event_anchor_start_ms: null,
    event_anchor_end_ms: null,
    event_anchor_source: null,
  });
  db.close();
});

test("re-running the migration over an already-migrated index is a no-op", () => {
  const db = new Database(dbPath);
  applyMigrations(db);
  db.run("UPDATE index_state SET value = '10' WHERE key = 'schema_version'");
  // The PRAGMA guard makes the ALTERs idempotent, so a rewind with the
  // columns still present must not raise "duplicate column name".
  expect(() => applyMigrations(db)).not.toThrow();
  expect(readSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
  db.close();
});
