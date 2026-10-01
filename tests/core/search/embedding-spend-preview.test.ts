/**
 * The embedding spend surface (t_9d155d0e, Task 8):
 *
 * - `estimatePendingEmbeddingSpend`: the pre-flight preview over the
 *   embedding phase's own census and cost kernel. The maintenance lane's
 *   banner reads this one helper, so what the run ANNOUNCES cannot drift
 *   from what `runEmbeddingPhase` actually gates on. Null means "this
 *   run cannot spend": no index, semantic not usable, vec unavailable,
 *   or nothing pending.
 *
 * - `runEmbeddingPhase`'s tally receipt: the phase records ITS OWN
 *   census priced by the same kernel, because the preview runs before
 *   the pass's walk and a walk that adds chunks (a dream or an agent
 *   wrote since the last index) makes the preview an estimate by
 *   position. The receipt is what the pass actually refused or priced.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  embeddingSpendOf,
  estimatePendingEmbeddingSpend,
  runEmbeddingPhase,
  type EmbeddingPhaseTally,
} from "../../../src/core/search/indexer.ts";
import { indexVault, resolveSearchConfig } from "../../../src/core/search/index.ts";
import { Store } from "../../../src/core/search/store.ts";
import {
  estimateCostUsd,
  estimateTokens,
  LOCAL_EMBEDDING_MODEL,
} from "../../../src/core/search/embeddings/signature.ts";
import { SearchError } from "../../../src/core/search/types.ts";
import type { ResolvedSearchConfig } from "../../../src/core/search/types.ts";
import { startFakeHttp, type FakeHttp } from "../../helpers/fake-http.ts";
import { FAKE_PROVIDER_KEY } from "../../helpers/fake-credentials.ts";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-spend-preview-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** A resolved config over a config file naming the semantic keys. */
function configWith(embedding: Record<string, string>): ResolvedSearchConfig {
  const configPath = join(tmp, "config.yaml");
  writeFileSync(
    configPath,
    `vault: ${vault}\n` +
      Object.entries(embedding)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n") +
      "\n",
  );
  return resolveSearchConfig({ vault, configPath });
}

/** A store holding one document of `chunks` vectorless chunks; closed on exit. */
async function storeWithChunks(config: ResolvedSearchConfig, contents: string[]): Promise<void> {
  const store = await Store.open(config, { mode: "write" });
  try {
    const docId = store.upsertDocument({
      path: "Brain/note.md",
      title: "note",
      contentHash: "h1",
      mtime: 1_700_000_000,
      size: 10,
    });
    store.replaceChunks(
      docId,
      contents.map((content, i) => ({
        chunkIndex: i,
        content,
        contentHash: `h1-${i}`,
        startLine: 1,
        endLine: 2,
        tokenCount: content.length,
      })),
    );
  } finally {
    await store.close();
  }
}

const PRICED_MODEL = {
  search_semantic_enabled: "true",
  embedding_provider: "openai-compat",
  embedding_base_url: "https://x/v1",
  embedding_model: "text-embedding-3-small",
  embedding_api_key: FAKE_PROVIDER_KEY,
};

test("a vault with no index cannot spend: null", async () => {
  const config = configWith(PRICED_MODEL);
  expect(await estimatePendingEmbeddingSpend(config)).toBeNull();
});

test("pending chunks preview the kernel's own numbers at the resolved model", async () => {
  const contents = ["alpha beta gamma delta", "second chunk of prose"];
  const tokens = estimateTokens(contents);
  const usd = estimateCostUsd(tokens, "text-embedding-3-small");
  // A positive gate set BELOW the kernel's estimate: the run would be
  // refused without a forced bypass, and the preview says so.
  const config = configWith({
    ...PRICED_MODEL,
    embedding_cost_gate_usd: String(usd / 2),
  });
  await storeWithChunks(config, contents);

  const preview = await estimatePendingEmbeddingSpend(config);
  expect(preview).not.toBeNull();
  expect(preview?.model).toBe("text-embedding-3-small");
  expect(preview?.pendingChunks).toBe(2);
  // The preview prices exactly what the phase's gate prices.
  expect(preview?.tokens).toBe(tokens);
  expect(preview?.estimatedUsd).toBe(usd);
  expect(preview?.estimatedUsd).toBeGreaterThan(0);
  expect(preview?.blocked).toBe(true);

  // The same vault with the gate at its off default never blocks.
  const ungated = configWith(PRICED_MODEL);
  const ungatedPreview = await estimatePendingEmbeddingSpend(ungated);
  expect(ungatedPreview?.blocked).toBe(false);
  expect(ungatedPreview?.estimatedUsd).toBe(usd);
});

test("a local model prices at zero and never blocks, at any gate", async () => {
  const config = configWith({
    search_semantic_enabled: "true",
    embedding_provider: "local",
    embedding_cost_gate_usd: "0.02",
  });
  await storeWithChunks(config, ["local provider prose"]);

  const preview = await estimatePendingEmbeddingSpend(config);
  expect(preview?.model).toBe(LOCAL_EMBEDDING_MODEL);
  expect(preview?.pendingChunks).toBe(1);
  expect(preview?.tokens).toBeGreaterThan(0);
  expect(preview?.estimatedUsd).toBe(0);
  expect(preview?.blocked).toBe(false);
});

test("nothing pending cannot spend: null even with a priced model", async () => {
  const config = configWith(PRICED_MODEL);
  const store = await Store.open(config, { mode: "write" });
  try {
    store.upsertDocument({
      path: "Brain/empty.md",
      title: "empty",
      contentHash: "h2",
      mtime: 1_700_000_000,
      size: 10,
    });
  } finally {
    await store.close();
  }
  expect(await estimatePendingEmbeddingSpend(config)).toBeNull();
});

test("semantic that is not configured cannot spend: null with chunks waiting", async () => {
  // Override LAST: the point is the disabled verdict, not the priced keys.
  const config = configWith({ ...PRICED_MODEL, search_semantic_enabled: "false" });
  await storeWithChunks(config, ["orphan chunk"]);
  // The same chunks under a configured semantic DO preview, so the null
  // above is the capability verdict, not the empty census.
  const capable = configWith(PRICED_MODEL);
  await storeWithChunks(capable, ["priced chunk"]);
  expect(await estimatePendingEmbeddingSpend(capable)).not.toBeNull();
  expect(await estimatePendingEmbeddingSpend(config)).toBeNull();
});

/** A write-mode store seeded with `contents` vectorless chunks. */
async function openSeeded(config: ResolvedSearchConfig, contents: string[]): Promise<Store> {
  const store = await Store.open(config, { mode: "write" });
  const docId = store.upsertDocument({
    path: "Brain/note.md",
    title: "note",
    contentHash: "h1",
    mtime: 1_700_000_000,
    size: 10,
  });
  store.replaceChunks(
    docId,
    contents.map((content, i) => ({
      chunkIndex: i,
      content,
      contentHash: `h1-${i}`,
      startLine: 1,
      endLine: 2,
      tokenCount: content.length,
    })),
  );
  return store;
}

test("the phase records its own gate result on the tally, at the resolved model", async () => {
  const config = configWith({
    search_semantic_enabled: "true",
    embedding_provider: "local",
  });
  const contents = ["alpha beta gamma", "delta epsilon zeta"];
  const store = await openSeeded(config, contents);
  const tally: EmbeddingPhaseTally = { embeddingsComputed: 0, embeddingsRetries: 0 };
  try {
    await runEmbeddingPhase(store, config, tally, {});
    expect(tally.embeddingsComputed).toBe(2);
    expect(tally.spend).toEqual({
      model: LOCAL_EMBEDDING_MODEL,
      tokens: estimateTokens(contents),
      estimatedUsd: 0,
      forced: false,
    });
  } finally {
    await store.close();
  }
});

test("nothing pending: the phase runs, embeds nothing, and records no receipt", async () => {
  const config = configWith({
    search_semantic_enabled: "true",
    embedding_provider: "local",
  });
  const store = await Store.open(config, { mode: "write" });
  const tally: EmbeddingPhaseTally = { embeddingsComputed: 0, embeddingsRetries: 0 };
  try {
    await runEmbeddingPhase(store, config, tally, {});
    expect(tally.embeddingsComputed).toBe(0);
    expect(tally.spend).toBeUndefined();
  } finally {
    await store.close();
  }
});

test("a positive gate refuses unforced and records nothing; forced records the bypass", async () => {
  let server: FakeHttp | null = null;
  try {
    server = await startFakeHttp();
    const gateConfig = configWith({
      search_semantic_enabled: "true",
      embedding_provider: "openai-compat",
      embedding_base_url: server.url,
      embedding_model: "text-embedding-3-small",
      embedding_api_key: FAKE_PROVIDER_KEY,
      embedding_cost_gate_usd: "0.000001",
    });
    // Long enough that the kernel's chars/4 estimate exceeds the $0.000001
    // gate at text-embedding-3-small's rate.
    const contents = ["pricing text repeated long enough to exceed the tiny gate. ".repeat(8)];
    const store = await openSeeded(gateConfig, contents);
    try {
      // Unforced: refused before any provider contact, nothing recorded.
      const refused: EmbeddingPhaseTally = { embeddingsComputed: 0, embeddingsRetries: 0 };
      await expect(runEmbeddingPhase(store, gateConfig, refused, {})).rejects.toThrow(SearchError);
      expect(refused.spend).toBeUndefined();
      expect(refused.embeddingsComputed).toBe(0);
      expect(server.callCount()).toBe(0);

      // Forced: the bypass is real provider spend and the receipt says so.
      const forced: EmbeddingPhaseTally = { embeddingsComputed: 0, embeddingsRetries: 0 };
      await runEmbeddingPhase(store, gateConfig, forced, { forceCost: true });
      expect(forced.embeddingsComputed).toBe(1);
      expect(forced.spend?.forced).toBe(true);
      expect(forced.spend?.model).toBe("text-embedding-3-small");
      expect(forced.spend?.tokens).toBe(estimateTokens(contents));
      expect(forced.spend?.estimatedUsd).toBe(
        estimateCostUsd(forced.spend?.tokens ?? 0, "text-embedding-3-small"),
      );
      expect(forced.spend?.estimatedUsd).toBeGreaterThan(0);
      expect(server.callCount()).toBeGreaterThan(0);
    } finally {
      await store.close();
    }
  } finally {
    await server?.close();
  }
});

test("embeddingSpendOf reads the receipt off a completed run's stats", async () => {
  const config = configWith({
    search_semantic_enabled: "true",
    embedding_provider: "local",
  });
  // A REAL file: the run's walk must find it, or the index has nothing
  // for the phase to price.
  writeFileSync(
    join(vault, "Brain", "receipt.md"),
    "# receipt\n\nbody text long enough to cut at least one chunk for the index to embed.\n",
  );
  const stats = await indexVault(config, { embeddings: true });
  const receipt = embeddingSpendOf(stats);
  expect(receipt?.model).toBe(LOCAL_EMBEDDING_MODEL);
  expect(receipt?.tokens).toBeGreaterThan(0);
  expect(receipt?.forced).toBe(false);

  // An offline run records no receipt at all. A FRESH vault: reusing the
  // embedded one would make this a model-change test, and the stored
  // vectors' verify-before-replace gate rightly refuses that clear.
  const offlineVault = join(tmp, "vault-offline");
  mkdirSync(join(offlineVault, "Brain"), { recursive: true });
  const offlinePath = join(tmp, "config-offline.yaml");
  writeFileSync(
    offlinePath,
    `vault: ${offlineVault}\n` +
      "embedding_provider: openai-compat\nembedding_base_url: https://x/v1\n" +
      "embedding_model: text-embedding-3-small\n",
  );
  const offlineConfig = resolveSearchConfig({ vault: offlineVault, configPath: offlinePath });
  writeFileSync(join(offlineVault, "Brain", "offline.md"), "more prose for the offline run.\n");
  const offlineStats = await indexVault(offlineConfig, {});
  expect(offlineStats.backend).toBe("offline");
  expect(embeddingSpendOf(offlineStats)).toBeUndefined();
});
