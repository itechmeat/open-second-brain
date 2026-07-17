/**
 * Coverage-driven targeted self-correcting recall on partial misses
 * (t_8eb5ca32). Extends the zero-candidate broadened retry: when a
 * non-empty first pass leaves rare query terms uncovered (IDF-weighted
 * coverage below the completeness threshold), search issues ONE targeted
 * follow-up built from exactly those uncovered rare terms, merges the
 * recovered candidates, and regenerates the evidence pack. The trigger
 * is deterministic and LLM-free; the pack still abstains on any term
 * left uncovered after the retry.
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";

import { buildCoverageReport, planTargetedRetry } from "../../../src/core/search/coverage.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";
import type { StructuredRecallQueryDocument } from "../../../src/core/search/types.ts";

describe("planTargetedRetry (pure decision)", () => {
  const report = (
    terms: ReadonlyArray<string>,
    covered: ReadonlyArray<string>,
    documentCount: number,
    df: ReadonlyArray<[string, number]>,
  ) =>
    buildCoverageReport({
      significantTerms: terms,
      coveredTerms: new Set(covered),
      documentCount,
      dfByTerm: new Map(df),
    });

  test("does not fire when coverage is complete", () => {
    const cov = report(["alpha", "beta"], ["alpha", "beta"], 10, [
      ["alpha", 3],
      ["beta", 3],
    ]);
    const plan = planTargetedRetry(cov);
    expect(plan.fire).toBe(false);
    expect(plan.terms).toEqual([]);
  });

  test("fires on a partial miss, aimed at the uncovered rare term", () => {
    const cov = report(["warehouse", "rotation", "chandelier"], ["warehouse", "rotation"], 6, [
      ["warehouse", 4],
      ["rotation", 4],
      ["chandelier", 1],
    ]);
    expect(cov.idfWeightedCoverage).toBeLessThan(0.8);
    const plan = planTargetedRetry(cov);
    expect(plan.fire).toBe(true);
    expect(plan.terms).toEqual(["chandelier"]);
  });

  test("the rare gate: a below-threshold miss on only common terms does not fire", () => {
    const cov = report(["alpha", "common"], ["alpha"], 10, [
      ["alpha", 1],
      ["common", 9],
    ]);
    expect(cov.idfWeightedCoverage).toBeLessThan(0.8);
    expect(cov.uncoveredRareTerms).toEqual([]);
    expect(planTargetedRetry(cov).fire).toBe(false);
  });

  test("zero coverage aims at every rare term", () => {
    const cov = report(["fennel", "warehouse"], [], 4, [
      ["fennel", 1],
      ["warehouse", 1],
    ]);
    expect(cov.idfWeightedCoverage).toBe(0);
    expect(planTargetedRetry(cov).terms).toEqual(["fennel", "warehouse"]);
  });
});

describe("targeted recall on a partial miss (integration)", () => {
  let vault: string;
  let dbPath: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ vault, dbPath, cleanup } = createTempVault("targeted-recall"));
  });
  afterEach(() => cleanup());

  // The first-pass keyword lane is restricted to the common terms via a
  // supplied structured query (lex lane omits the rare term), so the
  // pool is NON-EMPTY yet misses the rare term `chandelier` - the
  // partial miss the targeted retry exists for. `chandelier` is still a
  // significant term of the original query, so coverage flags it.
  const structured: StructuredRecallQueryDocument = Object.freeze({
    intent: null,
    lex: Object.freeze({
      include: Object.freeze(["warehouse", "rotation"]) as ReadonlyArray<string>,
      exclude: Object.freeze([]) as ReadonlyArray<string>,
    }),
    vec: Object.freeze(["warehouse rotation"]) as ReadonlyArray<string>,
    hyde: Object.freeze([]) as ReadonlyArray<string>,
  });
  const QUERY = "warehouse rotation chandelier";

  async function seed(): Promise<void> {
    // Four docs make warehouse/rotation common (low IDF); chandelier is
    // unique (high IDF), present in a doc the common-term lane never
    // surfaces.
    writeMd(vault, "Brain/notes/wh1.md", "# WH1\n\nWarehouse rotation schedule, bay seven.\n");
    writeMd(vault, "Brain/notes/wh2.md", "# WH2\n\nWarehouse rotation plan for spring.\n");
    writeMd(vault, "Brain/notes/wh3.md", "# WH3\n\nWarehouse rotation audit notes.\n");
    writeMd(vault, "Brain/notes/wh4.md", "# WH4\n\nWarehouse rotation duties roster.\n");
    writeMd(
      vault,
      "Brain/notes/chandelier.md",
      "# Chandelier\n\nChandelier handoff log, east hall.\n",
    );
    await indexVault(makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1 }));
  }

  test("a partial first pass re-queries the uncovered rare term and recovers it", async () => {
    await seed();
    const config = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1 });
    const outcome = await search(config, {
      query: QUERY,
      evidencePack: true,
      structuredQuery: structured,
    });

    expect(outcome.secondPass?.triggered).toBe(true);
    expect(outcome.secondPass?.kind).toBe("targeted");
    expect(outcome.secondPass?.targetedTerms).toContain("chandelier");
    expect(outcome.secondPass?.added).toBeGreaterThan(0);

    const paths = outcome.results.map((r) => r.path);
    expect(paths).toContain("Brain/notes/chandelier.md");
    // The first-pass common-term docs are still present.
    expect(paths).toContain("Brain/notes/wh1.md");

    // The recovered record carries the targeted attribution; a first-pass
    // hit does not.
    const recovered = outcome.results.find((r) => r.path === "Brain/notes/chandelier.md");
    expect(recovered?.reasons.some((x) => x.startsWith("second_pass: targeted"))).toBe(true);
    const firstPass = outcome.results.find((r) => r.path === "Brain/notes/wh1.md");
    expect(firstPass?.reasons.some((x) => x.startsWith("second_pass:"))).toBe(false);

    // The regenerated pack no longer abstains on the now-covered term.
    expect(outcome.evidencePack?.uncoveredRareTerms ?? []).not.toContain("chandelier");
  });

  test("the kill switch disables the targeted retry", async () => {
    await seed();
    const off = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1, twoPassEnabled: false });
    const outcome = await search(off, {
      query: QUERY,
      evidencePack: true,
      structuredQuery: structured,
    });
    expect(outcome.secondPass).toBeUndefined();
    expect(outcome.results.map((r) => r.path)).not.toContain("Brain/notes/chandelier.md");
    // Conservative on a final miss: the pack still abstains on the rare term.
    expect(outcome.evidencePack?.uncoveredRareTerms ?? []).toContain("chandelier");
  });

  test("a plain (non-evidence-pack) search never retries", async () => {
    await seed();
    const config = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1 });
    const outcome = await search(config, { query: QUERY, structuredQuery: structured });
    expect(outcome.secondPass).toBeUndefined();
  });

  test("a fully-covered first pass never triggers the retry", async () => {
    await seed();
    const config = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1 });
    // No uncovered rare term: the query is exactly the common-term lane.
    const outcome = await search(config, {
      query: "warehouse rotation",
      evidencePack: true,
      structuredQuery: structured,
    });
    expect(outcome.secondPass).toBeUndefined();
    expect(outcome.evidencePack?.abstention ?? null).toBeNull();
  });
});
