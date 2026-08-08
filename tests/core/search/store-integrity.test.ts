/**
 * The two read-open gates that were never there: the tables and columns a
 * query is about to touch must EXIST (task I), and a store already known to
 * be structurally corrupt must not be answered from (task K).
 *
 * Both fixtures are built to be "parseable": the file opens, `index_state`
 * reads back the current schema version, and ordinary SELECTs succeed. That
 * is exactly the state in which the store used to keep serving answers.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

import { indexVault, reindexVault } from "../../../src/core/search/indexer.ts";
import { openReadOrSelfHeal } from "../../../src/core/search/pipeline/store-open.ts";
import { search } from "../../../src/core/search/search.ts";
import {
  applyMigrations,
  expectedSchemaObjects,
  findSchemaGaps,
  LATEST_SCHEMA_VERSION,
  readSchemaVersion,
} from "../../../src/core/search/schema.ts";
import { Store } from "../../../src/core/search/store.ts";
import {
  INTEGRITY_CHECKED_AT_STATE_KEY,
  INTEGRITY_FAULT_STATE_KEY,
} from "../../../src/core/search/store/state.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  const v = createTempVault("store-integrity");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
});

afterEach(() => {
  cleanup();
});

/** A vault big enough that the index file has data pages past its middle. */
function seedVault(notes: number): void {
  for (let i = 0; i < notes; i++) {
    const body = `The quick brown fox jumps over the lazy dog number ${i}. `.repeat(40);
    writeMd(vault, `Notes/note-${i}.md`, `# Note ${i}\n\n${body}`);
  }
}

/** Age the recorded check stamp past the gate's interval. */
function expireIntegrityStamp(path: string): void {
  const db = new Database(path);
  const long_ago = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  db.run("UPDATE index_state SET value = ? WHERE key = ?", [
    long_ago,
    INTEGRITY_CHECKED_AT_STATE_KEY,
  ]);
  db.close();
}

/**
 * Overwrite whole pages in the middle of the index file with garbage. The
 * header, the schema and the small metadata tables live on the first pages
 * and stay intact, so the file remains fully parseable.
 */
function corruptMiddlePages(path: string, pages: number): void {
  const db = new Database(path);
  const pageSize = (
    db.query<{ page_size: number }, []>("PRAGMA page_size").get() as { page_size: number }
  ).page_size;
  db.close();
  const size = statSync(path).size;
  const offset = Math.floor(size / 2 / pageSize) * pageSize;
  const fd = openSync(path, "r+");
  try {
    writeSync(fd, Buffer.alloc(pageSize * pages, 0xa5), 0, pageSize * pages, offset);
  } finally {
    closeSync(fd);
  }
}

// ─── Task I: the tables and columns a query is about to touch ────────────────

test("the expected-object manifest is derived from the migrations, not hand-typed", () => {
  const fresh = new Database(":memory:");
  applyMigrations(fresh);

  // The derivation is the frozen MIGRATIONS themselves, so a freshly
  // migrated database has, by construction, no gaps.
  expect(findSchemaGaps(fresh)).toEqual([]);

  const expected = expectedSchemaObjects();
  // Non-vacuous: the manifest covers the real tables and their late-added
  // columns, including the FTS5 shadow tables a query reads through.
  expect(expected.get("documents")?.has("event_anchor_examined")).toBe(true);
  expect(expected.get("chunks")?.has("fts_content")).toBe(true);
  expect(expected.get("chunk_fts_data")?.has("block")).toBe(true);
  expect(expected.has("chunk_entities")).toBe(true);

  // The trigram lane is opt-in and degrades on its own missing table, so it
  // is deliberately NOT required - refusing an index for it would force a
  // reindex that drops every embedding to restore a table nothing needs.
  expect(expected.has("chunk_trigram")).toBe(false);
  expect(expected.has("chunk_trigram_data")).toBe(false);
  // ...and that exception must not spill onto a table that merely shares a
  // prefix with an optional one.
  expect(expected.has("chunk_vec_map")).toBe(true);

  // Demonstrably able to fail: inject a violating fixture.
  fresh.exec("DROP TABLE chunk_entities");
  fresh.exec("ALTER TABLE documents DROP COLUMN event_anchor_source");
  const gaps = findSchemaGaps(fresh);
  expect(gaps).toContainEqual({ table: "chunk_entities", column: null });
  expect(gaps).toContainEqual({ table: "documents", column: "event_anchor_source" });
  fresh.close();
});

test("a current-version index with a dropped TABLE is refused at read-open", async () => {
  const config = makeConfig({ vault, dbPath });
  seedVault(4);
  await indexVault(config);

  const corruptor = new Database(dbPath);
  corruptor.exec("DROP TABLE chunk_entities");
  // Still stamped current — the version gate alone sees nothing wrong.
  expect(readSchemaVersion(corruptor)).toBe(LATEST_SCHEMA_VERSION);
  corruptor.close();

  await expect(Store.open(config, { mode: "read" })).rejects.toMatchObject({
    code: "SCHEMA_MISMATCH",
  });
  await expect(Store.open(config, { mode: "read" })).rejects.toThrow(/chunk_entities/);
  await expect(Store.open(config, { mode: "read" })).rejects.toThrow(/o2b search reindex/);
});

test("a current-version index with a dropped COLUMN is refused at read-open", async () => {
  const config = makeConfig({ vault, dbPath });
  seedVault(4);
  await indexVault(config);

  const corruptor = new Database(dbPath);
  corruptor.exec("ALTER TABLE documents DROP COLUMN event_anchor_source");
  expect(readSchemaVersion(corruptor)).toBe(LATEST_SCHEMA_VERSION);
  corruptor.close();

  await expect(Store.open(config, { mode: "read" })).rejects.toMatchObject({
    code: "SCHEMA_MISMATCH",
  });
  await expect(Store.open(config, { mode: "read" })).rejects.toThrow(
    /documents\.event_anchor_source/,
  );
});

test("a healthy current index still opens for reading", async () => {
  const config = makeConfig({ vault, dbPath });
  seedVault(4);
  await indexVault(config);
  const store = await Store.open(config, { mode: "read" });
  expect(store.schemaVersion()).toBe(LATEST_SCHEMA_VERSION);
  await store.close();
});

// ─── Task K: a corrupt store is not answered from ────────────────────────────

test("a page-corrupted index is structurally corrupt yet fully parseable", async () => {
  const config = makeConfig({ vault, dbPath });
  seedVault(60);
  await indexVault(config);
  corruptMiddlePages(dbPath, 4);

  // The fixture's whole point: nothing about this file LOOKS wrong.
  const probe = new Database(dbPath);
  expect(readSchemaVersion(probe)).toBe(LATEST_SCHEMA_VERSION);
  expect(
    probe.query<{ n: number }, []>("SELECT count(*) AS n FROM chunks").get()?.n,
  ).toBeGreaterThan(0);
  // ...and yet the structural scan condemns it. Damage can either make the
  // scan report a malformed tree or stop it completing; both are faults.
  let verdict: string;
  try {
    verdict = probe
      .query<{ quick_check: string }, []>("PRAGMA quick_check(5)")
      .all()
      .map((r) => r.quick_check)
      .join("\n");
  } catch (e) {
    verdict = e instanceof Error ? e.message : String(e);
  }
  expect(verdict).not.toBe("ok");
  probe.close();
});

test("the write-open integrity gate detects the corruption, records it, and refuses", async () => {
  const config = makeConfig({ vault, dbPath });
  seedVault(60);
  await indexVault(config);
  // The index run just scanned a healthy file, so age that stamp past the
  // interval: this is the next write open after the window closed.
  expireIntegrityStamp(dbPath);
  corruptMiddlePages(dbPath, 4);

  await expect(Store.open(config, { mode: "write" })).rejects.toMatchObject({
    code: "INDEX_UNREADABLE",
  });

  const probe = new Database(dbPath);
  expect(
    probe
      .query<{ value: string }, [string]>("SELECT value FROM index_state WHERE key = ?")
      .get(INTEGRITY_FAULT_STATE_KEY)?.value,
  ).toBeTruthy();
  expect(
    probe
      .query<{ value: string }, [string]>("SELECT value FROM index_state WHERE key = ?")
      .get(INTEGRITY_CHECKED_AT_STATE_KEY)?.value,
  ).toBeTruthy();
  probe.close();
});

test("a read-open refuses a store carrying a recorded integrity fault", async () => {
  const config = makeConfig({ vault, dbPath });
  seedVault(4);
  await indexVault(config);

  const stamper = new Database(dbPath);
  stamper.run("INSERT INTO index_state(key, value, updated_at) VALUES (?,?,?)", [
    INTEGRITY_FAULT_STATE_KEY,
    "Tree 38 page 478: btreeInitPage() returns error code 11",
    new Date().toISOString(),
  ]);
  stamper.close();

  await expect(Store.open(config, { mode: "read" })).rejects.toMatchObject({
    code: "INDEX_UNREADABLE",
  });
  await expect(Store.open(config, { mode: "read" })).rejects.toThrow(/btreeInitPage/);
});

test("a search over a store with a recorded fault self-heals instead of answering", async () => {
  const config = makeConfig({ vault, dbPath });
  writeMd(vault, "Notes/foo.md", "# Foo\n\nThe quick brown fox jumps over the lazy dog.");
  await indexVault(config);

  const stamper = new Database(dbPath);
  stamper.run("INSERT INTO index_state(key, value, updated_at) VALUES (?,?,?)", [
    INTEGRITY_FAULT_STATE_KEY,
    "*** in database main *** Tree 38 page 478 malformed",
    new Date().toISOString(),
  ]);
  stamper.close();

  const outcome = await search(config, { query: "fox" });
  expect(outcome.results.length).toBeGreaterThan(0);

  // The rebuild produced a store with no fault recorded against it.
  const probe = new Database(dbPath);
  expect(
    probe
      .query<{ value: string }, [string]>("SELECT value FROM index_state WHERE key = ?")
      .get(INTEGRITY_FAULT_STATE_KEY),
  ).toBeNull();
  probe.close();
});

test("a passing check clears a stale fault and stamps when it ran", async () => {
  const config = makeConfig({ vault, dbPath });
  writeMd(vault, "Notes/foo.md", "# Foo\n\nfox");
  await indexVault(config);

  const stamper = new Database(dbPath);
  stamper.run("INSERT INTO index_state(key, value, updated_at) VALUES (?,?,?)", [
    INTEGRITY_FAULT_STATE_KEY,
    "stale fault from a previous generation",
    new Date().toISOString(),
  ]);
  // Force the interval gate open again.
  stamper.run("DELETE FROM index_state WHERE key = ?", [INTEGRITY_CHECKED_AT_STATE_KEY]);
  stamper.close();

  const store = await Store.open(config, { mode: "write" });
  expect(store.getState(INTEGRITY_FAULT_STATE_KEY)).toBeNull();
  expect(store.getState(INTEGRITY_CHECKED_AT_STATE_KEY)).toBeTruthy();
  await store.close();
});

test("a self-heal that fails reports why, instead of only the symptom", async () => {
  // An unreadable index (not a sqlite file at all) in a directory the
  // rebuild cannot write its staging database into: the repair fails, and
  // the retry finds the same unreadable file it started with.
  writeMd(vault, "Notes/foo.md", "# Foo\n\nfox");
  const indexDir = dirname(dbPath);
  mkdirSync(indexDir, { recursive: true });
  writeFileSync(dbPath, "this is not a sqlite database");
  const config = makeConfig({ vault, dbPath });

  chmodSync(indexDir, 0o500);
  let failure: Error | null;
  try {
    failure = await openReadOrSelfHeal(config).then(
      (store) => {
        void store.close();
        return null;
      },
      (e: unknown) => e as Error,
    );
  } finally {
    chmodSync(indexDir, 0o700);
  }
  expect(failure).not.toBeNull();
  // Both halves: what is wrong now, and why the repair did not happen.
  expect(failure?.message).toMatch(/the automatic rebuild of/);
  expect(failure?.message).toMatch(/also failed/);
});

// ─── The recorded fault must be honoured wherever the store is opened ────────

/** One `index_state` cell, read without opening a `Store`. */
function readCell(path: string, key: string): string | null {
  const db = new Database(path);
  try {
    return (
      db.query<{ value: string }, [string]>("SELECT value FROM index_state WHERE key = ?").get(key)
        ?.value ?? null
    );
  } finally {
    db.close();
  }
}

/**
 * The state a COMPLETED condemning scan leaves behind, whatever produced
 * it: a fault, and a fresh `integrity_checked_at` stamping when that scan
 * finished. Both `runWriteOpenIntegrityGate` and `o2b search check
 * --integrity` write exactly this pair.
 */
function recordCondemningScan(path: string, fault: string): void {
  const db = new Database(path);
  const now = new Date().toISOString();
  for (const [key, value] of [
    [INTEGRITY_FAULT_STATE_KEY, fault],
    [INTEGRITY_CHECKED_AT_STATE_KEY, now],
  ] as ReadonlyArray<readonly [string, string]>) {
    db.run(
      "INSERT INTO index_state(key, value, updated_at) VALUES (?,?,?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      [key, value, now],
    );
  }
  db.close();
}

test("a write-open refuses a store carrying a recorded integrity fault", async () => {
  const config = makeConfig({ vault, dbPath });
  seedVault(4);
  await indexVault(config);
  recordCondemningScan(dbPath, "Tree 38 page 478: btreeInitPage() returns error code 11");

  // The read open already refuses this file...
  await expect(Store.open(config, { mode: "read" })).rejects.toMatchObject({
    code: "INDEX_UNREADABLE",
  });
  // ...and the write open is the one that matters more, because everything
  // after it WRITES into the condemned file.
  await expect(Store.open(config, { mode: "write" })).rejects.toMatchObject({
    code: "INDEX_UNREADABLE",
  });
  await expect(Store.open(config, { mode: "write" })).rejects.toThrow(/btreeInitPage/);
  await expect(Store.open(config, { mode: "write" })).rejects.toThrow(/o2b search reindex/);
});

test("the write open that condemned the file refuses the NEXT write open too", async () => {
  const config = makeConfig({ vault, dbPath });
  seedVault(60);
  await indexVault(config);
  expireIntegrityStamp(dbPath);
  corruptMiddlePages(dbPath, 4);

  // The scan runs, condemns the file, and records BOTH the fault and a
  // fresh `integrity_checked_at` naming when it finished.
  await expect(Store.open(config, { mode: "write" })).rejects.toMatchObject({
    code: "INDEX_UNREADABLE",
  });
  expect(readCell(dbPath, INTEGRITY_FAULT_STATE_KEY)).toBeTruthy();

  // The next write open falls INSIDE the interval that scan just re-stamped.
  // Skipping the expensive scan is correct; skipping the recorded fault is
  // not - the file is still condemned and still must not be written into.
  await expect(Store.open(config, { mode: "write" })).rejects.toMatchObject({
    code: "INDEX_UNREADABLE",
  });
});

test("a condemned index can still be rebuilt: reindexVault is not blocked by the fault", async () => {
  const config = makeConfig({ vault, dbPath });
  writeMd(vault, "Notes/foo.md", "# Foo\n\nThe quick brown fox jumps over the lazy dog.");
  await indexVault(config);
  recordCondemningScan(dbPath, "*** in database main *** Tree 38 page 478 malformed");

  // The one legitimate escape from the refusal must stay open, or the gate
  // would refuse the repair as well.
  await reindexVault(config);
  expect(readCell(dbPath, INTEGRITY_FAULT_STATE_KEY)).toBeNull();

  const store = await Store.open(config, { mode: "write" });
  await store.close();
});

test("the interval gate really skips the scan: corruption after a pass is not re-detected", async () => {
  const config = makeConfig({ vault, dbPath });
  seedVault(60);
  await indexVault(config); // stamps integrity_checked_at on a healthy store
  corruptMiddlePages(dbPath, 4);

  // Within the interval the multi-second scan does not run again, so this
  // open succeeds. That is the cost trade this design makes, stated as a
  // test rather than left implicit.
  const store = await Store.open(config, { mode: "write" });
  expect(store.getState(INTEGRITY_FAULT_STATE_KEY)).toBeNull();
  await store.close();
});
