/**
 * Lazy self-heal on the search read path: after a plugin upgrade the on-disk
 * index can be a stale schema (SCHEMA_MISMATCH), absent (INDEX_MISSING), or
 * unreadable (INDEX_UNREADABLE — a corrupt or truncated file, or a non-OSB
 * sqlite db at the index path). A search must transparently rebuild once and
 * return results instead of forcing the user to run `o2b search reindex` /
 * `o2b search index`.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, rmSync } from "node:fs";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { Store } from "../../../src/core/search/store.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  const v = createTempVault("selfheal");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
  writeMd(vault, "Notes/foo.md", "# Foo\n\nThe quick brown fox jumps over the lazy dog.");
});

afterEach(() => {
  cleanup();
});

test("SCHEMA_MISMATCH on read self-heals: search rebuilds and returns results", async () => {
  const config = makeConfig({ vault, dbPath });
  await indexVault(config); // valid index at LATEST schema

  // Simulate an index built by an older plugin version.
  const db = new Database(dbPath);
  db.run("UPDATE index_state SET value = '1' WHERE key = 'schema_version'");
  db.close();

  // Without self-heal this throws SCHEMA_MISMATCH; with it, it rebuilds.
  const outcome = await search(config, { query: "fox" });
  expect(outcome.results.length).toBeGreaterThan(0);
});

test("INDEX_MISSING on read self-heals: search builds the index on first use", async () => {
  const config = makeConfig({ vault, dbPath });
  expect(existsSync(dbPath)).toBe(false); // never indexed

  const outcome = await search(config, { query: "fox" });
  expect(outcome.results.length).toBeGreaterThan(0);
  expect(existsSync(dbPath)).toBe(true); // built by the self-heal
});

test("INDEX_UNREADABLE on read self-heals: search rebuilds a corrupt index", async () => {
  const config = makeConfig({ vault, dbPath });
  await indexVault(config); // seed a real index so the path exists

  // Corrupt the index's metadata so a read open fails AFTER the file opens
  // successfully but DURING schema probing: drop the `index_state` table,
  // which makes `readSchemaVersion` throw a raw sqlite error that the read
  // path wraps as INDEX_UNREADABLE (the typed code for "index present but
  // cannot be read"). This is the realistic corruption shape — a partial
  // write or a half-migrated file — as opposed to total byte-level damage.
  const corruptor = new Database(dbPath);
  corruptor.run("DROP TABLE index_state");
  corruptor.close();

  // Sanity: the corruption really does surface as INDEX_UNREADABLE on a
  // raw read open (the pre-self-heal condition).
  await expect(Store.open(config, { mode: "read" })).rejects.toMatchObject({
    code: "INDEX_UNREADABLE",
  });

  // Without self-heal this INDEX_UNREADABLE escapes to the caller; with it,
  // the read path rebuilds once and returns results.
  const outcome = await search(config, { query: "fox" });
  expect(outcome.results.length).toBeGreaterThan(0);
  expect(existsSync(dbPath)).toBe(true); // rebuilt by the self-heal
});

test("a genuinely empty vault returns empty results, not an error", async () => {
  rmSync(`${vault}/Notes/foo.md`, { force: true });
  const config = makeConfig({ vault, dbPath });
  const outcome = await search(config, { query: "fox" });
  expect(outcome.results.length).toBe(0);
});
