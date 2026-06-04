/**
 * Search-completeness guard (recall-trust-suite, Feature E).
 *
 * A deterministic completeness verdict over the returned results,
 * computed from the same coverage engine Feature C uses: `complete`
 * when the IDF-weighted coverage reaches 0.8, `partial` at 0.4, else
 * `sparse`. The false-absence guard lists every uncovered term the
 * corpus DOES contain, so a downstream summarizer cannot honestly claim
 * "the vault has nothing on X" while X sits in an unreturned page.
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";

import {
  buildCompletenessReport,
  buildCoverageReport,
  COMPLETENESS_COMPLETE_THRESHOLD,
  COMPLETENESS_PARTIAL_THRESHOLD,
} from "../../../src/core/search/coverage.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

describe("buildCompletenessReport (pure)", () => {
  const coverage = (covered: ReadonlyArray<string>, dfRare: number) =>
    buildCoverageReport({
      significantTerms: ["common", "rare"],
      coveredTerms: new Set(covered),
      documentCount: 100,
      dfByTerm: new Map([
        ["common", 90],
        ["rare", dfRare],
      ]),
    });

  test("all terms covered → complete", () => {
    const report = buildCompletenessReport(coverage(["common", "rare"], 1));
    expect(report.verdict).toBe("complete");
    expect(report.idfWeightedCoverage).toBe(1);
    expect(report.uncoveredTerms).toEqual([]);
  });

  test("only the rare term covered → still complete (IDF mass), only common → sparse", () => {
    expect(buildCompletenessReport(coverage(["rare"], 1)).verdict).toBe("complete");
    expect(buildCompletenessReport(coverage(["common"], 1)).verdict).toBe("sparse");
  });

  test("thresholds are the documented constants", () => {
    expect(COMPLETENESS_COMPLETE_THRESHOLD).toBe(0.8);
    expect(COMPLETENESS_PARTIAL_THRESHOLD).toBe(0.4);
  });

  test("false-absence guard lists uncovered terms present in the corpus, not df=0 terms", () => {
    const present = buildCompletenessReport(coverage(["common"], 5));
    expect(present.uncoveredButPresentInCorpus).toEqual(["rare"]);
    const absent = buildCompletenessReport(coverage(["common"], 0));
    expect(absent.uncoveredButPresentInCorpus).toEqual([]);
    expect(absent.uncoveredTerms).toEqual(["rare"]);
  });
});

// ── search integration ───────────────────────────────────────────────────────

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("completeness"));
});
afterEach(() => cleanup());

test("a fully covered query yields a complete verdict in the pack", async () => {
  writeMd(vault, "doc.md", "# Doc\n\nalpha subsystem export pipeline");
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg);

  const out = await search(cfg, { query: "alpha pipeline", limit: 5, evidencePack: true });
  expect(out.evidencePack?.completeness?.verdict).toBe("complete");
});

test("zero results over terms the corpus contains trips the false-absence guard", async () => {
  writeMd(vault, "alpha-note.md", "# Alpha\n\nthe alpha subsystem owns the export pipeline");
  writeMd(vault, "zephyr-note.md", "# Zephyr\n\nthe zephyr daemon owns the import pipeline");
  // Two-pass recall would now recover results for this AND dead end;
  // disable it - this test exercises the false-absence guard itself.
  const cfg = makeConfig({ vault, dbPath, twoPassEnabled: false });
  await indexVault(cfg);

  // AND semantics: no document holds both terms → zero results, but
  // BOTH terms exist in the corpus, so "nothing about alpha/zephyr"
  // would be a false-absence claim.
  const out = await search(cfg, { query: "alpha zephyr", limit: 5, evidencePack: true });
  expect(out.results).toHaveLength(0);
  const completeness = out.evidencePack?.completeness;
  expect(completeness?.verdict).toBe("sparse");
  expect(completeness?.uncoveredButPresentInCorpus?.toSorted()).toEqual(["alpha", "zephyr"]);
});
