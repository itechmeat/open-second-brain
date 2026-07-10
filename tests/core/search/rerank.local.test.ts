import { test, expect } from "bun:test";

import { LocalRerankProvider, scoreLocalRerank } from "../../../src/core/search/rerank/local.ts";
import { applyCrossEncoderRerank } from "../../../src/core/search/rerank/index.ts";
import type { BrainSearchResult, ResolvedRerankConfig } from "../../../src/core/search/types.ts";

const LOCAL: ResolvedRerankConfig = Object.freeze({
  enabled: true,
  kind: "local",
  baseUrl: null,
  model: null,
  envKey: null,
  apiKey: null,
  topK: 20,
  minScore: 0,
});

function result(id: number, content: string): BrainSearchResult {
  return Object.freeze({
    documentId: id,
    chunkId: id,
    path: `${id}.md`,
    title: null,
    content,
    startLine: 1,
    endLine: 1,
    score: 1 / id,
    keywordScore: 0,
    semanticScore: 0,
    linkBoost: 0,
    recencyBoost: 0,
    searchType: "keyword" as const,
    reasons: Object.freeze([]),
  });
}

test("scoreLocalRerank rewards more query-term coverage", () => {
  const both = scoreLocalRerank("gradient descent", "gradient descent optimizes the loss");
  const one = scoreLocalRerank("gradient descent", "gradient boosting is different");
  const none = scoreLocalRerank("gradient descent", "turtles migrate across oceans");
  expect(both).toBeGreaterThan(one);
  expect(one).toBeGreaterThan(none);
  expect(none).toBe(0);
});

test("scoreLocalRerank is deterministic and bounded to [0,1]", () => {
  const a = scoreLocalRerank("neural network", "a neural network learns");
  const b = scoreLocalRerank("neural network", "a neural network learns");
  expect(a).toBe(b);
  expect(a).toBeGreaterThanOrEqual(0);
  expect(a).toBeLessThanOrEqual(1);
});

test("LocalRerankProvider returns one score per document, in input order", async () => {
  const p = new LocalRerankProvider();
  const scores = await p.rerank("alpha beta", ["nothing here", "alpha beta gamma", "alpha only"]);
  expect(scores.length).toBe(3);
  expect(scores[1]).toBeGreaterThan(scores[2]!);
  expect(scores[2]).toBeGreaterThan(scores[0]!);
});

test("applyCrossEncoderRerank with kind 'local' reorders offline (no endpoint)", async () => {
  const results = [
    result(1, "turtles and oceans, unrelated"),
    result(2, "machine learning with gradient descent"),
    result(3, "gradient partially mentioned"),
  ];
  const reordered = await applyCrossEncoderRerank(results, "gradient descent", LOCAL);
  // The best lexical match for "gradient descent" is doc 2; it must lead.
  expect(reordered[0]!.path).toBe("2.md");
  expect(reordered.length).toBe(3);
  expect(reordered[0]!.reasons.some((r) => r.startsWith("cross_encoder:"))).toBe(true);
});

test("disabled rerank returns the identical reference (byte-identical)", async () => {
  const results = [result(1, "a"), result(2, "b")];
  const out = await applyCrossEncoderRerank(results, "q", { ...LOCAL, enabled: false });
  expect(out).toBe(results);
});
