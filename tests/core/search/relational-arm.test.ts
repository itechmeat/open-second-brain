/**
 * Typed-edge relational retrieval arm (t_09b7ccea): a relationship-shaped
 * query surfaces related nodes via a bounded typed-edge fan-out when the arm
 * is enabled in rrf fusion; the arm is byte-identical when off (default).
 */

import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";

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

test("arm off (default) is byte-identical to arm on (rrf) except arm-attributable entries", async () => {
  await build();
  const cfgOff = makeConfig({ vault, dbPath, fusionMode: "rrf" });
  const cfgOn = makeConfig({ vault, dbPath, fusionMode: "rrf", relationalArmEnabled: true });
  // Freeze the clock across both calls: recency decay is a continuous
  // function of wall-clock time, so two real Date.now() reads even a
  // millisecond apart would perturb the low-order digits of `score` for
  // reasons that have nothing to do with the relational arm under test.
  const nowMs = Date.now();
  const dateNowSpy = spyOn(Date, "now").mockReturnValue(nowMs);
  try {
    const off = await search(cfgOff, { query: "alpha [[seed]] related" });
    const on = await search(cfgOn, { query: "alpha [[seed]] related" });
    // Strip out only the entries the arm itself attributes (its "relational:"
    // reason), then require the FULL projection of what remains - paths,
    // scores, reasons, and order - to equal the arm-off run exactly.
    const onMinusArm = on.results
      .filter((r) => !r.reasons.some((x) => x.startsWith("relational:")))
      .map((r) => ({ path: r.path, score: r.score, reasons: r.reasons }));
    expect(onMinusArm).toEqual(project(off));
  } finally {
    dateNowSpy.mockRestore();
  }
});

test("relationalArmEnabled under a non-rrf fusion mode is byte-identical to flag-off (gate requires rrf)", async () => {
  await build();
  const cfgOff = makeConfig({ vault, dbPath, fusionMode: "linear" });
  const cfgOnLinear = makeConfig({
    vault,
    dbPath,
    fusionMode: "linear",
    relationalArmEnabled: true,
  });
  const nowMs = Date.now();
  const dateNowSpy = spyOn(Date, "now").mockReturnValue(nowMs);
  try {
    const off = await search(cfgOff, { query: "alpha [[seed]] related" });
    const onLinear = await search(cfgOnLinear, { query: "alpha [[seed]] related" });
    expect(project(onLinear)).toEqual(project(off));
  } finally {
    dateNowSpy.mockRestore();
  }
});

test("a non-relational query is byte-identical between arm on and off (rrf)", async () => {
  await build();
  const cfgOff = makeConfig({ vault, dbPath, fusionMode: "rrf" });
  const cfgOn = makeConfig({ vault, dbPath, fusionMode: "rrf", relationalArmEnabled: true });
  const off = await search(cfgOff, { query: "alpha topic" });
  const on = await search(cfgOn, { query: "alpha topic" });
  expect(project(on)).toEqual(project(off));
});
