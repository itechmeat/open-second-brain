/**
 * `search check` recommendations about the embedding price (Honest
 * Embedding Spend, task 7).
 *
 * The defect pinned here: a model outside the frozen price table was
 * priced at 0 everywhere, and `search check` said nothing about it, so
 * an operator learnt that a model was unpriced only when a gated run was
 * refused. A declared price pair for a model that is no longer active
 * was equally silent while it priced nothing.
 *
 * Covered: the unpriced line under a gate of 0 and under a positive
 * gate, the stale-declaration line, and the silence of table-priced,
 * operator-priced and local models.
 *
 * Deliberately not covered: the refusal itself (`EMBEDDING_COST_UNPRICED`
 * belongs to the spend plan's suites) and the other recommendation arms
 * (`check-recommendations.test.ts`).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  EMBEDDING_PRICE_MODEL_KEY,
  EMBEDDING_PRICE_RATE_KEY,
} from "../../../src/core/search/embeddings/pricing.ts";
import { indexCheck } from "../../../src/core/search/indexer.ts";
import { embeddingPriceRecommendations } from "../../../src/core/search/price-recommendations.ts";
import type { ResolvedEmbeddingConfig } from "../../../src/core/search/types.ts";
import { FAKE_PROVIDER_KEY } from "../../helpers/fake-credentials.ts";
import { createTempVault, makeConfig } from "../../helpers/search-fixtures.ts";

const UNPRICED_MODEL = "acme-embed-unlisted-1";
const TABLE_MODEL = "text-embedding-3-small";
const POSITIVE_GATE_USD = 0.5;
const DECLARED_RATE = 0.07;

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  const v = createTempVault("check-price-recs");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
});

afterEach(() => {
  cleanup();
});

function configured(semantic: Partial<ResolvedEmbeddingConfig>) {
  return makeConfig({
    vault,
    dbPath,
    semantic: {
      enabled: true,
      provider: "openai-compat",
      baseUrl: "https://embeddings.invalid/v1",
      apiKey: FAKE_PROVIDER_KEY,
      ...semantic,
    },
  });
}

async function priceLines(semantic: Partial<ResolvedEmbeddingConfig>): Promise<string[]> {
  const report = await indexCheck(configured(semantic), { probeProvider: false });
  return report.recommendations.filter(
    (r) => r.includes(EMBEDDING_PRICE_MODEL_KEY) || r.includes(EMBEDDING_PRICE_RATE_KEY),
  );
}

describe("indexCheck price recommendations", () => {
  test("an unpriced model under gate 0 gets one line naming both keys and what a gate would do", async () => {
    const lines = await priceLines({ model: UNPRICED_MODEL, costGateUsd: 0 });
    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line).toContain(UNPRICED_MODEL);
    expect(line).toContain(EMBEDDING_PRICE_MODEL_KEY);
    expect(line).toContain(EMBEDDING_PRICE_RATE_KEY);
    expect(line).toContain("a positive gate would refuse");
  });

  test("an unpriced model under a positive gate is told that backfills refuse", async () => {
    const lines = await priceLines({ model: UNPRICED_MODEL, costGateUsd: POSITIVE_GATE_USD });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("vector backfills refuse");
    expect(lines[0]).toContain("--force-cost");
  });

  test("a declared pair for another model yields one stale-declaration line", async () => {
    const lines = await priceLines({
      model: TABLE_MODEL,
      priceOverride: { model: UNPRICED_MODEL, usdPerMtok: DECLARED_RATE },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`names model "${UNPRICED_MODEL}"`);
    expect(lines[0]).toContain(`"${TABLE_MODEL}"`);
  });

  test("a table-priced model adds no line", async () => {
    expect(await priceLines({ model: TABLE_MODEL })).toEqual([]);
  });

  test("an operator-priced model adds no line, its declared name compared canonically", async () => {
    expect(
      await priceLines({
        model: UNPRICED_MODEL,
        priceOverride: { model: ` ${UNPRICED_MODEL.toUpperCase()} `, usdPerMtok: DECLARED_RATE },
      }),
    ).toEqual([]);
  });

  test("the local embedder adds no line, whatever embedding_model says", async () => {
    expect(await priceLines({ provider: "local", model: UNPRICED_MODEL })).toEqual([]);
  });

  test("a disabled semantic configuration adds no line", async () => {
    expect(await priceLines({ enabled: false, model: UNPRICED_MODEL })).toEqual([]);
  });
});

describe("embeddingPriceRecommendations", () => {
  test("a configuration that names no model has nothing to price", () => {
    expect(embeddingPriceRecommendations(configured({ model: null }))).toEqual([]);
  });

  test("a stale declaration is reported beside the unpriced line, unpriced first", () => {
    const recs = embeddingPriceRecommendations(
      configured({
        model: UNPRICED_MODEL,
        priceOverride: { model: TABLE_MODEL, usdPerMtok: DECLARED_RATE },
      }),
    );
    expect(recs).toHaveLength(2);
    expect(recs[0]).toContain(`No price is known for embedding model "${UNPRICED_MODEL}"`);
    expect(recs[1]).toContain(`names model "${TABLE_MODEL}"`);
  });
});
