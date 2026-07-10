/**
 * Offline code-only / keyless indexing (t_85252236).
 *
 * Locks the explicit, deferred backend-resolution guarantee inspired by
 * Graphify's offline-first extraction: a corpus that needs only
 * deterministic (lexical) processing runs to completion with no provider
 * credentials, the structured `IndexStats` declares `backend: "offline"`,
 * and a non-empty `deferredReason` explains why the semantic backend was
 * not engaged. The credential check stays lazy (only the explicitly
 * requested embedding path resolves a key), so a missing key never
 * hard-fails a deterministic-only run.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";
import { startFakeHttp, type FakeHttp } from "../../helpers/fake-http.ts";
import { sqliteVecLoadable } from "../../helpers/sqlite-vec.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  const v = createTempVault("index-offline");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
});

afterEach(() => {
  cleanup();
});

test("keyless indexing completes with backend=offline and a deferred reason", async () => {
  writeMd(vault, "a.md", "# A\n\nFirst note about something.");
  writeMd(vault, "b.md", "# B\n\nSecond note discussing things.");
  // Default config: semantic disabled, no API key resolved.
  const cfg = makeConfig({ vault, dbPath });

  const stats = await indexVault(cfg);

  // The deterministic pipeline ran to completion.
  expect(stats.added).toBe(2);
  expect(stats.chunksTotal).toBeGreaterThanOrEqual(2);
  // No semantic backend engaged: zero embeddings, explicit offline mode.
  expect(stats.embeddingsComputed).toBe(0);
  expect(stats.backend).toBe("offline");
  expect(typeof stats.deferredReason).toBe("string");
  expect((stats.deferredReason ?? "").length).toBeGreaterThan(0);
});

test("a missing key never hard-fails a deterministic-only run (lazy credential check)", async () => {
  writeMd(vault, "a.md", "# A\n\nContent.");
  // Semantic enabled + remote provider + NO key, but embeddings are not
  // requested this run: the credential check must stay deferred and the
  // lexical pipeline must complete offline rather than throwing.
  const cfg = makeConfig({
    vault,
    dbPath,
    semantic: {
      enabled: true,
      provider: "openai-compat",
      baseUrl: "http://127.0.0.1:9",
      model: "fake-model",
      apiKey: null,
      dimension: 4,
    },
  });

  const stats = await indexVault(cfg);

  expect(stats.added).toBe(1);
  expect(stats.embeddingsComputed).toBe(0);
  expect(stats.backend).toBe("offline");
  // The reason is credential-aware when a key is the gating factor.
  expect((stats.deferredReason ?? "").toLowerCase()).toContain("embedding_api_key");
});

test("the semantic backend is declared when embeddings are computed", async () => {
  if (!sqliteVecLoadable()) return;
  const server: FakeHttp = await startFakeHttp();
  try {
    writeMd(vault, "a.md", "# A\n\nFirst note about something.");
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
        concurrency: 2,
        batchSize: 8,
        costGateUsd: 0,
        maxRetries: 3,
      },
    });

    const stats = await indexVault(cfg, { embeddings: true });

    expect(stats.embeddingsComputed).toBeGreaterThan(0);
    expect(stats.backend).toBe("semantic");
    expect(stats.deferredReason).toBeNull();
  } finally {
    await server.close();
  }
});
