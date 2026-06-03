import { test, expect } from "bun:test";

import {
  embeddingSignature,
  pricePerMillionTokens,
  estimateTokens,
  estimateCostUsd,
  isStaleSignature,
  EMBEDDING_PRICING,
  LOCAL_EMBEDDING_MODEL,
} from "../../../src/core/search/embeddings/signature.ts";

test("embeddingSignature canonicalises provider/model/dimension", () => {
  expect(
    embeddingSignature({
      provider: "openai-compat",
      model: "text-embedding-3-small",
      dimension: 1536,
    }),
  ).toBe("openai-compat:text-embedding-3-small:1536");
});

test("embeddingSignature lowercases and trims provider + model", () => {
  expect(
    embeddingSignature({
      provider: " OpenAI-Compat ",
      model: "  Text-Embedding-3-Small ",
      dimension: 256,
    }),
  ).toBe("openai-compat:text-embedding-3-small:256");
});

test("embeddingSignature renders null model/dimension as a stable sentinel", () => {
  expect(embeddingSignature({ provider: "local", model: null, dimension: null })).toBe("local:?:?");
});

test("two identities with the same fields share a signature; different dim differs", () => {
  const a = embeddingSignature({ provider: "local", model: "hashing-ngram-v1", dimension: 256 });
  const b = embeddingSignature({ provider: "local", model: "hashing-ngram-v1", dimension: 256 });
  const c = embeddingSignature({ provider: "local", model: "hashing-ngram-v1", dimension: 512 });
  expect(a).toBe(b);
  expect(a).not.toBe(c);
});

test("pricePerMillionTokens returns a positive rate for a known remote model", () => {
  expect(pricePerMillionTokens("text-embedding-3-small")).toBeGreaterThan(0);
});

test("pricePerMillionTokens is 0 for the local model and for unknown models", () => {
  expect(pricePerMillionTokens(LOCAL_EMBEDDING_MODEL)).toBe(0);
  expect(pricePerMillionTokens("some-model-nobody-priced")).toBe(0);
  expect(pricePerMillionTokens(null)).toBe(0);
});

test("local model is present in the pricing table at 0", () => {
  expect(EMBEDDING_PRICING[LOCAL_EMBEDDING_MODEL]).toBe(0);
});

test("estimateTokens sums a chars/4 heuristic and rounds up", () => {
  // "abcd" -> 1 token; "abcdefgh" -> 2 tokens.
  expect(estimateTokens(["abcd"])).toBe(1);
  expect(estimateTokens(["abcdefgh"])).toBe(2);
  expect(estimateTokens(["abcde"])).toBe(2); // ceil(5/4)
  expect(estimateTokens([])).toBe(0);
  expect(estimateTokens(["", ""])).toBe(0);
});

test("estimateCostUsd scales tokens by the per-million rate", () => {
  // 1,000,000 tokens * rate == rate USD.
  const rate = pricePerMillionTokens("text-embedding-3-small");
  expect(estimateCostUsd(1_000_000, "text-embedding-3-small")).toBeCloseTo(rate, 9);
  expect(estimateCostUsd(500_000, "text-embedding-3-small")).toBeCloseTo(rate / 2, 9);
});

test("estimateCostUsd is 0 for local/unknown models regardless of token count", () => {
  expect(estimateCostUsd(10_000_000, LOCAL_EMBEDDING_MODEL)).toBe(0);
  expect(estimateCostUsd(10_000_000, "unknown")).toBe(0);
});

test("isStaleSignature is true only when active and stored differ", () => {
  expect(isStaleSignature("local:m:256", "local:m:256")).toBe(false);
  expect(isStaleSignature("local:m:256", "local:m:512")).toBe(true);
  expect(isStaleSignature("openai-compat:a:1536", "local:m:256")).toBe(true);
});
