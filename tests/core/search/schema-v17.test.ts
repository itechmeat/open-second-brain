/**
 * Schema v17 (brain store index, design D5): the per-shard watermark
 * table, the `records` table, the derived `documents.source` column and
 * the index generation the change probe binds its watermarks to.
 *
 * Pinned here: a fresh index and an index upgraded in place from v16 end
 * with the same tables, every existing document keeps its rows, and the
 * source column tells a user note from a page of the legacy `Brain/` tree
 * and from a store record without any write by the indexer.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { indexVault } from "../../../src/core/search/indexer.ts";
import {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  applyMigrations,
  readSchemaVersion,
} from "../../../src/core/search/schema.ts";
import { STORE_INDEX_GENERATION_KEY } from "../../../src/core/search/brain-store/constants.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("schema-v17"));
});
afterEach(() => cleanup());

function tables(db: Database): Set<string> {
  return new Set(
    db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name),
  );
}

function sourceOf(db: Database, path: string): string | null {
  return (
    db.query<{ source: string }, [string]>("SELECT source FROM documents WHERE path = ?").get(path)
      ?.source ?? null
  );
}

/** Undo v17 and stamp v16, as a v16 binary left the file. */
function rewindToV16(): void {
  const db = new Database(dbPath);
  try {
    db.exec("DROP TABLE IF EXISTS records");
    db.exec("DROP TABLE IF EXISTS store_watermarks");
    db.exec("ALTER TABLE documents DROP COLUMN source");
    db.query("DELETE FROM index_state WHERE key = ?").run(STORE_INDEX_GENERATION_KEY);
    db.query("UPDATE index_state SET value = '16' WHERE key = 'schema_version'").run();
  } finally {
    db.close();
  }
}

describe("schema v17", () => {
  test("is the latest migration", () => {
    expect(LATEST_SCHEMA_VERSION).toBe(17);
    expect(MIGRATIONS[MIGRATIONS.length - 1]!.version).toBe(17);
  });

  test("a fresh index carries the store tables and an index generation", () => {
    const db = new Database(":memory:");
    try {
      expect(applyMigrations(db)).toBe(17);
      const present = tables(db);
      expect(present.has("records")).toBe(true);
      expect(present.has("store_watermarks")).toBe(true);
      const generation = db
        .query<{ value: string }, [string]>("SELECT value FROM index_state WHERE key = ?")
        .get(STORE_INDEX_GENERATION_KEY)?.value;
      expect(generation).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    } finally {
      db.close();
    }
  });

  test("the source column separates notes, the legacy Brain tree and store records", async () => {
    writeMd(vault, "notes/heron.md", "# Heron\n\nA note about herons.\n");
    writeMd(vault, "Brain/signals/sig-1.md", "# Signal\n\nA brain signal.\n");
    writeMd(vault, "Brainstorm/idea.md", "# Idea\n\nA user note that shares a prefix.\n");
    await indexVault(makeConfig({ vault, dbPath }));
    const db = new Database(dbPath);
    try {
      db.query(
        "INSERT INTO documents(path, basename, title, content_hash, mtime, size, created_at, updated_at, indexed_at) " +
          "VALUES ('.brain-store/shared/01J00000000000000000000000', 'x', NULL, 'h', 0, 0, '', '', '')",
      ).run();
      expect(sourceOf(db, "notes/heron.md")).toBe("note");
      expect(sourceOf(db, "Brainstorm/idea.md")).toBe("note");
      expect(sourceOf(db, "Brain/signals/sig-1.md")).toBe("brain");
      expect(sourceOf(db, ".brain-store/shared/01J00000000000000000000000")).toBe("brain");
    } finally {
      db.close();
    }
  });

  test("a v16 index upgrades in place and keeps its documents", async () => {
    writeMd(vault, "notes/heron.md", "# Heron\n\nA note about herons.\n");
    writeMd(vault, "Brain/signals/sig-1.md", "# Signal\n\nA brain signal.\n");
    await indexVault(makeConfig({ vault, dbPath }));
    rewindToV16();
    const db = new Database(dbPath);
    try {
      expect(readSchemaVersion(db)).toBe(16);
      expect(applyMigrations(db)).toBe(17);
      expect(tables(db).has("records")).toBe(true);
      expect(sourceOf(db, "notes/heron.md")).toBe("note");
      expect(sourceOf(db, "Brain/signals/sig-1.md")).toBe("brain");
      // Running it again changes nothing.
      expect(applyMigrations(db)).toBe(17);
    } finally {
      db.close();
    }
  });
});
