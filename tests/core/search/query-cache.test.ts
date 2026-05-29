import { test, expect } from "bun:test";
import { buildCacheKey } from "../../../src/core/search/query-cache.ts";
import type { SearchOptions } from "../../../src/core/search/types.ts";

const opts = (o: Partial<SearchOptions>): SearchOptions => ({ query: "alpha", ...o });

test("identical request, plan, and config fingerprint produce the same key", () => {
  expect(buildCacheKey(opts({}), "plan1", "fp1")).toBe(buildCacheKey(opts({}), "plan1", "fp1"));
});

test("a different query changes the key", () => {
  expect(buildCacheKey(opts({ query: "alpha" }), "p", "fp")).not.toBe(
    buildCacheKey(opts({ query: "beta" }), "p", "fp"),
  );
});

test("a different limit changes the key", () => {
  expect(buildCacheKey(opts({ limit: 10 }), "p", "fp")).not.toBe(
    buildCacheKey(opts({ limit: 20 }), "p", "fp"),
  );
});

test("a different plan hash changes the key", () => {
  expect(buildCacheKey(opts({}), "planA", "fp")).not.toBe(buildCacheKey(opts({}), "planB", "fp"));
});

test("a different config fingerprint changes the key", () => {
  expect(buildCacheKey(opts({}), "p", "fpA")).not.toBe(buildCacheKey(opts({}), "p", "fpB"));
});

test("property-filter order does not change the key (canonical)", () => {
  const a = buildCacheKey(opts({ properties: new Map([["k", ["1", "2"]]]) }), "p", "fp");
  const b = buildCacheKey(opts({ properties: new Map([["k", ["2", "1"]]]) }), "p", "fp");
  expect(a).toBe(b);
});
