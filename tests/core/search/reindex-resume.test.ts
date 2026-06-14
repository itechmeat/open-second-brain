/**
 * Opt-in resumable staged reindex (Indexer Durability suite,
 * t_672c751e). reindexVault builds into brain.sqlite.new then atomically
 * swaps. Today an interrupted rebuild discards all progress. With
 * search_resume_reindex on, a compatible in-progress .new is resumed
 * via the incremental fastpath instead of rebuilt from scratch; a
 * signature mismatch (schema / chunk params / embedding signature)
 * discards it. The signature marker lives in the staging DB's
 * index_state KV (no schema migration) and is cleared before the swap,
 * so the live index never carries staging state. Flag off keeps the
 * always-fresh rebuild byte-for-byte.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { SafeguardAbortError } from "../../../src/core/brain/safeguard.ts";
import { indexVault, reindexVault } from "../../../src/core/search/indexer.ts";
import { Store } from "../../../src/core/search/store.ts";
import type { ResolvedSearchConfig } from "../../../src/core/search/types.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  const v = createTempVault("reindex-resume");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
  for (let i = 0; i < 6; i++) writeMd(vault, `n${i}.md`, `# N${i}\n\nbody number ${i}`);
});

afterEach(() => {
  cleanup();
});

function cfgWith(overrides: Partial<ResolvedSearchConfig>): ResolvedSearchConfig {
  return Object.freeze({ ...makeConfig({ vault, dbPath }), ...overrides });
}

async function docCount(cfg: ResolvedSearchConfig): Promise<number> {
  const store = await Store.open(cfg, { mode: "write" });
  const n = store.listDocuments().size;
  await store.close();
  return n;
}

/** Drive a reindex that aborts after the first committed file, leaving
 * a partial staging .new behind. */
async function partialReindex(cfg: ResolvedSearchConfig): Promise<void> {
  const ac = new AbortController();
  let processed = 0;
  await expect(
    reindexVault(cfg, {
      signal: ac.signal,
      onFile: () => {
        if (++processed === 1) ac.abort();
      },
    }),
  ).rejects.toBeInstanceOf(SafeguardAbortError);
  expect(existsSync(`${dbPath}.new`)).toBe(true);
}

test("flag off: an interrupted rebuild leaves no resumable state and a clean rebuild succeeds", async () => {
  const cfg = cfgWith({ resumeReindex: false });
  // A stray .new from a prior crash must be discarded, not trusted.
  mkdirSync(dirname(dbPath), { recursive: true });
  writeFileSync(`${dbPath}.new`, "garbage-not-a-sqlite-db");
  const stats = await reindexVault(cfg);
  expect(stats.added).toBe(6);
  expect(await docCount(cfg)).toBe(6);
});

test("flag on: resume completes the partial build without reprocessing committed docs", async () => {
  const cfg = cfgWith({ resumeReindex: true });
  await partialReindex(cfg);

  // Resume: the fastpath skips the already-committed doc(s) (counted as
  // unchanged), so a from-scratch rebuild (all 'added') is ruled out.
  const stats = await reindexVault(cfg);
  expect(stats.unchanged).toBeGreaterThanOrEqual(1);
  expect(stats.added + stats.unchanged).toBe(6);
  expect(await docCount(cfg)).toBe(6);
  // Staging is gone after the swap.
  expect(existsSync(`${dbPath}.new`)).toBe(false);
});

test("flag on: a signature mismatch discards the staging build and rebuilds fresh", async () => {
  await partialReindex(cfgWith({ resumeReindex: true }));
  // Change a chunk parameter: the staging signature no longer matches.
  const drifted = cfgWith({ resumeReindex: true, chunkSize: 64, chunkOverlap: 8 });
  const stats = await reindexVault(drifted);
  // No resume: every file is processed fresh.
  expect(stats.added).toBe(6);
  expect(stats.unchanged).toBe(0);
  expect(await docCount(drifted)).toBe(6);
});

test("the swapped live index carries no staging signature marker", async () => {
  const cfg = cfgWith({ resumeReindex: true });
  await reindexVault(cfg);
  const store = await Store.open(cfg, { mode: "write" });
  expect(store.getState("reindex_signature")).toBeNull();
  await store.close();
});

test("flag on with no prior staging behaves like a normal full reindex", async () => {
  const cfg = cfgWith({ resumeReindex: true });
  await indexVault(cfg); // seed a live index first
  const stats = await reindexVault(cfg);
  expect(stats.added).toBe(6);
  expect(await docCount(cfg)).toBe(6);
});
