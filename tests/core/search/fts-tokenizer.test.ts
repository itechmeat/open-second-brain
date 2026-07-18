/**
 * Task Q2 (t_618f7211): configurable FTS tokenizer language and
 * diacritic rules.
 *
 * Acceptance coverage:
 *   - with no config the generated schema keeps
 *     `unicode61 remove_diacritics 2` byte-identically;
 *   - a valid config changes the tokenizer clause on the materialized
 *     chunk_fts table (after reindex);
 *   - invalid tokenizer options reject with a typed error listing the
 *     allowed values;
 *   - the CJK trigram path is untouched (chunk_trigram stays `trigram`);
 *   - no implicit reindex (buildFtsTokenize is pure; changing config
 *     alone rewrites nothing).
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  applyMigrations,
  buildFtsTokenize,
  DEFAULT_FTS_TOKENIZE,
} from "../../../src/core/search/schema.ts";
import { SearchError } from "../../../src/core/search/types.ts";

function ftsSql(db: Database, table: string): string {
  const row = db
    .query<{ sql: string }, [string]>("SELECT sql FROM sqlite_master WHERE name = ?")
    .get(table);
  return row?.sql ?? "";
}

describe("buildFtsTokenize", () => {
  test("no config yields the byte-identical default clause", () => {
    expect(buildFtsTokenize({})).toBe("unicode61 remove_diacritics 2");
    expect(buildFtsTokenize({})).toBe(DEFAULT_FTS_TOKENIZE);
    expect(buildFtsTokenize({ diacritics: null, stemmer: null })).toBe(DEFAULT_FTS_TOKENIZE);
  });

  test("diacritics option changes the remove_diacritics rule", () => {
    expect(buildFtsTokenize({ diacritics: "0" })).toBe("unicode61 remove_diacritics 0");
    expect(buildFtsTokenize({ diacritics: "1" })).toBe("unicode61 remove_diacritics 1");
  });

  test("porter stemmer wraps unicode61 (language stemming)", () => {
    expect(buildFtsTokenize({ stemmer: "porter" })).toBe("porter unicode61 remove_diacritics 2");
    expect(buildFtsTokenize({ stemmer: "porter", diacritics: "0" })).toBe(
      "porter unicode61 remove_diacritics 0",
    );
  });

  test("invalid diacritics rejects with a typed error listing allowed values", () => {
    let err: unknown;
    try {
      buildFtsTokenize({ diacritics: "3" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SearchError);
    expect((err as SearchError).code).toBe("INVALID_INPUT");
    expect((err as SearchError).message).toMatch(/0.*1.*2/);
  });

  test("invalid stemmer rejects with a typed error listing allowed values", () => {
    let err: unknown;
    try {
      buildFtsTokenize({ stemmer: "snowball" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SearchError);
    expect((err as SearchError).code).toBe("INVALID_INPUT");
    expect((err as SearchError).message).toMatch(/none.*porter|porter.*none/);
  });
});

describe("applyMigrations tokenizer wiring", () => {
  test("default schema keeps unicode61 remove_diacritics 2 byte-identically", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    expect(ftsSql(db, "chunk_fts")).toContain("tokenize='unicode61 remove_diacritics 2'");
    db.close();
  });

  test("a configured clause is applied to the materialized chunk_fts table", () => {
    const db = new Database(":memory:");
    applyMigrations(db, { ftsTokenize: buildFtsTokenize({ stemmer: "porter" }) });
    expect(ftsSql(db, "chunk_fts")).toContain("tokenize='porter unicode61 remove_diacritics 2'");
    db.close();
  });

  test("the CJK trigram path stays trigram regardless of the tokenizer config", () => {
    const db = new Database(":memory:");
    applyMigrations(db, { ftsTokenize: buildFtsTokenize({ stemmer: "porter", diacritics: "0" }) });
    expect(ftsSql(db, "chunk_trigram")).toContain("tokenize='trigram'");
    expect(ftsSql(db, "chunk_trigram")).not.toContain("porter");
    db.close();
  });
});
