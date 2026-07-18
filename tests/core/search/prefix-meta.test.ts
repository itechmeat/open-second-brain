import { test, expect, beforeEach, afterEach } from "bun:test";

import { indexVault, indexStatus } from "../../../src/core/search/indexer.ts";
import { Store } from "../../../src/core/search/store.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";
import { startFakeHttp, type FakeHttp } from "../../helpers/fake-http.ts";
import { sqliteVecLoadable } from "../../helpers/sqlite-vec.ts";
import type { ResolvedEmbeddingConfig } from "../../../src/core/search/types.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;
let server: FakeHttp;

beforeEach(async () => {
  const v = createTempVault("prefix-meta");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
  server = await startFakeHttp();
});

afterEach(async () => {
  cleanup();
  await server.close();
});

function cfg(semantic: Partial<ResolvedEmbeddingConfig>) {
  return makeConfig({
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
      concurrency: 2,
      batchSize: 8,
      costGateUsd: 0,
      maxRetries: 3,
      ...semantic,
    },
  });
}

test("indexing persists the active prefix pair into index meta", async () => {
  if (!sqliteVecLoadable()) return;
  writeMd(vault, "a.md", "# A\n\nA note about prefixes.");
  await indexVault(cfg({ queryPrefix: "query: ", passagePrefix: "passage: " }), {
    embeddings: true,
  });

  const store = await Store.open(cfg({ queryPrefix: "query: ", passagePrefix: "passage: " }), {
    mode: "read",
  });
  expect(store.getState("embedding_prefix_query")).toBe("query: ");
  expect(store.getState("embedding_prefix_passage")).toBe("passage: ");
  await store.close();
});

test("no preset match and no config records an empty prefix pair (byte-identical baseline)", async () => {
  if (!sqliteVecLoadable()) return;
  writeMd(vault, "a.md", "# A\n\nAnother note.");
  await indexVault(cfg({ queryPrefix: "", passagePrefix: "" }), { embeddings: true });

  const store = await Store.open(cfg({ queryPrefix: "", passagePrefix: "" }), { mode: "read" });
  expect(store.getState("embedding_prefix_query")).toBe("");
  expect(store.getState("embedding_prefix_passage")).toBe("");
  await store.close();
});

test("a stored-vs-configured prefix mismatch surfaces a reindex-required warning", async () => {
  if (!sqliteVecLoadable()) return;
  writeMd(vault, "a.md", "# A\n\nNote embedded without a prefix.");
  await indexVault(cfg({ queryPrefix: "", passagePrefix: "" }), { embeddings: true });

  // Now the operator configures e5-style prefixes without reindexing: the
  // stored (empty) pair no longer matches the configured pair.
  const status = await indexStatus(cfg({ queryPrefix: "query: ", passagePrefix: "passage: " }));
  expect(status.warnings.some((w) => /prefix/i.test(w) && /reindex/i.test(w))).toBe(true);
});

test("matching stored and configured prefixes produce no prefix warning", async () => {
  if (!sqliteVecLoadable()) return;
  writeMd(vault, "a.md", "# A\n\nNote embedded with a prefix.");
  await indexVault(cfg({ queryPrefix: "query: ", passagePrefix: "passage: " }), {
    embeddings: true,
  });

  const status = await indexStatus(cfg({ queryPrefix: "query: ", passagePrefix: "passage: " }));
  expect(status.warnings.some((w) => /prefix/i.test(w))).toBe(false);
});
