import { test, expect, beforeEach, afterEach } from "bun:test";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { Store } from "../../../src/core/search/store.ts";
import { SearchError } from "../../../src/core/search/types.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";
import { startFakeHttp, type FakeHttp } from "../../helpers/fake-http.ts";
import { sqliteVecLoadable } from "../../helpers/sqlite-vec.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;
let server: FakeHttp;

beforeEach(async () => {
  const v = createTempVault("indexer-emb");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
  server = await startFakeHttp();
});

afterEach(async () => {
  cleanup();
  await server.close();
});

function semanticConfig(model = "fake-model", dim = 4) {
  return makeConfig({
    vault,
    dbPath,
    semantic: {
      enabled: true,
      provider: "openai-compat",
      baseUrl: server.url,
      model,
      apiKey: "test-key",
      dimension: dim,
      timeoutMs: 5_000,
      concurrency: 2,
      batchSize: 8,
      costGateUsd: 0,
    },
  });
}

test("index --embeddings populates chunk_vec for new chunks", async () => {
  if (!sqliteVecLoadable()) return;
  writeMd(vault, "a.md", "# A\n\nFirst note about something.");
  writeMd(vault, "b.md", "# B\n\nSecond note discussing things.");
  const cfg = semanticConfig();

  const stats = await indexVault(cfg, { embeddings: true });
  expect(stats.embeddingsComputed).toBeGreaterThanOrEqual(2);

  const store = await Store.open(cfg, { mode: "read" });
  const counts = store.counts();
  expect(counts.embeddings).toBe(counts.chunks);
  await store.close();
});

test("unchanged files do NOT trigger re-embedding on the next run", async () => {
  if (!sqliteVecLoadable()) return;
  writeMd(vault, "a.md", "# A\n\nHello.");
  const cfg = semanticConfig();
  await indexVault(cfg, { embeddings: true });
  const before = server.callCount();

  const second = await indexVault(cfg, { embeddings: true });
  expect(second.embeddingsComputed).toBe(0);
  expect(server.callCount()).toBe(before);
});

test("changing the embedding model drops embeddings and the next index repopulates", async () => {
  if (!sqliteVecLoadable()) return;
  writeMd(vault, "a.md", "# A\n\nHello.");
  const first = await indexVault(semanticConfig("modelA", 4), {
    embeddings: true,
  });
  expect(first.embeddingsComputed).toBeGreaterThan(0);

  const before = server.callCount();
  const second = await indexVault(semanticConfig("modelB", 4), {
    embeddings: true,
  });
  // All chunks re-embedded under the new model.
  expect(second.embeddingsComputed).toBeGreaterThan(0);
  expect(server.callCount()).toBeGreaterThan(before);
});

test("--embeddings without a key throws EMBEDDING_KEY_MISSING", async () => {
  writeMd(vault, "a.md", "# A");
  const cfg = makeConfig({
    vault,
    dbPath,
    semantic: {
      enabled: true,
      provider: "openai-compat",
      baseUrl: server.url,
      model: "fake-model",
      apiKey: null,
      dimension: 4,
      timeoutMs: 5_000,
      concurrency: 1,
      batchSize: 8,
      costGateUsd: 0,
    },
  });
  let err: SearchError | null = null;
  try {
    await indexVault(cfg, { embeddings: true });
  } catch (e) {
    err = e as SearchError;
  }
  expect(err?.code).toBe("EMBEDDING_KEY_MISSING");
});

test("--embeddings with semantic disabled throws EMBEDDING_DISABLED", async () => {
  writeMd(vault, "a.md", "# A");
  const cfg = makeConfig({ vault, dbPath }); // semantic.enabled defaults to false
  let err: SearchError | null = null;
  try {
    await indexVault(cfg, { embeddings: true });
  } catch (e) {
    err = e as SearchError;
  }
  expect(err?.code).toBe("EMBEDDING_DISABLED");
});

test("onFile callback fires for every classification", async () => {
  writeMd(vault, "stay.md", "# A");
  writeMd(vault, "go.md", "# B");
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg);

  // Change one, delete another, add a third.
  writeMd(vault, "stay.md", "# A\n\nupdated body.");
  await Bun.$`rm ${vault}/go.md`.quiet();
  writeMd(vault, "new.md", "# C");

  const events: Array<{ kind: string; path: string }> = [];
  await indexVault(cfg, {
    onFile: (e) => events.push({ kind: e.kind, path: e.path }),
  });

  const kinds = new Set(events.map((e) => e.kind));
  expect(kinds.has("added")).toBe(true);
  expect(kinds.has("updated")).toBe(true);
  expect(kinds.has("deleted")).toBe(true);
});
