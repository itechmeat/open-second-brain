/**
 * Schema migration v9 -> v10: the `documents.authored_at` column
 * (conversation chronology, t_347e8224). v10 adds a nullable
 * `authored_at INTEGER` column carrying the transcript turn instant a
 * session-imported note was authored at. Additive and reindex-safe:
 * existing rows default to NULL until a reindex repopulates it from the
 * `authored_at` frontmatter field.
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

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-mig-v10-"));
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

test("latest schema version is 10", () => {
  expect(LATEST_SCHEMA_VERSION).toBe(10);
});

test("fresh migration reaches latest with the authored_at column", () => {
  const db = new Database(dbPath);
  expect(applyMigrations(db)).toBe(LATEST_SCHEMA_VERSION);
  expect(hasColumn(db, "documents", "authored_at")).toBe(true);
  db.close();
});

test("a v9 index upgrades to v10 and preserves existing rows (authored_at NULL)", () => {
  const db = new Database(dbPath);
  applyMigrations(db); // -> latest
  db.run(
    "INSERT INTO documents(id, path, basename, title, content_hash, mtime, size, created_at, updated_at, indexed_at) " +
      "VALUES (1, 'notes/alpha.md', 'alpha', 'A', 'h', 1, 1, 't', 't', 't')",
  );
  // Simulate an older v9 index: drop the column and rewind the version.
  db.run("ALTER TABLE documents DROP COLUMN authored_at");
  db.run("UPDATE index_state SET value = '9' WHERE key = 'schema_version'");
  expect(readSchemaVersion(db)).toBe(9);

  expect(applyMigrations(db)).toBe(LATEST_SCHEMA_VERSION);
  expect(hasColumn(db, "documents", "authored_at")).toBe(true);
  const row = db
    .query<{ id: number; authored_at: number | null }, []>(
      "SELECT id, authored_at FROM documents WHERE id = 1",
    )
    .get();
  expect(row).toEqual({ id: 1, authored_at: null });
  db.close();
});
