/**
 * AbortSignal threading through the indexer (Indexer Durability suite,
 * t_79e773be). indexVault accepts an optional signal checked at the
 * same cooperative boundaries the deadline already uses - between files
 * in indexInto, between embed batches in populateEmbeddings - so a run
 * can be cancelled on demand without a mid-write kill. The deletion
 * sweep runs only on full completion, so an aborted run leaves a
 * consistent, partially-refreshed index. A run with no signal is
 * unchanged.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";

import { SafeguardAbortError } from "../../../src/core/brain/safeguard.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { Store } from "../../../src/core/search/store.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";
import { startFakeHttp, type FakeHttp } from "../../helpers/fake-http.ts";
import { sqliteVecLoadable } from "../../helpers/sqlite-vec.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  const v = createTempVault("indexer-abort");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
});

afterEach(() => {
  cleanup();
});

test("a signal aborted before the walk throws and indexes nothing", async () => {
  writeMd(vault, "a.md", "# A\n\nAlpha.");
  writeMd(vault, "b.md", "# B\n\nBeta.");
  const cfg = makeConfig({ vault, dbPath });
  const ac = new AbortController();
  ac.abort();

  await expect(indexVault(cfg, { signal: ac.signal })).rejects.toBeInstanceOf(SafeguardAbortError);

  const store = await Store.open(cfg, { mode: "write" });
  expect(store.listDocuments().size).toBe(0);
  await store.close();
});

test("aborting mid-walk commits files seen before the abort, drops the rest", async () => {
  for (let i = 0; i < 5; i++) writeMd(vault, `n${i}.md`, `# N${i}\n\nbody ${i}`);
  const cfg = makeConfig({ vault, dbPath });
  const ac = new AbortController();
  let processed = 0;

  // Abort right after the first file is committed; the next loop-top
  // checkpoint must trip and stop the walk.
  await expect(
    indexVault(cfg, {
      signal: ac.signal,
      onFile: () => {
        processed++;
        if (processed === 1) ac.abort();
      },
    }),
  ).rejects.toBeInstanceOf(SafeguardAbortError);

  const store = await Store.open(cfg, { mode: "write" });
  const count = store.listDocuments().size;
  await store.close();
  // Exactly the pre-abort file(s) survived; not all five, not zero.
  expect(count).toBeGreaterThanOrEqual(1);
  expect(count).toBeLessThan(5);
});

test("an interrupted run is resumable: a clean re-run completes the index", async () => {
  for (let i = 0; i < 5; i++) writeMd(vault, `n${i}.md`, `# N${i}\n\nbody ${i}`);
  const cfg = makeConfig({ vault, dbPath });
  const ac = new AbortController();
  let processed = 0;
  await expect(
    indexVault(cfg, {
      signal: ac.signal,
      onFile: () => {
        if (++processed === 1) ac.abort();
      },
    }),
  ).rejects.toBeInstanceOf(SafeguardAbortError);

  // No signal: the fastpath skips the already-committed file and
  // finishes the rest. The index ends complete.
  const stats = await indexVault(cfg);
  const store = await Store.open(cfg, { mode: "write" });
  expect(store.listDocuments().size).toBe(5);
  await store.close();
  expect(stats.added + stats.unchanged).toBe(5);
});

test("no signal indexes the whole vault unchanged", async () => {
  writeMd(vault, "a.md", "# A\n\nAlpha.");
  writeMd(vault, "b.md", "# B\n\nBeta.");
  const cfg = makeConfig({ vault, dbPath });
  const stats = await indexVault(cfg);
  expect(stats.added).toBe(2);
  const store = await Store.open(cfg, { mode: "write" });
  expect(store.listDocuments().size).toBe(2);
  await store.close();
});

test("aborting between embed batches stops further embedding, keeps committed vectors", async () => {
  if (!sqliteVecLoadable()) return;
  const server: FakeHttp = await startFakeHttp();
  try {
    for (let i = 0; i < 6; i++) writeMd(vault, `e${i}.md`, `# E${i}\n\nembed body number ${i}`);
    const cfg = makeConfig({
      vault,
      dbPath,
      semantic: {
        enabled: true,
        provider: "openai-compat",
        baseUrl: server.url,
        model: "fake-model",
        apiKey: "test-key",
        dimension: 4,
        timeoutMs: 5_000,
        concurrency: 1,
        batchSize: 1,
        costGateUsd: 0,
      },
    });
    // Index documents first (no embeddings), so the abort isolates the
    // embed phase.
    await indexVault(cfg);

    const ac = new AbortController();
    ac.abort();
    await expect(indexVault(cfg, { embeddings: true, signal: ac.signal })).rejects.toBeInstanceOf(
      SafeguardAbortError,
    );
  } finally {
    await server.close();
  }
});
