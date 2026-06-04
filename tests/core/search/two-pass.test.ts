/**
 * Self-correcting two-pass recall (Time-Aware Recall & Activation
 * Suite, t_ef92dfdc): a zero-candidate first pass in evidence-pack
 * mode triggers exactly one broadened OR retry instead of dead-ending
 * in an abstention.
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";

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
