/**
 * Co-access reinforcement (Time-Aware Recall & Activation Suite,
 * t_c5ef25a3): documents habitually surfaced together gain a bounded
 * companion boost when they appear in the same candidate pool.
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";

import { recordAccessEvent } from "../../../src/core/search/activation/store.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

const QUERY = "lattice resonance";

function coAccessReason(reasons: ReadonlyArray<string>): number | null {
  const entry = reasons.find((r) => r.startsWith("co_access: "));
  if (entry === undefined) return null;
  return Number(entry.slice("co_access: ".length));
}

async function seed(): Promise<void> {
  writeMd(vault, "Brain/notes/alpha.md", "# Alpha\n\nLattice resonance survey, alpha rig.\n");
  writeMd(vault, "Brain/notes/beta.md", "# Beta\n\nLattice resonance survey, beta rig.\n");
  writeMd(vault, "Brain/notes/gamma.md", "# Gamma\n\nLattice resonance survey, gamma rig.\n");
  writeMd(vault, "Brain/notes/offside.md", "# Offside\n\nUnrelated marsh cartography.\n");
  const config = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1 });
  await indexVault(config);
}

function coAccess(times: number, paths: string[]): void {
  const now = Date.now();
  for (let i = 0; i < times; i++) {
    recordAccessEvent(vault, { ts: now - i * 1000, queryHash: "feed0001", paths });
  }
}

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("co-access"));
});

afterEach(() => {
  cleanup();
});

describe("co-access companion boost", () => {
  test("habitual companions in the same pool gain a bounded co_access reason", async () => {
    await seed();
    coAccess(3, ["Brain/notes/beta.md", "Brain/notes/gamma.md"]);
    const config = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1 });
    const outcome = await search(config, { query: QUERY, limit: 10 });
    const beta = outcome.results.find((r) => r.path === "Brain/notes/beta.md");
    const gamma = outcome.results.find((r) => r.path === "Brain/notes/gamma.md");
    const alpha = outcome.results.find((r) => r.path === "Brain/notes/alpha.md");
    expect(coAccessReason(beta!.reasons)).toBeGreaterThan(0);
    expect(coAccessReason(gamma!.reasons)).toBeGreaterThan(0);
    expect(coAccessReason(beta!.reasons)!).toBeLessThanOrEqual(0.03);
    expect(coAccessReason(alpha!.reasons)).toBeNull();
  });

  test("a single co-occurrence is below the noise threshold", async () => {
    await seed();
    coAccess(1, ["Brain/notes/beta.md", "Brain/notes/gamma.md"]);
    const config = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1 });
    const outcome = await search(config, { query: QUERY, limit: 10 });
    expect(outcome.results.every((r) => coAccessReason(r.reasons) === null)).toBe(true);
  });

  test("a companion outside the candidate pool contributes nothing", async () => {
    await seed();
    coAccess(3, ["Brain/notes/beta.md", "Brain/notes/offside.md"]);
    const config = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1 });
    const outcome = await search(config, { query: QUERY, limit: 10 });
    expect(outcome.results.some((r) => r.path === "Brain/notes/offside.md")).toBe(false);
    expect(outcome.results.every((r) => coAccessReason(r.reasons) === null)).toBe(true);
  });

  test("the kill switch suppresses companion boosts", async () => {
    await seed();
    coAccess(3, ["Brain/notes/beta.md", "Brain/notes/gamma.md"]);
    const off = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1, activationEnabled: false });
    const outcome = await search(off, { query: QUERY, limit: 10 });
    expect(outcome.results.every((r) => coAccessReason(r.reasons) === null)).toBe(true);
  });
});
