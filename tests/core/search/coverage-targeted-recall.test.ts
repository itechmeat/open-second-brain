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

import {
  buildCoverageReport,
  planSubQueryGroups,
  planTargetedRetry,
} from "../../../src/core/search/coverage.ts";
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

  // ----- k-group generalization (recall-quality wave, lane A) ---------------

  /**
   * Three uncovered rare terms in query order with distinct IDF weights:
   * alcor is the most significant (df 1 of 1000), then zubrowka (df 5),
   * then mizar (df 10) - all within the 2% rare share of 20 documents.
   */
  const threeGaps = report(["mizar", "alcor", "zubrowka"], [], 1000, [
    ["mizar", 10],
    ["alcor", 1],
    ["zubrowka", 5],
  ]);

  test("emits one singleton group per uncovered rare term, ordered by significance", () => {
    const plan = planSubQueryGroups(threeGaps, 3);
    expect(plan.fire).toBe(true);
    expect(plan.groups).toHaveLength(3);
    // Most significant term first.
    expect(plan.groups[0]!.terms).toEqual(["alcor"]);
    expect(plan.groups[1]!.terms).toEqual(["zubrowka"]);
    expect(plan.groups[2]!.terms).toEqual(["mizar"]);
    // Significance descends across the ordered groups.
    expect(plan.groups[0]!.significance).toBeGreaterThan(plan.groups[1]!.significance);
    expect(plan.groups[1]!.significance).toBeGreaterThan(plan.groups[2]!.significance);
  });

  test("caps at k groups: the top term earns a singleton, the residual merges in query order", () => {
    const plan = planSubQueryGroups(threeGaps, 2);
    expect(plan.groups).toHaveLength(2);
    // The dedicated singleton goes to the highest-IDF term; the residual
    // keeps the historical merged-group shape (query order).
    expect(plan.groups.map((g) => g.terms)).toEqual([["mizar", "zubrowka"], ["alcor"]]);
    // Groups are ordered by significance: the merged pair outweighs the
    // singleton here (idf(10) + idf(5) > idf(1)).
    expect(plan.groups[0]!.significance).toBeGreaterThan(plan.groups[1]!.significance);
  });

  test("a single group reproduces the frozen round-two shape byte-identically", () => {
    // The k=1 projection IS today's targeted retry: one merged group, all
    // uncovered rare terms in query order, same fire gate.
    const single = planSubQueryGroups(threeGaps, 1);
    expect(single.fire).toBe(true);
    expect(single.groups).toHaveLength(1);
    expect(single.groups[0]!.terms).toEqual(["mizar", "alcor", "zubrowka"]);
    const legacy = planTargetedRetry(threeGaps);
    expect(legacy.fire).toBe(true);
    expect(legacy.terms).toEqual(single.groups[0]!.terms);
    // Frozen fixture: the historical decision on the documented partial
    // miss, unchanged by the generalization.
    const chandelier = report(
      ["warehouse", "rotation", "chandelier"],
      ["warehouse", "rotation"],
      6,
      [
        ["warehouse", 4],
        ["rotation", 4],
        ["chandelier", 1],
      ],
    );
    expect(planTargetedRetry(chandelier)).toEqual({ fire: true, terms: ["chandelier"] });
    expect(planSubQueryGroups(chandelier, 3).groups[0]!.terms).toEqual(["chandelier"]);
  });

  test("zero groups when the coverage is complete", () => {
    const cov = report(["alpha", "beta"], ["alpha", "beta"], 10, [
      ["alpha", 3],
      ["beta", 3],
    ]);
    const plan = planSubQueryGroups(cov, 4);
    expect(plan.fire).toBe(false);
    expect(plan.groups).toEqual([]);
  });

  test("a maxGroups below one is clamped to the single merged group", () => {
    const plan = planSubQueryGroups(threeGaps, 0);
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]!.terms).toEqual(["mizar", "alcor", "zubrowka"]);
  });

  test("a non-finite coverage fails closed: no fire, no groups", () => {
    // A broken measurement (a non-finite number where the report contract
    // says a finite share or null) must not fire the gap signal. NaN
    // happened to miss the `<` gate on comparison semantics alone, while
    // -Infinity fired on it; the gate now refuses every non-finite report
    // explicitly, so failing closed is a stated rule, not an accident.
    const broken = { ...threeGaps, idfWeightedCoverage: Number.NaN };
    expect(planSubQueryGroups(broken, 4)).toEqual({ fire: false, groups: [] });
    const negative = { ...threeGaps, idfWeightedCoverage: Number.NEGATIVE_INFINITY };
    expect(planSubQueryGroups(negative, 4)).toEqual({ fire: false, groups: [] });
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
