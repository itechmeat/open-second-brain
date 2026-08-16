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
  test("significantTerms keeps every word - no stopword list, no length rule", () => {
    // Language-agnostic: there is no stopword list and no longer a length
    // floor. "is" is kept for the same reason "the" always was - it is a
    // word the query asked with, and how much it is worth is the IDF
    // weighting's answer downstream, in any language.
    expect(significantTerms("what is the alpha zephyr")).toEqual([
      "what",
      "is",
      "the",
      "alpha",
      "zephyr",
    ]);
  });

  test("a query whose words are one or two characters is weighed, not dropped", () => {
    // The length floor was an English-shaped stopword rule wearing a
    // structural disguise: it removed every term of a CJK query, whose
    // common word length IS one or two characters, and the report then
    // had nothing to weigh. Nothing here is about CJK specifically - the
    // splitter never asks what script a token is in - it is about a
    // character count meaning different things in different ones.
    expect(significantTerms("検索")).toEqual(["検索"]);
    expect(significantTerms("ai")).toEqual(["ai"]);
    expect(significantTerms("x")).toEqual(["x"]);
  });

  test("a token of pure punctuation is not a word in any language", () => {
    // The splitter keeps `-` and `_` inside tokens so `well-known` and
    // `snake_case` survive whole, which lets a run of them survive the
    // split as well. With the length floor gone, this is what stops it
    // earning IDF mass.
    expect(significantTerms("?? -- ??")).toEqual([]);
    expect(significantTerms("well-known snake_case")).toEqual(["well-known", "snake_case"]);
  });

  test("an unweighable query reports no coverage, not perfect coverage", () => {
    // The defect: `totalIdf === 0 ? 1` scored a query nothing could be
    // measured about as a complete retrieval, at maximum confidence, for
    // every threshold reading it.
    const noTerms = buildCoverageReport({
      significantTerms: [],
      coveredTerms: new Set(),
      documentCount: 100,
      dfByTerm: new Map(),
    });
    expect(noTerms.idfWeightedCoverage).toBeNull();
    // An empty corpus is the other unweighable input: every IDF is
    // ln(1 + 0/(1+df)) = 0, so there is no mass to take a share of.
    const emptyCorpus = buildCoverageReport({
      significantTerms: ["alpha"],
      coveredTerms: new Set(),
      documentCount: 0,
      dfByTerm: new Map(),
    });
    expect(emptyCorpus.idfWeightedCoverage).toBeNull();
    // And a genuine zero is still a zero: measured, and distinguishable.
    const missed = buildCoverageReport({
      significantTerms: ["alpha"],
      coveredTerms: new Set(),
      documentCount: 100,
      dfByTerm: new Map([["alpha", 1]]),
    });
    expect(missed.idfWeightedCoverage).toBe(0);
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
  // Two-pass recall would now recover results for this AND dead end;
  // disable it - this test exercises the zero-result union machinery.
  const cfg = makeConfig({ vault, dbPath, twoPassEnabled: false });
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
