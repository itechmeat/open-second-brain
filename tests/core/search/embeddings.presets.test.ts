import { test, expect } from "bun:test";

import {
  EMBEDDING_MODEL_PRESETS,
  RECOMMENDED_EMBEDDING_MODEL,
  findEmbeddingPreset,
} from "../../../src/core/search/embeddings/presets.ts";

test("the catalog is non-empty and multilingual-first", () => {
  expect(EMBEDDING_MODEL_PRESETS.length).toBeGreaterThan(0);
  expect(EMBEDDING_MODEL_PRESETS[0]!.multilingual).toBe(true);
});

test("every preset carries a stable positive dimension and a note", () => {
  for (const p of EMBEDDING_MODEL_PRESETS) {
    expect(p.model.trim()).not.toBe("");
    expect(p.label.trim()).not.toBe("");
    expect(p.dimension).toBeGreaterThan(0);
    expect(p.note.trim()).not.toBe("");
  }
});

test("model strings are unique", () => {
  const models = EMBEDDING_MODEL_PRESETS.map((p) => p.model);
  expect(new Set(models).size).toBe(models.length);
});

test("the recommended default is one of the presets", () => {
  expect(findEmbeddingPreset(RECOMMENDED_EMBEDDING_MODEL)).not.toBeNull();
});

test("findEmbeddingPreset returns null for a custom model", () => {
  expect(findEmbeddingPreset("acme/custom-embed-9000")).toBeNull();
});
