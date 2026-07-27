/**
 * The trigram candidate lane is a BROADENER: it only ever adds to a pool
 * the keyword lane already filled. So a fault in it degrades the lane and
 * never the query - but visibly, with a `trigram_degraded` warning on the
 * outcome, next to `hybrid_degraded` for the semantic lane. The one
 * exception is a `chunk_trigram` shadow that is simply absent (a store
 * migrated to v9 but never rebuilt): the table is optional, and that case
 * stays silent.
 */

import { test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import {
  isMissingTrigramTable,
  trigramCandidates,
} from "../../../src/core/search/store/trigram.ts";
import { rebuildFtsIndexWithWriterLock } from "../../../src/core/search/store/keyword.ts";
import { acquireWriterLockSync } from "../../../src/core/search/store/writer-lock.ts";
import { SearchError } from "../../../src/core/search/types.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

/** A real v9 index over two documents, built by the real indexer. */
async function indexedVault(): Promise<{ vault: string; dbPath: string }> {
  const v = createTempVault("trigram-degrade");
  cleanups.push(v.cleanup);
  // "Reindexing" holds the substring "index" that the word tokenizer misses,
  // and is itself a whole word the keyword lane DOES match.
  writeMd(v.vault, "a.md", "# Ops\n\nReindexing the vault can be slow on large corpora.");
  writeMd(v.vault, "b.md", "# Turtles\n\nGreen turtles migrate across oceans.");
  await indexVault(makeConfig({ vault: v.vault, dbPath: v.dbPath }), {});
  return { vault: v.vault, dbPath: v.dbPath };
}

function openRaw(dbPath: string, opts: { readonly readOnly?: boolean } = {}): Database {
  const db =
    opts.readOnly === true ? new Database(dbPath, { readonly: true }) : new Database(dbPath);
  cleanups.push(() => db.close());
  return db;
}

function trigramConfig(vault: string, dbPath: string) {
  return makeConfig({
    vault,
    dbPath,
    trigramPrefilterEnabled: true,
    trigramPrefilterMinChunks: 0,
  });
}

/** Leaves `chunk_trigram` absent - the documented optional-table case. */
function dropTrigramShadow(dbPath: string): void {
  const db = openRaw(dbPath);
  db.exec("DROP TABLE chunk_trigram");
}

/**
 * Leaves a `chunk_trigram` that is NOT an FTS5 shadow - the shape a
 * half-applied migration or a replicated-then-repaired index leaves
 * behind. SQLite rejects the MATCH against it.
 */
function breakTrigramShadow(dbPath: string): void {
  const db = openRaw(dbPath);
  db.exec("DROP TABLE chunk_trigram");
  db.exec("CREATE TABLE chunk_trigram (id INTEGER PRIMARY KEY, fts_content TEXT)");
}

// ─── the predicate ───────────────────────────────────────────────────────────

test("only chunk_trigram itself reads as an absent shadow", () => {
  expect(isMissingTrigramTable("no such table: chunk_trigram")).toBe(true);
  expect(isMissingTrigramTable("no such table: main.chunk_trigram")).toBe(true);
});

test("a lost FTS5 shadow table does not read as an absent shadow", () => {
  // These name a shadow the index HAS lost: corruption, not an index that
  // never had the optional table.
  for (const shadow of ["data", "idx", "content", "docsize"]) {
    expect(isMissingTrigramTable(`no such table: main.chunk_trigram_${shadow}`)).toBe(false);
    expect(isMissingTrigramTable(`no such table: chunk_trigram_${shadow}`)).toBe(false);
  }
});

// ─── the lane, against induced faults ────────────────────────────────────────

test("an absent chunk_trigram shadow stays silent", async () => {
  const { dbPath } = await indexedVault();
  dropTrigramShadow(dbPath);
  const db = openRaw(dbPath);

  const outcome = trigramCandidates(db, '"index"', { limit: 10 });

  expect(outcome.hits).toEqual([]);
  expect(outcome.warnings).toEqual([]);
});

test("a chunk_trigram that is not an FTS5 shadow degrades with a warning", async () => {
  const { dbPath } = await indexedVault();
  breakTrigramShadow(dbPath);
  const db = openRaw(dbPath);

  const outcome = trigramCandidates(db, '"index"', { limit: 10 });

  expect(outcome.hits).toEqual([]);
  expect(outcome.warnings).toEqual([
    "trigram_degraded [shadow_incomplete]: trigram candidate lane skipped; keyword candidates unaffected",
  ]);
});

test("a writer holding the database lock degrades the lane", async () => {
  const { dbPath } = await indexedVault();
  // Real contention, not a stubbed error: a second connection holds an
  // EXCLUSIVE transaction while the reader - with the wait shortened to
  // zero so the test does not sit out a busy timeout - runs the lookup.
  const writer = openRaw(dbPath);
  writer.exec("PRAGMA journal_mode = DELETE");
  const reader = openRaw(dbPath, { readOnly: true });
  reader.exec("PRAGMA busy_timeout = 0");
  expect(trigramCandidates(reader, '"index"', { limit: 10 }).warnings).toEqual([]);

  writer.exec("BEGIN EXCLUSIVE");
  const outcome = trigramCandidates(reader, '"index"', { limit: 10 });
  writer.exec("ROLLBACK");

  expect(outcome.hits).toEqual([]);
  expect(outcome.warnings).toEqual([
    "trigram_degraded [locked]: trigram candidate lane skipped; keyword candidates unaffected",
  ]);
  // And the lane answers again once the writer lets go.
  expect(trigramCandidates(reader, '"index"', { limit: 10 }).warnings).toEqual([]);
});

test("the warning carries no query text", async () => {
  const { dbPath } = await indexedVault();
  const db = openRaw(dbPath);

  // An FTS5 syntax error is the one failure whose message echoes the MATCH
  // expression, which is built from the caller's own query.
  const outcome = trigramCandidates(db, '"hunterterm" AND AND', { limit: 10 });

  expect(outcome.hits).toEqual([]);
  expect(outcome.warnings.length).toBe(1);
  expect(outcome.warnings[0]).not.toContain("hunterterm");
});

// ─── end to end: the search survives ─────────────────────────────────────────

test("a search whose trigram lane fails still returns the keyword-lane results", async () => {
  const { vault, dbPath } = await indexedVault();
  const cfg = trigramConfig(vault, dbPath);
  const healthy = await search(cfg, { query: "reindexing", limit: 10 });
  expect(healthy.results.map((r) => r.path)).toContain("a.md");

  breakTrigramShadow(dbPath);
  const degraded = await search(cfg, { query: "reindexing", limit: 10 });

  expect(degraded.results.map((r) => r.path)).toEqual(healthy.results.map((r) => r.path));
  expect(degraded.warnings.some((w) => w.startsWith("trigram_degraded ["))).toBe(true);
});

test("a search over an absent trigram shadow is byte-identical to a healthy one", async () => {
  const { vault, dbPath } = await indexedVault();
  const cfg = trigramConfig(vault, dbPath);
  const healthy = await search(cfg, { query: "reindexing", limit: 10 });

  dropTrigramShadow(dbPath);
  const absent = await search(cfg, { query: "reindexing", limit: 10 });

  expect(absent.results.map((r) => r.path)).toEqual(healthy.results.map((r) => r.path));
  expect(absent.warnings).toEqual(healthy.warnings);
  expect(absent.warnings.some((w) => w.startsWith("trigram_degraded"))).toBe(false);
});

// ─── the writer-lock guard travels with its function ─────────────────────────

test("rebuildFtsIndexWithWriterLock skips the lock when the caller already holds it", async () => {
  const { dbPath } = await indexedVault();
  const db = openRaw(dbPath);
  const release = acquireWriterLockSync(dbPath);
  try {
    // A caller that holds the writer lock must not re-enter it.
    expect(() => rebuildFtsIndexWithWriterLock(db, dbPath, true)).not.toThrow();
    // Without the guard the same call contends with the held lock.
    expect(() => rebuildFtsIndexWithWriterLock(db, dbPath, false)).toThrow(SearchError);
  } finally {
    release();
  }
});

test("rebuildFtsIndexWithWriterLock takes the lock when the caller does not hold it", async () => {
  const { dbPath } = await indexedVault();
  const db = openRaw(dbPath);
  expect(() => rebuildFtsIndexWithWriterLock(db, dbPath, false)).not.toThrow();
});
