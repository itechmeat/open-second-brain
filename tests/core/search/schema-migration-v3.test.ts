/**
 * Schema migration v2 -> v3 (typed graph semantics). v3 adds a nullable
 * `relation` column to the `links` table so an edge can carry a semantic
 * relation type (related / extends / contradicts / superseded_by / ...)
 * orthogonal to its syntactic `link_type`. A fresh index lands at v3; an
 * existing v2 index upgrades cleanly without losing link rows.
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
  tmp = mkdtempSync(join(tmpdir(), "osb-mig-v3-"));
  dbPath = join(tmp, "test.sqlite");
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function linksColumns(db: Database): string[] {
  return db
    .query<{ name: string }, []>("PRAGMA table_info(links)")
    .all()
    .map((r) => r.name);
}

test("fresh migration reaches v3 and links carries a relation column", () => {
  const db = new Database(dbPath);
  expect(applyMigrations(db)).toBe(3);
  expect(LATEST_SCHEMA_VERSION).toBe(3);
  expect(linksColumns(db)).toContain("relation");
  db.close();
});

test("applyMigrations is idempotent at the latest version", () => {
  const db = new Database(dbPath);
  expect(applyMigrations(db)).toBe(3);
  // Re-running must not throw and must not double-add the column.
  expect(applyMigrations(db)).toBe(3);
  expect(linksColumns(db).filter((c) => c === "relation")).toHaveLength(1);
  db.close();
});

test("a v2 index upgrades to v3, adding relation and preserving link rows", () => {
  const db = new Database(dbPath);
  applyMigrations(db); // -> v3
  db.run(
    "INSERT INTO documents(id, path, title, content_hash, mtime, size, created_at, updated_at, indexed_at) " +
      "VALUES (1, 'a.md', 'A', 'h', 1, 1, 't', 't', 't')",
  );
  db.run(
    "INSERT INTO links(id, source_document_id, source_chunk_id, target_path, link_text, link_type, created_at) " +
      "VALUES (1, 1, NULL, 'b.md', 'B', 'wikilink', 't')",
  );
  // Simulate an older v2 index: drop the new column and rewind the version.
  db.run("ALTER TABLE links DROP COLUMN relation");
  db.run("UPDATE index_state SET value = '2' WHERE key = 'schema_version'");
  expect(readSchemaVersion(db)).toBe(2);
  expect(linksColumns(db)).not.toContain("relation");

  expect(applyMigrations(db)).toBe(3);
  expect(linksColumns(db)).toContain("relation");
  // The pre-existing link row survives, with a NULL relation.
  const row = db
    .query<{ c: number; relation: string | null }, []>(
      "SELECT count(*) AS c, relation FROM links WHERE id = 1",
    )
    .get();
  expect(row?.c).toBe(1);
  expect(row?.relation).toBeNull();
  db.close();
});
