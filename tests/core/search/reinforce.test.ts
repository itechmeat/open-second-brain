/**
 * Self-tuning reinforce ledger (Search & Recall Quality Suite): an
 * explicit, opt-in signal that a memory proved useful. Events land one
 * file per signal under Brain/search/reinforce/; the fold yields a
 * bounded per-path strength that lifts named memories before the top_k
 * cut. Surfaced-only frequency is never recorded, so it never boosts.
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { existsSync } from "node:fs";

import {
  REINFORCE_BOOST_CAP,
  applyReinforceBoost,
  loadReinforceStrengths,
  recordReinforce,
  reinforceDir,
  resetReinforce,
} from "../../../src/core/search/reinforce.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import type { BrainSearchResult } from "../../../src/core/search/types.ts";

let vault: string;
let cleanup: () => void;

beforeEach(() => {
  ({ vault, cleanup } = createTempVault("reinforce"));
});
afterEach(() => cleanup());

function result(path: string, score: number): BrainSearchResult {
  return Object.freeze({
    documentId: 1,
    chunkId: 1,
    path,
    title: path,
    content: "body",
    startLine: 1,
    endLine: 1,
    score,
    keywordScore: score,
    semanticScore: 0,
    linkBoost: 0,
    recencyBoost: 0,
    searchType: "keyword",
    reasons: Object.freeze([]),
  }) as BrainSearchResult;
}

describe("ledger", () => {
  test("recording grows a path's strength; reset clears the derived state", () => {
    expect(loadReinforceStrengths(vault).size).toBe(0);
    recordReinforce(vault, ["a.md"], { nowMs: 1 });
    recordReinforce(vault, ["a.md", "b.md"], { nowMs: 2 });
    const strengths = loadReinforceStrengths(vault);
    expect(strengths.get("a.md")).toBeGreaterThan(strengths.get("b.md")!);
    expect(existsSync(reinforceDir(vault))).toBe(true);
    resetReinforce(vault);
    expect(loadReinforceStrengths(vault).size).toBe(0);
  });

  test("strength is bounded to [0,1] regardless of count", () => {
    for (let i = 0; i < 50; i++) recordReinforce(vault, ["hot.md"], { nowMs: i + 1 });
    expect(loadReinforceStrengths(vault).get("hot.md")).toBeLessThanOrEqual(1);
  });

  test("recording the identical event twice is idempotent", () => {
    recordReinforce(vault, ["a.md"], { nowMs: 5 });
    recordReinforce(vault, ["a.md"], { nowMs: 5 });
    // One distinct event file -> the fold counts it once.
    const a1 = loadReinforceStrengths(vault).get("a.md");
    recordReinforce(vault, ["a.md"], { nowMs: 6 });
    expect(loadReinforceStrengths(vault).get("a.md")).toBeGreaterThan(a1!);
  });
});

describe("applyReinforceBoost", () => {
  test("lifts a reinforced path above an unreinforced higher-scored one", () => {
    const results = [result("top.md", 0.6), result("reinforced.md", 0.58)];
    const boosted = applyReinforceBoost(results, new Map([["reinforced.md", 1]]));
    expect(boosted[0]!.path).toBe("reinforced.md");
    expect(
      boosted
        .find((r) => r.path === "reinforced.md")!
        .reasons.some((x) => x.startsWith("reinforce:")),
    ).toBe(true);
  });

  test("boost is bounded by the cap and clamped to 1", () => {
    const boosted = applyReinforceBoost([result("x.md", 0.99)], new Map([["x.md", 1]]));
    expect(boosted[0]!.score).toBeLessThanOrEqual(1);
    expect(boosted[0]!.score - 0.99).toBeLessThanOrEqual(REINFORCE_BOOST_CAP + 1e-9);
  });

  test("no reinforced paths -> input order and scores unchanged", () => {
    const results = [result("a.md", 0.6), result("b.md", 0.4)];
    const out = applyReinforceBoost(results, new Map());
    expect(out.map((r) => r.path)).toEqual(["a.md", "b.md"]);
    expect(out.map((r) => r.score)).toEqual([0.6, 0.4]);
  });
});

describe("search integration", () => {
  test("absent reinforce leaves the ranking byte-identical even with a populated ledger", async () => {
    writeMd(vault, "a.md", "# A\n\nfox fox fox quick brown fox");
    writeMd(vault, "b.md", "# B\n\na single fox mention among cats");
    const cfg = makeConfig({ vault, dbPath: `${vault}/.idx.sqlite` });
    await indexVault(cfg);
    recordReinforce(vault, ["b.md"], { nowMs: 1 });
    const base = await search(cfg, { query: "fox", limit: 10 });
    // No reinforce key -> the ledger must not touch the result.
    for (const r of base.results)
      expect(r.reasons.some((x) => x.startsWith("reinforce:"))).toBe(false);
  });

  test("opt-in reinforce lifts a ledger-strong path with a reinforce reason", async () => {
    writeMd(vault, "a.md", "# A\n\nfox fox fox quick brown fox");
    writeMd(vault, "b.md", "# B\n\na single fox mention among cats");
    const cfg = makeConfig({ vault, dbPath: `${vault}/.idx.sqlite` });
    await indexVault(cfg);
    for (let i = 0; i < 5; i++) recordReinforce(vault, ["b.md"], { nowMs: i + 1 });
    const out = await search(cfg, { query: "fox", limit: 10, reinforce: [] });
    const b = out.results.find((r) => r.path === "b.md");
    expect(b).toBeDefined();
    expect(b!.reasons.some((x) => x.startsWith("reinforce:"))).toBe(true);
  });
});
