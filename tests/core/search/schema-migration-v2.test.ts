/**
 * Schema migration v1 -> v2 (v0.13.0). v2 adds the `chunk_entities`
 * table feeding entity-boosted retrieval. A fresh index lands at v2; an
 * existing v1 index upgrades cleanly without losing data.
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
  tmp = mkdtempSync(join(tmpdir(), "osb-mig-v2-"));
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

test("fresh migration reaches the latest version and creates chunk_entities", () => {
  const db = new Database(dbPath);
  expect(applyMigrations(db)).toBe(LATEST_SCHEMA_VERSION);
  expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(2);
  expect(hasTable(db, "chunk_entities")).toBe(true);
  db.close();
});

test("a v1 index upgrades to v2, adding chunk_entities and preserving data", () => {
  const db = new Database(dbPath);
  applyMigrations(db); // -> v2
  // Seed a document + chunk, then simulate an older v1 index by dropping
  // the v2 table and rewinding the recorded version.
  db.run(
    "INSERT INTO documents(id, path, title, content_hash, mtime, size, created_at, updated_at, indexed_at) " +
      "VALUES (1, 'a.md', 'A', 'h', 1, 1, 't', 't', 't')",
  );
  db.run(
    "INSERT INTO chunks(id, document_id, chunk_index, content, content_hash, start_line, end_line, token_count, created_at, updated_at) " +
      "VALUES (1, 1, 0, 'body', 'c', 1, 1, 1, 't', 't')",
  );
  db.run("DROP TABLE chunk_entities");
  db.run("UPDATE index_state SET value = '1' WHERE key = 'schema_version'");
  expect(readSchemaVersion(db)).toBe(1);

  expect(applyMigrations(db)).toBe(LATEST_SCHEMA_VERSION);
  expect(hasTable(db, "chunk_entities")).toBe(true);
  // Pre-existing rows survive the upgrade.
  const docs = db.query<{ c: number }, []>("SELECT count(*) AS c FROM documents").get();
  expect(docs?.c).toBe(1);
  db.close();
});
