/**
 * Schema migration v7 -> v8: the `documents.basename` column (hot-path
 * performance). v8 adds a `basename` column + `idx_documents_basename`
 * and backfills it from the existing `path` values so a migrated (not
 * yet reindexed) index resolves dangling wikilinks immediately.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyMigrations,
  documentBasename,
  LATEST_SCHEMA_VERSION,
  readSchemaVersion,
} from "../../../src/core/search/schema.ts";

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-mig-v8-"));
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

function hasIndex(db: Database, name: string): boolean {
  return (
    db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name = ?",
      )
      .get(name) !== null
  );
}

test("documentBasename strips the final path segment and .md", () => {
  expect(documentBasename("Brain/notes/alpha.md")).toBe("alpha");
  expect(documentBasename("alpha.md")).toBe("alpha");
  expect(documentBasename("a/b/c.md")).toBe("c");
  expect(documentBasename("no-extension")).toBe("no-extension");
});

test("fresh migration reaches latest with basename column and index", () => {
  const db = new Database(dbPath);
  expect(applyMigrations(db)).toBe(LATEST_SCHEMA_VERSION);
  expect(hasColumn(db, "documents", "basename")).toBe(true);
  expect(hasIndex(db, "idx_documents_basename")).toBe(true);
  db.close();
});

test("a v7 index upgrades to v8 and backfills basename from path", () => {
  const db = new Database(dbPath);
  applyMigrations(db); // -> latest
  // Seed rows, then simulate an older v7 index: drop the column + index
  // and rewind the version so the v8 migration re-runs the backfill.
  db.run(
    "INSERT INTO documents(id, path, basename, title, content_hash, mtime, size, created_at, updated_at, indexed_at) " +
      "VALUES (1, 'notes/alpha.md', NULL, 'A', 'h', 1, 1, 't', 't', 't')",
  );
  db.run(
    "INSERT INTO documents(id, path, basename, title, content_hash, mtime, size, created_at, updated_at, indexed_at) " +
      "VALUES (2, 'top.md', NULL, 'T', 'h', 1, 1, 't', 't', 't')",
  );
  db.run("DROP INDEX idx_documents_basename");
  db.run("UPDATE documents SET basename = NULL");
  db.run("UPDATE index_state SET value = '7' WHERE key = 'schema_version'");
  expect(readSchemaVersion(db)).toBe(7);

  expect(applyMigrations(db)).toBe(LATEST_SCHEMA_VERSION);
  expect(hasIndex(db, "idx_documents_basename")).toBe(true);
  const rows = db
    .query<{ id: number; basename: string }, []>("SELECT id, basename FROM documents ORDER BY id")
    .all();
  expect(rows).toEqual([
    { id: 1, basename: "alpha" },
    { id: 2, basename: "top" },
  ]);
  db.close();
});
