/**
 * Self-correcting two-pass recall (Time-Aware Recall & Activation
 * Suite, t_ef92dfdc): a zero-candidate first pass in evidence-pack
 * mode triggers exactly one broadened OR retry instead of dead-ending
 * in an abstention.
 */

import { test, expect, beforeEach, afterEach, describe, setSystemTime } from "bun:test";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

async function seed(): Promise<void> {
  writeMd(vault, "Brain/notes/fennel.md", "# Fennel\n\nFennel inventory ledger for the cellar.\n");
  writeMd(
    vault,
    "Brain/notes/warehouse.md",
    "# Warehouse\n\nWarehouse rotation schedule, bay seven.\n",
  );
  const config = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1 });
  await indexVault(config);
}

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("two-pass"));
});

afterEach(() => {
  cleanup();
});

describe("two-pass recall", () => {
  test("a zero-candidate evidence query broadens once and recovers results", async () => {
    await seed();
    const config = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1 });
    // Implicit-AND keyword matching finds no chunk with BOTH terms.
    const strict = await search(config, { query: "fennel warehouse" });
    expect(strict.results).toHaveLength(0);
    // Evidence-pack mode converts the dead end into a broadened retry.
    const outcome = await search(config, { query: "fennel warehouse", evidencePack: true });
    const paths = outcome.results.map((r) => r.path);
    expect(paths).toContain("Brain/notes/fennel.md");
    expect(paths).toContain("Brain/notes/warehouse.md");
    expect(outcome.secondPass?.triggered).toBe(true);
    expect(outcome.secondPass?.added).toBeGreaterThan(0);
    expect(outcome.results.every((r) => r.reasons.some((x) => x.startsWith("second_pass: ")))).toBe(
      true,
    );
    // The pack is recomputed over the recovered results.
    expect(outcome.evidencePack?.records.length).toBeGreaterThan(0);
  });

  test("plain searches never broaden", async () => {
    await seed();
    const config = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1 });
    const outcome = await search(config, { query: "fennel warehouse" });
    expect(outcome.results).toHaveLength(0);
    expect(outcome.secondPass).toBeUndefined();
  });

  test("the kill switch disables the retry", async () => {
    await seed();
    const off = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1, twoPassEnabled: false });
    const outcome = await search(off, { query: "fennel warehouse", evidencePack: true });
    expect(outcome.results).toHaveLength(0);
    expect(outcome.secondPass).toBeUndefined();
    expect(outcome.evidencePack?.abstention).not.toBeNull();
  });

  test("a single-term query has nothing to broaden", async () => {
    await seed();
    const config = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1 });
    const outcome = await search(config, { query: "zubrowka", evidencePack: true });
    expect(outcome.results).toHaveLength(0);
    expect(outcome.secondPass).toBeUndefined();
  });

  test("a successful first pass never triggers the retry", async () => {
    await seed();
    const config = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1 });
    const outcome = await search(config, { query: "fennel inventory", evidencePack: true });
    expect(outcome.results.length).toBeGreaterThan(0);
    expect(outcome.secondPass).toBeUndefined();
    expect(
      outcome.results.every((r) => !r.reasons.some((x) => x.startsWith("second_pass: "))),
    ).toBe(true);
  });
});

// ----- Iterative outcome observability (recall-quality wave, lane A) ------

describe("iterative outcome observability", () => {
  // A pinned clock must never outlive the test that pinned it: this file
  // runs in the same process as every other suite, and a shifted wall
  // clock would poison theirs.
  afterEach(() => setSystemTime());
  /** Six common docs anchor the match; the relic docs are the loop's recoverable mass. */
  async function seedRelic(): Promise<void> {
    for (let i = 1; i <= 6; i++) {
      writeMd(
        vault,
        `Brain/notes/wh${i}.md`,
        `# WH${i}\n\nWarehouse rotation schedule, bay ${i}.\n`,
      );
    }
    for (const term of ["relic01", "relic02", "relic03", "relic04"]) {
      writeMd(vault, `Brain/notes/${term}.md`, `# ${term}\n\n${term} provenance record.\n`);
    }
    const base = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1, twoPassEnabled: false });
    await indexVault(base);
  }

  const STOP_REASONS = new Set([
    "coverage_complete",
    "no_sub_query",
    "no_progress",
    "round_cap",
    "marginal_value",
    "deadline",
    "decider_round",
  ]);

  test("a loop that ran rounds reports per-round counts and a stop reason on the outcome", async () => {
    await seedRelic();
    const base = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1, twoPassEnabled: false });
    const config = {
      ...base,
      recall: { ...base.recall, iterativeRecallEnabled: true, iterativeRecallMaxRounds: 1 },
    } as typeof base;
    const outcome = await search(config, {
      query: "warehouse rotation relic01 relic02 relic03 relic04",
      iterative: true,
    });
    const iterative = outcome.iterative;
    expect(iterative).toBeDefined();
    if (iterative === undefined) throw new Error("unreachable");
    expect(iterative.phase).toBe("final");
    if (iterative.phase !== "final") throw new Error("unreachable");
    // The loop's rounds ride the field with their honest accounting.
    expect(iterative.rounds.length).toBeGreaterThanOrEqual(1);
    for (const [index, round] of iterative.rounds.entries()) {
      expect(round.round).toBe(2 + index);
      expect(round.author).toBe("deterministic");
      expect(Array.isArray(round.terms)).toBe(true);
      expect(round.groups).toBeGreaterThanOrEqual(1);
      expect(typeof round.added).toBe("number");
      expect(typeof round.elapsedMs).toBe("number");
    }
    expect(STOP_REASONS.has(iterative.stopReason)).toBe(true);
    // The observability rides the FIELD: no new attribution reason string.
    for (const r of outcome.results) {
      for (const reason of r.reasons) {
        expect(reason.startsWith("iterative")).toBe(false);
      }
    }
    // Mode off: the same query carries no marker at all.
    const off = await search(base, {
      query: "warehouse rotation relic01 relic02 relic03 relic04",
    });
    expect(off.iterative).toBeUndefined();
  });

  test("an inert loop adds no field, byte-identical to the mode-off outcome", async () => {
    await seedRelic();
    const base = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1, twoPassEnabled: false });
    const config = {
      ...base,
      recall: { ...base.recall, iterativeRecallEnabled: true },
    } as typeof base;
    const query = "warehouse rotation";
    // Pin the wall clock: the recency boost reads Date.now() per call, so
    // two searches a millisecond apart differ in float noise that has
    // nothing to do with the mode.
    try {
      setSystemTime(1_750_000_000_000);
      const off = await search(base, { query });
      setSystemTime(1_750_000_000_000);
      const on = await search(config, { query, iterative: true });
      expect(on.iterative).toBeUndefined();
      expect(JSON.stringify(on)).toBe(JSON.stringify(off));
    } finally {
      setSystemTime();
    }
  });
});
