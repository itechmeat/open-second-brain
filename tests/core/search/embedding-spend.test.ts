/**
 * The shared embedding spend plan (Honest Embedding Spend).
 *
 * Pins the defect that a positive cost gate never refused an unpriced
 * model, because an unlisted price was estimated at 0. The gate verdict
 * now carries a reason: `over_cap` for a known price over the cap and
 * `unpriced` for an unknown price under an explicit positive gate. It
 * also pins that `planEmbeddingSpend` is one computation of the pending
 * census, the model, the tokens, the quote and the verdict, optionally
 * scoped to path prefixes.
 *
 * Deliberately not covered here: the phase that throws on a blocked
 * verdict (indexer.embeddings.test.ts) and the surfaces that render the
 * plan (embedding-spend-preview.test.ts, search-vector-backfill.test.ts).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";

import {
  EMBEDDING_GATE_REASON,
  evaluateCostGate,
  planEmbeddingSpend,
} from "../../../src/core/search/embedding-spend.ts";
import {
  EMBEDDING_PRICE_SOURCE,
  resolveEmbeddingPrice,
} from "../../../src/core/search/embeddings/pricing.ts";
import { LOCAL_EMBEDDING_MODEL } from "../../../src/core/search/embeddings/signature.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { Store } from "../../../src/core/search/store.ts";
import type { ResolvedEmbeddingConfig } from "../../../src/core/search/types.ts";
import { FAKE_PROVIDER_KEY } from "../../helpers/fake-credentials.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

const TABLE_MODEL = "text-embedding-3-small";
const UNLISTED_MODEL = "zembed-1";
/** ~1M tokens at chars/4: $0.02 on the table model. */
const MILLION_TOKEN_TEXTS = ["x".repeat(4_000_000)];
const LOW_GATE_USD = 0.001;
const HIGH_GATE_USD = 100;
const MICRO_USD = 0.000001;

// ── pure gate verdicts ───────────────────────────────────────────────────────

test("a zero gate never blocks, priced or not", () => {
  for (const model of [TABLE_MODEL, UNLISTED_MODEL]) {
    const verdict = evaluateCostGate({
      texts: MILLION_TOKEN_TEXTS,
      quote: resolveEmbeddingPrice(model),
      gateUsd: 0,
    });
    expect(verdict.blocked).toBe(false);
    expect(verdict.reason).toBeNull();
  }
});

test("a positive gate with a known price blocks only over the cap, as over_cap", () => {
  const quote = resolveEmbeddingPrice(TABLE_MODEL);
  const over = evaluateCostGate({ texts: MILLION_TOKEN_TEXTS, quote, gateUsd: LOW_GATE_USD });
  expect(over).toMatchObject({ blocked: true, reason: EMBEDDING_GATE_REASON.overCap });
  const under = evaluateCostGate({ texts: MILLION_TOKEN_TEXTS, quote, gateUsd: HIGH_GATE_USD });
  expect(under).toMatchObject({ blocked: false, reason: null, tokens: 1_000_000 });
  expect(under.estimatedUsd).toBeGreaterThan(0);
});

test("an estimate exactly at the gate passes; one micro-dollar over blocks", () => {
  const quote = resolveEmbeddingPrice(TABLE_MODEL);
  const estimate = evaluateCostGate({
    texts: MILLION_TOKEN_TEXTS,
    quote,
    gateUsd: 0,
  }).estimatedUsd!;
  expect(estimate).toBeGreaterThan(MICRO_USD);
  const at = evaluateCostGate({ texts: MILLION_TOKEN_TEXTS, quote, gateUsd: estimate });
  expect(at.blocked).toBe(false);
  const below = evaluateCostGate({
    texts: MILLION_TOKEN_TEXTS,
    quote,
    gateUsd: estimate - MICRO_USD,
  });
  expect(below.blocked).toBe(true);
});

test("a positive gate with an unknown price and pending work blocks as unpriced", () => {
  const verdict = evaluateCostGate({
    texts: ["one pending chunk"],
    quote: resolveEmbeddingPrice(UNLISTED_MODEL),
    gateUsd: HIGH_GATE_USD,
  });
  expect(verdict).toMatchObject({
    blocked: true,
    reason: EMBEDDING_GATE_REASON.unpriced,
    estimatedUsd: null,
  });
});

test("a forced run never blocks", () => {
  for (const model of [TABLE_MODEL, UNLISTED_MODEL]) {
    const verdict = evaluateCostGate({
      texts: MILLION_TOKEN_TEXTS,
      quote: resolveEmbeddingPrice(model),
      gateUsd: LOW_GATE_USD,
      forced: true,
    });
    expect(verdict).toMatchObject({ blocked: false, reason: null });
  }
});

test("an empty pending set never blocks, even unpriced", () => {
  const verdict = evaluateCostGate({
    texts: [],
    quote: resolveEmbeddingPrice(UNLISTED_MODEL),
    gateUsd: LOW_GATE_USD,
  });
  expect(verdict).toMatchObject({ blocked: false, reason: null, tokens: 0 });
});

test("the local model never reads unpriced", () => {
  const verdict = evaluateCostGate({
    texts: MILLION_TOKEN_TEXTS,
    quote: resolveEmbeddingPrice(LOCAL_EMBEDDING_MODEL),
    gateUsd: LOW_GATE_USD,
  });
  expect(verdict).toMatchObject({ blocked: false, reason: null, estimatedUsd: 0 });
});

// ── the store-backed plan ────────────────────────────────────────────────────

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  const v = createTempVault("embedding-spend");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
});

afterEach(() => cleanup());

function semanticConfig(semantic: Partial<ResolvedEmbeddingConfig>) {
  return makeConfig({
    vault,
    dbPath,
    semantic: {
      enabled: true,
      provider: "openai-compat",
      baseUrl: "http://127.0.0.1:9",
      model: UNLISTED_MODEL,
      apiKey: FAKE_PROVIDER_KEY,
      dimension: 4,
      timeoutMs: 5_000,
      concurrency: 1,
      batchSize: 8,
      costGateUsd: 0,
      maxRetries: 1,
      ...semantic,
    },
  });
}

async function indexedStore(semantic: Partial<ResolvedEmbeddingConfig>) {
  writeMd(vault, "Brain/preferences/pref-a.md", "# Pref A\n\nA belief about tea.");
  writeMd(vault, "notes/b.md", "# B\n\nA plain note about coffee.");
  await indexVault(makeConfig({ vault, dbPath }));
  const config = semanticConfig(semantic);
  return { config, store: await Store.open(config, { mode: "read" }) };
}

test("the plan reports the pending set, model, tokens, quote and verdict in one place", async () => {
  const { config, store } = await indexedStore({ costGateUsd: HIGH_GATE_USD });
  try {
    const plan = planEmbeddingSpend(store, config);
    expect(plan.pending.length).toBeGreaterThan(0);
    expect(plan.model).toBe(UNLISTED_MODEL);
    expect(plan.tokens).toBeGreaterThan(0);
    expect(plan.quote.source).toBe(EMBEDDING_PRICE_SOURCE.unknown);
    expect(plan.estimatedUsd).toBeNull();
    expect(plan.gate).toEqual({ blocked: true, reason: EMBEDDING_GATE_REASON.unpriced });
  } finally {
    await store.close();
  }
});

test("the plan prices through the operator pair", async () => {
  const { config, store } = await indexedStore({
    costGateUsd: HIGH_GATE_USD,
    priceOverride: { model: UNLISTED_MODEL, usdPerMtok: 0.05 },
  });
  try {
    const plan = planEmbeddingSpend(store, config);
    expect(plan.quote).toEqual({ usdPerMtok: 0.05, source: EMBEDDING_PRICE_SOURCE.operator });
    expect(plan.estimatedUsd).toBeGreaterThan(0);
    expect(plan.gate).toEqual({ blocked: false, reason: null });
  } finally {
    await store.close();
  }
});

test("the local provider plans the local model whatever embedding_model says", async () => {
  const { config, store } = await indexedStore({
    provider: "local",
    model: UNLISTED_MODEL,
    costGateUsd: LOW_GATE_USD,
  });
  try {
    const plan = planEmbeddingSpend(store, config);
    expect(plan.model).toBe(LOCAL_EMBEDDING_MODEL);
    expect(plan.estimatedUsd).toBe(0);
    expect(plan.gate).toEqual({ blocked: false, reason: null });
  } finally {
    await store.close();
  }
});

test("a scoped plan reads only the chunks under its prefixes", async () => {
  const { config, store } = await indexedStore({});
  try {
    const all = planEmbeddingSpend(store, config);
    const scoped = planEmbeddingSpend(store, config, {
      scope: { pathPrefixes: ["Brain/preferences/"] },
    });
    expect(scoped.pending.length).toBeGreaterThan(0);
    expect(scoped.pending.length).toBeLessThan(all.pending.length);
    expect(scoped.pending.some((p) => p.content.includes("coffee"))).toBe(false);
    expect(scoped.tokens).toBeLessThan(all.tokens);
  } finally {
    await store.close();
  }
});
