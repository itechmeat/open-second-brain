/**
 * Relevance threshold + rerank (Search & Recall Quality Suite): an
 * opt-in score floor drops weak hits (returning no match when nothing is
 * relevant enough), and an opt-in rerank re-orders the qualified set by
 * core textual relevance. Both off by default keep results byte-identical.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { SearchError } from "../../../src/core/search/types.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("threshold"));
  writeMd(vault, "strong.md", "# Strong\n\nfox fox fox fox the quick brown fox jumps.");
  writeMd(vault, "weak.md", "# Weak\n\nA note mostly about cats, with one fox mention.");
  writeMd(vault, "none.md", "# None\n\nTurtles and cats only.");
});
afterEach(() => cleanup());

test("threshold absent keeps results byte-identical", async () => {
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg);
  const base = await search(cfg, { query: "fox", limit: 10 });
  const withZero = await search(cfg, { query: "fox", limit: 10, threshold: 0 });
  expect(withZero.results.map((r) => r.path)).toEqual(base.results.map((r) => r.path));
});

test("a floor between the top and bottom scores drops the weak hits", async () => {
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg);
  const base = await search(cfg, { query: "fox", limit: 10 });
  expect(base.results.length).toBeGreaterThanOrEqual(2);
  const scores = base.results.map((r) => r.score);
  const top = scores[0]!;
  const bottom = scores[scores.length - 1]!;
  expect(top).toBeGreaterThan(bottom);
  const floor = (top + bottom) / 2;
  const filtered = await search(cfg, { query: "fox", limit: 10, threshold: floor });
  expect(filtered.results.length).toBeLessThan(base.results.length);
  expect(filtered.results.length).toBeGreaterThan(0);
  for (const r of filtered.results) expect(r.score).toBeGreaterThanOrEqual(floor);
});

test("a floor above every score returns no match", async () => {
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg);
  const out = await search(cfg, { query: "fox", limit: 10, threshold: 1.0001 });
  expect(out.results).toEqual([]);
  expect(out.total).toBe(0);
});

test("a negative threshold is rejected", async () => {
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg);
  await expect(search(cfg, { query: "fox", limit: 10, threshold: -1 })).rejects.toBeInstanceOf(
    SearchError,
  );
});

test("rerank does not change the returned membership, only ordering", async () => {
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg);
  const base = await search(cfg, { query: "fox", limit: 10 });
  const reranked = await search(cfg, { query: "fox", limit: 10, rerank: true });
  expect(reranked.results.map((r) => r.path).toSorted()).toEqual(
    base.results.map((r) => r.path).toSorted(),
  );
});
