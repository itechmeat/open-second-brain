/**
 * Integration slice for the Embedding Provider Suite: index a vault with
 * the offline LOCAL embedder (no network, no key) and search it under
 * both fusion modes. Exercises the whole pipeline - config resolution,
 * indexer cost gate (free for local), vec storage, semantic recall, and
 * RRF fusion - end to end.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { indexStatus } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { LOCAL_EMBEDDING_MODEL } from "../../../src/core/search/embeddings/signature.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";
import { sqliteVecLoadable } from "../../helpers/sqlite-vec.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  const v = createTempVault("local-rrf");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
});

afterEach(() => {
  cleanup();
});

function localConfig(fusionMode: "linear" | "rrf" = "linear") {
  return makeConfig({
    vault,
    dbPath,
    fusionMode,
    semantic: {
      enabled: true,
      provider: "local",
      baseUrl: null,
      model: null,
      apiKey: null,
      dimension: 128,
      timeoutMs: 5_000,
      concurrency: 2,
      batchSize: 8,
      costGateUsd: 0,
    },
  });
}

test("local embedder indexes with no network and embeds every chunk", async () => {
  if (!sqliteVecLoadable()) return;
  writeMd(vault, "a.md", "# Machine learning\n\nNeural networks and gradient descent.");
  writeMd(vault, "b.md", "# Gardening\n\nTomatoes and compost in spring.");
  const cfg = localConfig();

  const stats = await indexVault(cfg, { embeddings: true });
  expect(stats.embeddingsComputed).toBeGreaterThanOrEqual(2);

  const status = await indexStatus(cfg);
  expect(status.embeddingModel).toBe(LOCAL_EMBEDDING_MODEL);
  expect(status.embeddingDimension).toBe(128);
  expect(status.embeddingSignature).toBe(`local:${LOCAL_EMBEDDING_MODEL}:128`);
  // The local provider is free, so there is never a refresh cost.
  expect(status.estimatedRefreshCostUsd).toBe(0);
});

test("local embedder produces semantic hits and rrf surfaces its reason", async () => {
  if (!sqliteVecLoadable()) return;
  writeMd(vault, "ml.md", "# Machine learning\n\nNeural networks learn from data.");
  writeMd(vault, "garden.md", "# Gardening\n\nTomatoes need water and sun.");
  const cfg = localConfig("rrf");
  await indexVault(cfg, { embeddings: true });

  const outcome = await search(cfg, { query: "neural networks", limit: 5, semantic: true });
  expect(outcome.results.length).toBeGreaterThan(0);
  // At least one result fused through RRF carries the rrf reason.
  const anyRrf = outcome.results.some((r) => r.reasons.some((x) => x.startsWith("rrf:")));
  expect(anyRrf).toBe(true);
});
