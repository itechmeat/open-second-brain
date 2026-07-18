import { test, expect } from "bun:test";

import { assertValidVector } from "../../../src/core/search/vector-guard.ts";
import { unitNormaliseInPlace } from "../../../src/core/search/embeddings/http-util.ts";
import { SearchError } from "../../../src/core/search/types.ts";

test("assertValidVector accepts a finite, non-zero vector", () => {
  expect(() => assertValidVector([0.1, 0, -0.3, 1], "unit-test")).not.toThrow();
  expect(() => assertValidVector(Float32Array.from([0, 0, 1]), "unit-test")).not.toThrow();
});

test("assertValidVector rejects a NaN component with the context and index", () => {
  try {
    assertValidVector([1, Number.NaN, 3], "vecUpsert");
    throw new Error("expected throw");
  } catch (e) {
    expect(e).toBeInstanceOf(SearchError);
    const err = e as SearchError;
    expect(err.code).toBe("EMBEDDING_INVALID_VECTOR");
    expect(err.message).toContain("vecUpsert");
    expect(err.message).toContain("1"); // offending index
  }
});

test("assertValidVector rejects an Infinity component", () => {
  const call = () => assertValidVector([0, Number.POSITIVE_INFINITY], "semanticTopK");
  expect(call).toThrow(SearchError);
  expect(call).toThrow(/semanticTopK/);
});

test("assertValidVector rejects an all-zero vector", () => {
  try {
    assertValidVector([0, 0, 0, 0], "vecUpsert");
    throw new Error("expected throw");
  } catch (e) {
    expect(e).toBeInstanceOf(SearchError);
    expect((e as SearchError).code).toBe("EMBEDDING_INVALID_VECTOR");
    expect((e as SearchError).message).toMatch(/zero/i);
  }
});

test("assertValidVector rejects an empty vector", () => {
  const call = () => assertValidVector([], "vecUpsert");
  expect(call).toThrow(SearchError);
  expect(call).toThrow(/empty/i);
});

test("unitNormaliseInPlace throws EMBEDDING_INVALID_VECTOR on zero-norm input", () => {
  try {
    unitNormaliseInPlace([0, 0, 0]);
    throw new Error("expected throw");
  } catch (e) {
    expect(e).toBeInstanceOf(SearchError);
    expect((e as SearchError).code).toBe("EMBEDDING_INVALID_VECTOR");
  }
});

test("unitNormaliseInPlace throws on non-finite input", () => {
  const call = () => unitNormaliseInPlace([1, Number.NaN, 2]);
  expect(call).toThrow(SearchError);
  expect(call).toThrow(/EMBEDDING_INVALID_VECTOR|unitNormalise/i);
});

test("unitNormaliseInPlace still normalises a valid vector to unit length", () => {
  const v = unitNormaliseInPlace([3, 4]);
  const norm = Math.hypot(...v);
  expect(norm).toBeCloseTo(1, 10);
});
