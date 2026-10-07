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
 *
 * - The unpriced refusal (Honest Embedding Spend): under an explicit
 *   positive gate a model nobody priced is refused with
 *   EMBEDDING_COST_UNPRICED before any provider contact, instead of being
 *   estimated at $0 and let through. A forced run records the unknown
 *   price as a null estimate with `priceSource: unknown`.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  embeddingSpendOf,
  estimatePendingEmbeddingSpend,
  indexStatus,
  runEmbeddingPhase,
  type EmbeddingPhaseTally,
} from "../../../src/core/search/indexer.ts";
import { planEmbeddingSpend } from "../../../src/core/search/embedding-spend.ts";
import { planVectorBackfill } from "../../../src/core/search/vector-backfill.ts";
import { indexVault, resolveSearchConfig } from "../../../src/core/search/index.ts";
import { Store } from "../../../src/core/search/store.ts";
import {
  resolveEmbeddingPrice,
  type KnownPriceQuote,
} from "../../../src/core/search/embeddings/pricing.ts";
import {
  estimateCostUsd,
  estimateTokens,
  LOCAL_EMBEDDING_MODEL,
} from "../../../src/core/search/embeddings/signature.ts";
import { SearchError } from "../../../src/core/search/types.ts";
import type { ResolvedSearchConfig } from "../../../src/core/search/types.ts";
import { startFakeHttp, type FakeHttp } from "../../helpers/fake-http.ts";
import { FAKE_PROVIDER_KEY } from "../../helpers/fake-credentials.ts";

/** The builtin quote of the table model the gate fixtures price against. */
const TABLE_QUOTE: KnownPriceQuote = (() => {
  const quote = resolveEmbeddingPrice("text-embedding-3-small");
  if (quote.usdPerMtok === null) throw new Error("text-embedding-3-small lost its table price");
  return quote;
})();

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
  const usd = estimateCostUsd(tokens, TABLE_QUOTE);
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
      priceSource: "builtin",
    });
  } finally {
    await store.close();
  }
});

/**
 * Pinned split, deliberately: the receipt names the model the price was
 * resolved for - the local provider always embeds with its implicit
 * model - while the vectors keep the stamp `embedding_model` gives them,
 * because changing the stamp would re-key (and drop) every existing
 * local index. The local model is free, so the money statement holds.
 */
test("a local receipt names the priced model while vectors keep the configured stamp", async () => {
  const config = configWith({
    search_semantic_enabled: "true",
    embedding_provider: "local",
    embedding_model: "custom-local",
  });
  const store = await openSeeded(config, ["alpha beta gamma"]);
  const tally: EmbeddingPhaseTally = { embeddingsComputed: 0, embeddingsRetries: 0 };
  try {
    await runEmbeddingPhase(store, config, tally, {});
  } finally {
    await store.close();
  }
  expect(tally.spend?.model).toBe(LOCAL_EMBEDDING_MODEL);
  const db = new Database(config.dbPath, { readonly: true });
  try {
    const stamps = db.query<{ model: string }, []>("SELECT DISTINCT model FROM embeddings").all();
    expect(stamps.map((row) => row.model)).toEqual(["custom-local"]);
  } finally {
    db.close();
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
        estimateCostUsd(forced.spend?.tokens ?? 0, TABLE_QUOTE),
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

test("--force-cost under the cap is not recorded as forced", async () => {
  let server: FakeHttp | null = null;
  try {
    server = await startFakeHttp();
    const config = configWith({
      ...PRICED_MODEL,
      embedding_base_url: server.url,
      embedding_cost_gate_usd: "100",
    });
    const store = await openSeeded(config, ["a short chunk well under the cap"]);
    try {
      const tally: EmbeddingPhaseTally = { embeddingsComputed: 0, embeddingsRetries: 0 };
      await runEmbeddingPhase(store, config, tally, { forceCost: true });
      expect(tally.embeddingsComputed).toBe(1);
      expect(tally.spend?.forced).toBe(false);
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

// ── unpriced models under an explicit gate ───────────────────────────────────

const UNPRICED_MODEL = "zembed-1";

test("a positive gate refuses an unpriced model by name, before any provider contact", async () => {
  let server: FakeHttp | null = null;
  try {
    server = await startFakeHttp();
    const config = configWith({
      search_semantic_enabled: "true",
      embedding_provider: "openai-compat",
      embedding_base_url: server.url,
      embedding_model: UNPRICED_MODEL,
      embedding_api_key: FAKE_PROVIDER_KEY,
      embedding_cost_gate_usd: "100",
    });
    const store = await openSeeded(config, ["a short chunk the price of which nobody stated"]);
    try {
      const tally: EmbeddingPhaseTally = { embeddingsComputed: 0, embeddingsRetries: 0 };
      const refusal = await runEmbeddingPhase(store, config, tally, {}).then(
        () => null,
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(SearchError);
      const error = refusal as SearchError;
      expect(error.code).toBe("EMBEDDING_COST_UNPRICED");
      for (const named of [
        UNPRICED_MODEL,
        "embedding_price_model",
        "embedding_price_usd_per_mtok",
        "--force-cost",
      ]) {
        expect(error.message).toContain(named);
      }
      expect(tally.spend).toBeUndefined();
      expect(server.callCount()).toBe(0);

      const forced: EmbeddingPhaseTally = { embeddingsComputed: 0, embeddingsRetries: 0 };
      await runEmbeddingPhase(store, config, forced, { forceCost: true });
      expect(forced.embeddingsComputed).toBe(1);
      expect(forced.spend).toMatchObject({
        model: UNPRICED_MODEL,
        forced: true,
        priceSource: "unknown",
        estimatedUsd: null,
      });
    } finally {
      await store.close();
    }
  } finally {
    await server?.close();
  }
});

test("a handed-in plan is re-gated, so a forced or stale verdict cannot pass the gate", async () => {
  let server: FakeHttp | null = null;
  try {
    server = await startFakeHttp();
    const config = configWith({
      search_semantic_enabled: "true",
      embedding_provider: "openai-compat",
      embedding_base_url: server.url,
      embedding_model: UNPRICED_MODEL,
      embedding_api_key: FAKE_PROVIDER_KEY,
      embedding_cost_gate_usd: "100",
    });
    const store = await openSeeded(config, ["a chunk whose plan claims the gate passed"]);
    try {
      const forcedPlan = planEmbeddingSpend(store, config, { forced: true });
      expect(forcedPlan.gate.blocked).toBe(false);
      const unforced = planEmbeddingSpend(store, config);
      const stalePlan = { ...unforced, gate: { blocked: false as const, reason: null } };
      for (const plan of [forcedPlan, stalePlan]) {
        const tally: EmbeddingPhaseTally = { embeddingsComputed: 0, embeddingsRetries: 0 };
        // eslint-disable-next-line no-await-in-loop -- two plans, one after the other
        const refusal = await runEmbeddingPhase(store, config, tally, { plan }).then(
          () => null,
          (error: unknown) => error,
        );
        expect((refusal as SearchError).code).toBe("EMBEDDING_COST_UNPRICED");
        expect(tally.spend).toBeUndefined();
      }
      expect(server.callCount()).toBe(0);
    } finally {
      await store.close();
    }
  } finally {
    await server?.close();
  }
});

test("the over-cap refusal keeps its code and message", async () => {
  const config = configWith({ ...PRICED_MODEL, embedding_cost_gate_usd: "0.000001" });
  const store = await openSeeded(config, ["pricing text repeated to exceed the gate. ".repeat(8)]);
  try {
    const tally: EmbeddingPhaseTally = { embeddingsComputed: 0, embeddingsRetries: 0 };
    const refusal = await runEmbeddingPhase(store, config, tally, {}).then(
      () => null,
      (error: unknown) => error,
    );
    expect((refusal as SearchError).code).toBe("EMBEDDING_COST_GATE");
    expect((refusal as SearchError).message).toMatch(
      /^estimated embedding cost \$\d+\.\d{4} for 1 chunk\(s\) exceeds embedding_cost_gate_usd \$0\.0000\. Re-run with --force-cost to proceed or raise the gate\.$/,
    );
  } finally {
    await store.close();
  }
});

// ── every surface reads the one plan ────────────────────────────────────────

const OPERATOR_PRICED = {
  embedding_price_model: UNPRICED_MODEL,
  embedding_price_usd_per_mtok: "0.05",
};

test("preview, backfill dry run, status and the phase report one estimate and source", async () => {
  let server: FakeHttp | null = null;
  try {
    server = await startFakeHttp();
    const config = configWith({
      search_semantic_enabled: "true",
      embedding_provider: "openai-compat",
      embedding_base_url: server.url,
      embedding_model: UNPRICED_MODEL,
      embedding_api_key: FAKE_PROVIDER_KEY,
      ...OPERATOR_PRICED,
    });
    const contents = ["first chunk the operator priced", "second chunk the operator priced"];
    await storeWithChunks(config, contents);

    const preview = await estimatePendingEmbeddingSpend(config);
    const dryRun = await planVectorBackfill(config);
    const status = await indexStatus(config);
    expect(preview?.estimatedUsd).toBeGreaterThan(0);
    expect(preview?.priceSource).toBe("operator");
    expect(dryRun.estimatedCostUsd).toBe(preview?.estimatedUsd ?? -1);
    expect(dryRun.priceSource).toBe("operator");
    expect(status.estimatedRefreshCostUsd).toBe(preview?.estimatedUsd ?? -1);
    expect(status.refreshPriceSource).toBe("operator");

    const store = await Store.open(config, { mode: "write" });
    try {
      const tally: EmbeddingPhaseTally = { embeddingsComputed: 0, embeddingsRetries: 0 };
      await runEmbeddingPhase(store, config, tally, {});
      expect(tally.spend).toMatchObject({
        tokens: preview?.tokens ?? -1,
        estimatedUsd: preview?.estimatedUsd ?? -1,
        priceSource: "operator",
      });
    } finally {
      await store.close();
    }
  } finally {
    await server?.close();
  }
});

test("an unknown price reads null on every surface and blocks as unpriced under a gate", async () => {
  const config = configWith({
    ...PRICED_MODEL,
    embedding_model: UNPRICED_MODEL,
    embedding_cost_gate_usd: "100",
  });
  await storeWithChunks(config, ["a chunk nobody priced"]);

  const preview = await estimatePendingEmbeddingSpend(config);
  expect(preview).toMatchObject({
    estimatedUsd: null,
    priceSource: "unknown",
    blocked: true,
    reason: "unpriced",
  });
  const dryRun = await planVectorBackfill(config);
  expect(dryRun).toMatchObject({
    estimatedCostUsd: null,
    priceSource: "unknown",
    blocked: true,
    reason: "unpriced",
  });
  const status = await indexStatus(config);
  expect(status.estimatedRefreshCostUsd).toBeNull();
  expect(status.refreshPriceSource).toBe("unknown");

  // The gate off: nothing blocks, the estimate stays unknown.
  const ungated = configWith({ ...PRICED_MODEL, embedding_model: UNPRICED_MODEL });
  expect(await estimatePendingEmbeddingSpend(ungated)).toMatchObject({
    estimatedUsd: null,
    blocked: false,
    reason: null,
  });
});

test("a local index prices as a known zero on the backfill and on status", async () => {
  const local = configWith({ search_semantic_enabled: "true", embedding_provider: "local" });
  await storeWithChunks(local, ["local chunk"]);
  expect(await planVectorBackfill(local)).toMatchObject({
    estimatedCostUsd: 0,
    priceSource: "builtin",
  });
  const status = await indexStatus(local);
  expect(status.estimatedRefreshCostUsd).toBe(0);
  expect(status.refreshPriceSource).toBe("builtin");
});
