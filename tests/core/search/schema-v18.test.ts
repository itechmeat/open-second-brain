/**
 * Schema v18 (index size): a fresh index keeps one copy of each chunk's
 * text, builds the trigram shadow only for an opener that reads it, holds
 * no index that repeats the leading columns of another, and stores each
 * chunk entity once. An index at v17 upgrades in place with DDL only and
 * keeps answering from the rows it already holds.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { indexVault } from "../../../src/core/search/indexer.ts";
import {
  DEFAULT_FTS_TOKENIZE,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  applyMigrations,
  readSchemaVersion,
} from "../../../src/core/search/schema.ts";
import { trigramCandidates } from "../../../src/core/search/store/trigram.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("schema-v18"));
});
afterEach(() => cleanup());

function open(path = dbPath): Database {
  return new Database(path);
}

function hasTable(db: Database, name: string): boolean {
  return (
    db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(name)!.n === 1
  );
}

function ftsRowids(db: Database, table: string, match: string): number[] {
  return db
    .query<{ rowid: number }, [string]>(
      `SELECT rowid FROM ${table} WHERE ${table} MATCH ? ORDER BY rowid`,
    )
    .all(match)
    .map((r) => r.rowid);
}

function ftsIntegrityOk(db: Database, table: string): void {
  db.exec(`INSERT INTO ${table}(${table}, rank) VALUES('integrity-check', 1)`);
}

/** Every index of a table as its ordered column list. */
function indexColumns(db: Database, table: string): Array<{ name: string; columns: string[] }> {
  const list = db
    .query<{ name: string }, [string]>("SELECT name FROM pragma_index_list(?)")
    .all(table);
  return list.map((i) => ({
    name: i.name,
    columns: db
      .query<{ name: string }, [string]>("SELECT name FROM pragma_index_info(?) ORDER BY seqno")
      .all(i.name)
      .map((c) => c.name),
  }));
}

/** Build an index file the way a v17 binary left it, with one chunk in it. */
function buildV17Index(withTrigram: boolean): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = open();
  try {
    db.exec("BEGIN");
    for (const m of MIGRATIONS) {
      if (m.version > 17) continue;
      m.up(db, { ftsTokenize: DEFAULT_FTS_TOKENIZE, trigram: true });
    }
    db.run("INSERT INTO index_state(key, value, updated_at) VALUES ('schema_version', '17', '')");
    if (!withTrigram) {
      db.exec(
        "DROP TRIGGER chunks_tri_ai; DROP TRIGGER chunks_tri_ad; DROP TRIGGER chunks_tri_au; DROP TABLE chunk_trigram",
      );
    }
    db.run(
      "INSERT INTO documents(id, path, basename, title, content_hash, mtime, size, created_at, updated_at, indexed_at) " +
        "VALUES (1, 'notes/heron.md', 'heron', NULL, 'h', 0, 0, '', '', '')",
    );
    db.run(
      "INSERT INTO chunks(id, document_id, chunk_index, content, fts_content, content_hash, start_line, end_line, token_count, created_at, updated_at) " +
        "VALUES (1, 1, 0, 'grey herons wade', 'grey herons wade', 'c', 1, 1, 3, '', '')",
    );
    db.run("INSERT INTO chunk_entities(chunk_id, entity) VALUES (1, 'heron')");
    db.exec("COMMIT");
  } finally {
    db.close(true);
  }
}

describe("schema v18", () => {
  test("is the latest migration", () => {
    expect(LATEST_SCHEMA_VERSION).toBe(18);
    expect(MIGRATIONS[MIGRATIONS.length - 1]!.version).toBe(18);
  });

  test("a fresh index stores a chunk's text once and the CJK expansion only where it differs", async () => {
    writeMd(vault, "notes/heron.md", "# Heron\n\nGrey herons wade in shallow water.\n");
    writeMd(vault, "notes/zh.md", "# 苍鹭\n\n苍鹭在浅水中涉水。\n");
    await indexVault(makeConfig({ vault, dbPath }));
    const db = open();
    try {
      const rows = db
        .query<{ content: string; fts_override: string; fts_content: string }, []>(
          "SELECT content, fts_override, fts_content FROM chunks",
        )
        .all();
      const latin = rows.filter((r) => r.content.includes("herons"));
      const han = rows.filter((r) => r.content.includes("苍鹭在"));
      expect(latin.length).toBeGreaterThan(0);
      expect(han.length).toBeGreaterThan(0);
      for (const r of latin) {
        expect(r.fts_override).toBe("");
        expect(r.fts_content).toBe(r.content);
      }
      for (const r of han) {
        expect(r.fts_override).not.toBe("");
        expect(r.fts_content).toBe(r.fts_override);
      }
      expect(ftsRowids(db, "chunk_fts", "herons").length).toBeGreaterThan(0);
      ftsIntegrityOk(db, "chunk_fts");
    } finally {
      db.close(true);
    }
  });

  test("a fresh index has no trigram shadow while nothing reads it", async () => {
    writeMd(vault, "a.md", "# Ops\n\nReindexing the vault can be slow.\n");
    await indexVault(makeConfig({ vault, dbPath }));
    const db = open();
    try {
      expect(hasTable(db, "chunk_trigram")).toBe(false);
      expect(trigramCandidates(db, '"index"', { limit: 10 }).warnings).toEqual([
        "trigram_degraded [not_built]: trigram candidate lane skipped until the next index run " +
          "builds its table (o2b search index); keyword candidates unaffected",
      ]);
    } finally {
      db.close(true);
    }
  });

  test("turning the prefilter on builds the shadow at the next write open, over the chunks already held", async () => {
    writeMd(vault, "a.md", "# Ops\n\nReindexing the vault can be slow.\n");
    await indexVault(makeConfig({ vault, dbPath }));
    await indexVault(makeConfig({ vault, dbPath, trigramPrefilterEnabled: true }));
    const db = open();
    try {
      expect(hasTable(db, "chunk_trigram")).toBe(true);
      const outcome = trigramCandidates(db, '"index"', { limit: 10 });
      expect(outcome.warnings).toEqual([]);
      expect(outcome.hits.length).toBe(1);
      ftsIntegrityOk(db, "chunk_trigram");
    } finally {
      db.close(true);
    }
    // An opener that does not read it keeps it current rather than dropping it.
    writeMd(vault, "b.md", "# More\n\nUnindexable text.\n");
    await indexVault(makeConfig({ vault, dbPath }));
    const again = open();
    try {
      expect(trigramCandidates(again, '"index"', { limit: 10 }).hits.length).toBe(2);
      ftsIntegrityOk(again, "chunk_trigram");
    } finally {
      again.close(true);
    }
  });

  test("no index repeats the leading columns of another index on its table", async () => {
    writeMd(vault, "a.md", "# A\n\nAlpha.\n");
    await indexVault(makeConfig({ vault, dbPath, trigramPrefilterEnabled: true }));
    const db = open();
    try {
      const tables = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL%' AND name NOT LIKE 'sqlite_%'",
        )
        .all()
        .map((t) => t.name);
      const redundant: string[] = [];
      for (const table of tables) {
        const indexes = indexColumns(db, table);
        for (const a of indexes) {
          for (const b of indexes) {
            if (a === b || a.columns.length > b.columns.length) continue;
            if (a.columns.length === b.columns.length && a.name > b.name) continue;
            if (a.columns.every((c, i) => b.columns[i] === c)) redundant.push(`${table}.${a.name}`);
          }
        }
      }
      expect(redundant).toEqual([]);
    } finally {
      db.close(true);
    }
  });

  test("a fresh chunk_entities stores each row once, keyed by its primary key", async () => {
    writeMd(vault, "a.md", "# Heron Notes\n\nGrey Heron and Little Egret.\n");
    await indexVault(makeConfig({ vault, dbPath }));
    const db = open();
    try {
      const sql = db
        .query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name = 'chunk_entities'")
        .get()!.sql;
      expect(sql).toContain("WITHOUT ROWID");
      expect(
        db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM chunk_entities").get()!.n,
      ).toBeGreaterThan(0);
    } finally {
      db.close(true);
    }
  });

  for (const withTrigram of [true, false]) {
    test(`a v17 index ${withTrigram ? "with" : "without"} a trigram shadow upgrades in place and its full-text tables stay in sync`, () => {
      buildV17Index(withTrigram);
      const db = open();
      try {
        expect(readSchemaVersion(db)).toBe(17);
        expect(applyMigrations(db)).toBe(18);
        // The rows written by v17 still answer, through the same tables.
        expect(ftsRowids(db, "chunk_fts", "herons")).toEqual([1]);
        expect(
          db
            .query<{ fts_content: string }, []>("SELECT fts_content FROM chunks WHERE id = 1")
            .get()!.fts_content,
        ).toBe("grey herons wade");
        expect(hasTable(db, "chunk_trigram")).toBe(withTrigram);
        if (withTrigram) expect(ftsRowids(db, "chunk_trigram", '"heron"')).toEqual([1]);
        // A populated table keeps its rows and its shape.
        expect(
          db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM chunk_entities").get()!.n,
        ).toBe(1);
        // Writes after the upgrade keep every full-text table in sync.
        db.run(
          "INSERT INTO chunks(id, document_id, chunk_index, content, fts_override, content_hash, start_line, end_line, token_count, created_at, updated_at) " +
            "VALUES (2, 1, 1, 'egrets fish', '', 'd', 2, 2, 2, '', '')",
        );
        db.run("DELETE FROM chunks WHERE id = 1");
        expect(ftsRowids(db, "chunk_fts", "herons")).toEqual([]);
        expect(ftsRowids(db, "chunk_fts", "egrets")).toEqual([2]);
        ftsIntegrityOk(db, "chunk_fts");
        if (withTrigram) {
          expect(ftsRowids(db, "chunk_trigram", '"egret"')).toEqual([2]);
          ftsIntegrityOk(db, "chunk_trigram");
        }
        // Running it again changes nothing.
        expect(applyMigrations(db)).toBe(18);
      } finally {
        db.close(true);
      }
    });
  }
});
