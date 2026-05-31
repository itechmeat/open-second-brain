import { test, expect } from "bun:test";
import { computeCorpusGeneration } from "../../../src/core/search/corpus-generation.ts";

const base = {
  embeddingModel: "text-embed-3",
  embeddingDimension: 1536,
  schemaVersion: 4,
  indexRevision: 7,
};

test("identical inputs produce an identical fingerprint", () => {
  expect(computeCorpusGeneration(base)).toBe(computeCorpusGeneration({ ...base }));
});

test("a different embedding model changes the fingerprint", () => {
  expect(computeCorpusGeneration({ ...base, embeddingModel: "other" })).not.toBe(
    computeCorpusGeneration(base),
  );
});

test("a different embedding dimension changes the fingerprint", () => {
  expect(computeCorpusGeneration({ ...base, embeddingDimension: 768 })).not.toBe(
    computeCorpusGeneration(base),
  );
});

test("a different schema version changes the fingerprint", () => {
  expect(computeCorpusGeneration({ ...base, schemaVersion: 5 })).not.toBe(
    computeCorpusGeneration(base),
  );
});

test("a bumped index revision (content reindex) changes the fingerprint", () => {
  expect(computeCorpusGeneration({ ...base, indexRevision: 8 })).not.toBe(
    computeCorpusGeneration(base),
  );
});

test("a null model / dimension (keyword-only vault) is stable and distinct from a set one", () => {
  const keywordOnly = {
    embeddingModel: null,
    embeddingDimension: null,
    schemaVersion: 4,
    indexRevision: 1,
  };
  expect(computeCorpusGeneration(keywordOnly)).toBe(computeCorpusGeneration({ ...keywordOnly }));
  expect(computeCorpusGeneration(keywordOnly)).not.toBe(computeCorpusGeneration(base));
});
