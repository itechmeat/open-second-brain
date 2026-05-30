/**
 * Schema migration v3 -> latest, with v4 query-cache coverage. v4 adds a
 * `query_cache` table backing the persistent, corpus-generation-gated query
 * result cache. Later migrations may run after it; this test keeps locking
 * that a v3 index upgrades without losing any prior data.
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
  tmp = mkdtempSync(join(tmpdir(), "osb-mig-v4-"));
  dbPath = join(tmp, "test.sqlite");
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function hasTable(db: Database, name: string): boolean {
  return (
    db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
      )
      .get(name) !== null
  );
}

function hasColumn(db: Database, table: string, name: string): boolean {
  return db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .some((c) => c.name === name);
}

test("fresh migration reaches latest and creates query_cache", () => {
  const db = new Database(dbPath);
  expect(applyMigrations(db)).toBe(LATEST_SCHEMA_VERSION);
  expect(hasTable(db, "query_cache")).toBe(true);
  expect(hasColumn(db, "chunks", "fts_content")).toBe(true);
  db.close();
});

test("applyMigrations is idempotent at latest", () => {
  const db = new Database(dbPath);
  expect(applyMigrations(db)).toBe(LATEST_SCHEMA_VERSION);
  expect(applyMigrations(db)).toBe(LATEST_SCHEMA_VERSION);
  db.close();
});

test("a v3 index upgrades to latest preserving prior data", () => {
  const db = new Database(dbPath);
  applyMigrations(db); // -> latest
  db.run(
    "INSERT INTO documents(id, path, title, content_hash, mtime, size, created_at, updated_at, indexed_at) " +
      "VALUES (1, 'a.md', 'A', 'h', 1, 1, 't', 't', 't')",
  );
  // Simulate an older v3 index: drop query_cache and rewind the version.
  db.run("DROP TABLE query_cache");
  db.run("UPDATE index_state SET value = '3' WHERE key = 'schema_version'");
  expect(readSchemaVersion(db)).toBe(3);
  expect(hasTable(db, "query_cache")).toBe(false);

  expect(applyMigrations(db)).toBe(LATEST_SCHEMA_VERSION);
  expect(hasTable(db, "query_cache")).toBe(true);
  expect(hasColumn(db, "chunks", "fts_content")).toBe(true);
  const row = db.query<{ c: number }, []>("SELECT count(*) AS c FROM documents").get();
  expect(row?.c).toBe(1);
  db.close();
});

test("a newer-than-latest index still raises SCHEMA_MISMATCH", () => {
  const db = new Database(dbPath);
  applyMigrations(db);
  db.run("UPDATE index_state SET value = '999' WHERE key = 'schema_version'");
  expect(() => applyMigrations(db)).toThrow(/newer than this binary/);
  db.close();
});
