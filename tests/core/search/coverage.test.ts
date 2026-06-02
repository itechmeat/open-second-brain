/**
 * Verified multi-record recall (recall-trust-suite, Feature C).
 *
 * The coverage engine (`coverage.ts`) is the single source of truth for
 * significant terms, per-term postings, corpus document frequency (IDF),
 * and the rare-term classification. On top of it the evidence pack
 * gains: per-token recall union (bounded extra records for uncovered
 * terms), IDF-weighted support coverage, and a rare-term gate that
 * populates the existing abstention field.
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";

import {
  buildCoverageReport,
  idfForTerm,
  isRareTerm,
  significantTerms,
  termIncludedIn,
} from "../../../src/core/search/coverage.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

describe("coverage engine (pure)", () => {
  test("significantTerms drops stopwords and short tokens", () => {
    expect(significantTerms("what is the alpha zephyr")).toEqual(["alpha", "zephyr"]);
  });

  test("idf is monotonically decreasing in document frequency", () => {
    const n = 100;
    expect(idfForTerm(0, n)).toBeGreaterThan(idfForTerm(5, n));
    expect(idfForTerm(5, n)).toBeGreaterThan(idfForTerm(100, n));
    expect(idfForTerm(100, n)).toBeGreaterThan(0);
  });

  test("rare-term boundary: df within 2% of the corpus (min 1)", () => {
    expect(isRareTerm(1, 100)).toBe(true);
    expect(isRareTerm(2, 100)).toBe(true);
    expect(isRareTerm(3, 100)).toBe(false);
    // Tiny corpus: the floor keeps df=1 rare.
    expect(isRareTerm(1, 10)).toBe(true);
    expect(isRareTerm(2, 10)).toBe(false);
  });

  test("buildCoverageReport weights matched terms by IDF", () => {
    const report = buildCoverageReport({
      significantTerms: ["common", "rare"],
      coveredTerms: new Set(["rare"]),
      documentCount: 100,
      dfByTerm: new Map([
        ["common", 90],
        ["rare", 1],
      ]),
    });
    // Matching only the rare term yields coverage far above 0.5: the
    // rare term carries far more IDF mass than the common one.
    expect(report.idfWeightedCoverage).toBeGreaterThan(0.8);
    expect(report.rareTerms).toEqual(["rare"]);
    expect(report.uncoveredRareTerms).toEqual([]);
    const common = report.terms.find((t) => t.term === "common")!;
    expect(common.rare).toBe(false);
    expect(common.covered).toBe(false);
  });

  test("an uncovered rare term is reported", () => {
    const report = buildCoverageReport({
      significantTerms: ["common", "rare"],
      coveredTerms: new Set(["common"]),
      documentCount: 100,
      dfByTerm: new Map([
        ["common", 90],
        ["rare", 1],
      ]),
    });
    expect(report.uncoveredRareTerms).toEqual(["rare"]);
    expect(report.idfWeightedCoverage).toBeLessThan(0.2);
  });

  test("termIncludedIn folds case", () => {
    expect(termIncludedIn("Alpha Beta", "alpha")).toBe(true);
    expect(termIncludedIn("gamma", "alpha")).toBe(false);
  });
});

// ── search integration ───────────────────────────────────────────────────────

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("coverage"));
});
afterEach(() => cleanup());

test("per-token union gathers records for terms the ranked set left uncovered", async () => {
  writeMd(vault, "alpha-note.md", "# Alpha\n\nthe alpha subsystem owns the export pipeline");
  writeMd(vault, "zephyr-note.md", "# Zephyr\n\nthe zephyr daemon owns the import pipeline");
  writeMd(vault, "filler.md", "# Filler\n\nunrelated prose about gardening");
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg);

  // FTS joins tokens with implicit AND: no document contains both terms,
  // so the primary result set is empty — exactly the evidence-spanning
  // case the union exists for.
  const out = await search(cfg, { query: "alpha zephyr", limit: 5, evidencePack: true });
  expect(out.results).toHaveLength(0);
  const pack = out.evidencePack!;
  const unionTerms = (pack.unionRecords ?? []).map((r) => r.term).toSorted();
  expect(unionTerms).toContain("alpha");
  expect(unionTerms).toContain("zephyr");
  const unionPaths = (pack.unionRecords ?? []).map((r) => r.path);
  expect(unionPaths).toContain("alpha-note.md");
  expect(unionPaths).toContain("zephyr-note.md");
});

test("the pack carries IDF-weighted coverage and the rare-term gate fills abstention", async () => {
  writeMd(vault, "doc.md", "# Doc\n\nthe alpha subsystem export pipeline");
  for (let i = 0; i < 5; i++) {
    writeMd(vault, `common-${i}.md`, `# C${i}\n\nthe alpha subsystem note ${i}`);
  }
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg);

  const out = await search(cfg, { query: "alpha xylograph", limit: 5, evidencePack: true });
  const pack = out.evidencePack!;
  expect(typeof pack.idfWeightedCoverage).toBe("number");
  expect(pack.idfWeightedCoverage!).toBeGreaterThanOrEqual(0);
  expect(pack.idfWeightedCoverage!).toBeLessThanOrEqual(1);
  // "xylograph" appears nowhere: rare (df=0) and uncovered → the gate
  // abstains explicitly.
  expect(pack.uncoveredRareTerms).toContain("xylograph");
  expect(pack.abstention).toContain("xylograph");
});

test("legacy evidence-pack fields stay byte-identical for callers that ignore the new ones", async () => {
  writeMd(vault, "doc.md", "# Doc\n\nalpha beta gamma");
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg);

  const out = await search(cfg, { query: "alpha gamma", limit: 5, evidencePack: true });
  const pack = out.evidencePack!;
  expect(pack.significantTerms).toEqual(["alpha", "gamma"]);
  expect(pack.matchedTerms).toEqual(["alpha", "gamma"]);
  expect(pack.missingTerms).toEqual([]);
  expect(pack.supportCoverage).toBe(1);
});
