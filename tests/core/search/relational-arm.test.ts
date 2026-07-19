/**
 * Typed-edge relational retrieval arm (t_09b7ccea): a relationship-shaped
 * query surfaces related nodes via a bounded typed-edge fan-out when the arm
 * is enabled in rrf fusion; the arm is byte-identical when off (default).
 */

import { test, expect, beforeEach, afterEach } from "bun:test";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

const project = (o: Awaited<ReturnType<typeof search>>) =>
  o.results.map((r) => ({ path: r.path, score: r.score, reasons: r.reasons }));

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  const v = createTempVault("relational-arm");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
});

afterEach(() => {
  cleanup();
});

async function build() {
  // seed --related--> neighbor --extends--> far
  writeMd(vault, "seed.md", '---\nrelated: "[[neighbor]]"\n---\n\nalpha topic seed document.');
  writeMd(vault, "neighbor.md", '---\nextends: "[[far]]"\n---\n\nbeta divergent content.');
  writeMd(vault, "far.md", "# Far\n\ngamma distant content.");
  writeMd(vault, "noise.md", "# Noise\n\ndelta irrelevant content.");
  await indexVault(makeConfig({ vault, dbPath }));
}

test("relationship query surfaces the related node with attribution (arm on, rrf)", async () => {
  await build();
  const cfg = makeConfig({ vault, dbPath, fusionMode: "rrf", relationalArmEnabled: true });
  const outcome = await search(cfg, { query: "alpha [[seed]] related" });
  const neighbor = outcome.results.find((r) => r.path === "neighbor.md");
  expect(neighbor).toBeDefined();
  expect(neighbor!.reasons.some((x) => x.startsWith("relational:"))).toBe(true);
});

test("depth-2 fan-out reaches a two-hop node when its edge type is named", async () => {
  await build();
  const cfg = makeConfig({ vault, dbPath, fusionMode: "rrf", relationalArmEnabled: true });
  const outcome = await search(cfg, { query: "alpha [[seed]] related extends" });
  expect(outcome.results.some((r) => r.path === "far.md")).toBe(true);
});

test("arm off (default) does not surface the related node (byte-identical)", async () => {
  await build();
  const cfgOff = makeConfig({ vault, dbPath, fusionMode: "rrf" });
  const outcome = await search(cfgOff, { query: "alpha [[seed]] related" });
  expect(outcome.results.some((r) => r.path === "neighbor.md")).toBe(false);
});

test("a non-relational query is byte-identical between arm on and off (rrf)", async () => {
  await build();
  const cfgOff = makeConfig({ vault, dbPath, fusionMode: "rrf" });
  const cfgOn = makeConfig({ vault, dbPath, fusionMode: "rrf", relationalArmEnabled: true });
  const off = await search(cfgOff, { query: "alpha topic" });
  const on = await search(cfgOn, { query: "alpha topic" });
  expect(project(on)).toEqual(project(off));
});
