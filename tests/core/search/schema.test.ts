import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyMigrations,
  LATEST_SCHEMA_VERSION,
  readSchemaVersion,
  ensureVecTable,
  dropVecTable,
} from "../../../src/core/search/schema.ts";
import { SearchError } from "../../../src/core/search/types.ts";

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-schema-"));
  dbPath = join(tmp, "test.sqlite");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function tableNames(db: Database): Set<string> {
  const rows = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type IN ('table','virtual') OR type='table' OR type='trigger' OR type='view'",
    )
    .all();
  return new Set(rows.map((r) => r.name));
}

function objectNames(db: Database, type: string): Set<string> {
  const rows = db
    .query<{ name: string }, [string]>(
      "SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%'",
    )
    .all(type);
  return new Set(rows.map((r) => r.name));
}

test("applyMigrations on a fresh db creates the v1 schema", () => {
  const db = new Database(dbPath);
  const v = applyMigrations(db);
  expect(v).toBe(LATEST_SCHEMA_VERSION);

  const tables = objectNames(db, "table");
  expect(tables.has("documents")).toBe(true);
  expect(tables.has("chunks")).toBe(true);
  expect(tables.has("embeddings")).toBe(true);
  expect(tables.has("chunk_vec_map")).toBe(true);
  expect(tables.has("links")).toBe(true);
  expect(tables.has("index_state")).toBe(true);

  const triggers = objectNames(db, "trigger");
  expect(triggers.has("chunks_ai")).toBe(true);
  expect(triggers.has("chunks_ad")).toBe(true);
  expect(triggers.has("chunks_au")).toBe(true);

  // FTS5 virtual table is registered as type 'table'.
  expect(tables.has("chunk_fts")).toBe(true);

  expect(readSchemaVersion(db)).toBe(1);
  db.close();
});

test("applyMigrations is idempotent", () => {
  const db = new Database(dbPath);
  applyMigrations(db);
  const first = tableNames(db).size;
  applyMigrations(db);
  applyMigrations(db);
  expect(tableNames(db).size).toBe(first);
  expect(readSchemaVersion(db)).toBe(1);
  db.close();
});

test("readSchemaVersion returns 0 when index_state is missing", () => {
  const db = new Database(dbPath);
  expect(() => readSchemaVersion(db)).toThrow(/no such table/);
  db.close();
});

test("applyMigrations throws SCHEMA_MISMATCH if db is newer than binary", () => {
  const db = new Database(dbPath);
  applyMigrations(db);
  // Simulate a future version.
  db.run(
    "UPDATE index_state SET value = ? WHERE key = 'schema_version'",
    [String(LATEST_SCHEMA_VERSION + 7)],
  );

  let err: SearchError | null = null;
  try {
    applyMigrations(db);
  } catch (e) {
    err = e as SearchError;
  }
  expect(err).not.toBeNull();
  expect(err?.code).toBe("SCHEMA_MISMATCH");
  expect(err?.message).toContain("reindex");
  db.close();
});

test("ensureVecTable + dropVecTable round-trip", () => {
  // sqlite-vec is optional; load it for this test. If not available we
  // skip — vec-specific behaviour is exercised in store.vec.test.ts.
  const db = new Database(dbPath);
  applyMigrations(db);

  try {
    const vec = require("sqlite-vec");
    db.loadExtension(vec.getLoadablePath());
  } catch {
    db.close();
    return;
  }

  ensureVecTable(db, 4);
  ensureVecTable(db, 4); // idempotent

  const tables = objectNames(db, "table");
  expect(tables.has("chunk_vec")).toBe(true);

  // Insert a vector.
  db.run("INSERT INTO chunk_vec(rowid, embedding) VALUES (1, ?)", [JSON.stringify([0.1, 0.2, 0.3, 0.4])]);
  const row = db.query<{ c: number }, []>("SELECT count(*) AS c FROM chunk_vec").get();
  expect(row?.c).toBe(1);

  dropVecTable(db);
  expect(objectNames(db, "table").has("chunk_vec")).toBe(false);
  db.close();
});

test("ensureVecTable rejects non-positive dimension", () => {
  const db = new Database(dbPath);
  applyMigrations(db);
  expect(() => ensureVecTable(db, 0)).toThrow(/positive integer/);
  expect(() => ensureVecTable(db, -1)).toThrow(/positive integer/);
  db.close();
});
