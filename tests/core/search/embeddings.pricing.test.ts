/**
 * Price quotes for embedding models (Honest Embedding Spend).
 *
 * Pins the defect that a model outside the frozen price table was priced
 * at 0, so an unpriced paid model read as free everywhere a cost was
 * estimated. The resolver now answers with a quote that names who stated
 * the price (`builtin` table, `operator` declaration) or says the price is
 * `unknown`, and an unknown quote yields a null estimate, never 0.
 *
 * Deliberately not covered here: config parsing of the operator pair
 * (embeddings.cost-gate.test.ts) and the gate verdicts built on a quote
 * (embedding-spend.test.ts).
 */
import { test, expect } from "bun:test";

import {
  EMBEDDING_PRICE_SOURCE,
  resolveEmbeddingPrice,
} from "../../../src/core/search/embeddings/pricing.ts";
import {
  estimateCostUsd,
  LOCAL_EMBEDDING_MODEL,
} from "../../../src/core/search/embeddings/signature.ts";

const TABLE_MODEL = "text-embedding-3-small";
const TABLE_RATE = 0.02;
const UNLISTED_MODEL = "zembed-1";
const OPERATOR_RATE = 0.05;

test("a table model resolves to its builtin rate", () => {
  expect(resolveEmbeddingPrice(TABLE_MODEL)).toEqual({
    usdPerMtok: TABLE_RATE,
    source: EMBEDDING_PRICE_SOURCE.builtin,
  });
});

test("the local model resolves to a builtin rate of 0, known to be free", () => {
  expect(resolveEmbeddingPrice(LOCAL_EMBEDDING_MODEL)).toEqual({
    usdPerMtok: 0,
    source: EMBEDDING_PRICE_SOURCE.builtin,
  });
});

test("an unlisted model and a null model resolve to an unknown price", () => {
  const unknown = { usdPerMtok: null, source: EMBEDDING_PRICE_SOURCE.unknown };
  expect(resolveEmbeddingPrice(UNLISTED_MODEL)).toEqual(unknown);
  expect(resolveEmbeddingPrice(null)).toEqual(unknown);
});

test("an operator declaration prices an unlisted model after canonicalisation", () => {
  const override = { model: "  ZEmbed-1 ", usdPerMtok: OPERATOR_RATE };
  expect(resolveEmbeddingPrice(UNLISTED_MODEL, override)).toEqual({
    usdPerMtok: OPERATOR_RATE,
    source: EMBEDDING_PRICE_SOURCE.operator,
  });
});

test("an operator declaration re-prices a table model and may declare it free", () => {
  expect(resolveEmbeddingPrice(TABLE_MODEL, { model: TABLE_MODEL, usdPerMtok: 0.03 })).toEqual({
    usdPerMtok: 0.03,
    source: EMBEDDING_PRICE_SOURCE.operator,
  });
  expect(resolveEmbeddingPrice(UNLISTED_MODEL, { model: UNLISTED_MODEL, usdPerMtok: 0 })).toEqual({
    usdPerMtok: 0,
    source: EMBEDDING_PRICE_SOURCE.operator,
  });
});

test("a declaration for another model leaves the table answer unchanged", () => {
  const override = { model: "other-model", usdPerMtok: OPERATOR_RATE };
  const unknown = { usdPerMtok: null, source: EMBEDDING_PRICE_SOURCE.unknown };
  expect(resolveEmbeddingPrice(TABLE_MODEL, override)).toEqual({
    usdPerMtok: TABLE_RATE,
    source: EMBEDDING_PRICE_SOURCE.builtin,
  });
  expect(resolveEmbeddingPrice(UNLISTED_MODEL, override)).toEqual(unknown);
  expect(resolveEmbeddingPrice(null, override)).toEqual(unknown);
});

test("estimateCostUsd scales tokens by the quoted rate", () => {
  const quote = resolveEmbeddingPrice(TABLE_MODEL);
  expect(estimateCostUsd(1_000_000, quote)).toBeCloseTo(TABLE_RATE, 9);
  expect(estimateCostUsd(500_000, quote)).toBeCloseTo(TABLE_RATE / 2, 9);
});

test("estimateCostUsd is 0 for a known-free quote and null for an unknown one", () => {
  expect(estimateCostUsd(10_000_000, resolveEmbeddingPrice(LOCAL_EMBEDDING_MODEL))).toBe(0);
  expect(estimateCostUsd(10_000_000, resolveEmbeddingPrice(UNLISTED_MODEL))).toBeNull();
});
