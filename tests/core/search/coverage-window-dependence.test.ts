/**
 * What `SearchOutcome.idfWeightedCoverage` depends on, measured.
 *
 * Its docblock claimed the number was "pool-independent by construction:
 * removing, fading or re-weighting a candidate cannot move it". That was
 * false, and provably so from one line of the producer: the coverage is
 * computed over `finalResults`, the limit-sliced window the caller
 * receives. Narrow the window and the terms only the dropped rows carried
 * leave the numerator with them.
 *
 * The claim is now narrowed to what the code does, and the reason for the
 * narrower wording lives here rather than only in prose: this file pins
 * the dependence itself, so a later reader who re-derives the stronger
 * claim fails a test instead of shipping a docblock.
 *
 * Getting a PARTIAL coverage at all takes a fixture worth naming, and the
 * reason is a finding in its own right. The keyword lane matches with an
 * implicit AND, so every row it returns contains every query term, and
 * coverage over a keyword-only window is 1 whenever anything came back
 * and 0 when nothing did. A window whose rows differ in what they cover
 * needs a lane that admits rows matching only part of the query: the
 * broadened OR retry of the second pass is the one that needs no
 * embedding provider, so that is what this fixture drives.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { createTempVault, writeMd, makeConfig } from "../../helpers/search-fixtures.ts";

const { vault, dbPath, cleanup } = createTempVault("coverage-window");
afterAll(cleanup);

const config = makeConfig({ vault, dbPath });

/**
 * Two rare terms living in two different notes. No chunk contains both,
 * so the implicit-AND first pass finds nothing and the broadened OR retry
 * returns one row per term - a window whose rows genuinely differ in
 * which part of the query they cover.
 */
const QUERY = "basilisk quinine";

beforeAll(async () => {
  writeMd(vault, "two.md", "# Two\n\nthe basilisk in the cellar with many other words here.\n");
  writeMd(vault, "three.md", "# Three\n\nquinine and other bitter compounds in the pantry.\n");
  writeMd(vault, "four.md", "# Four\n\nzephyr winds again and again over the plateau.\n");
  await indexVault(config);
});

describe("idf-weighted coverage and the delivered window", () => {
  test("a narrower limit reports lower coverage for the same query", async () => {
    const wide = await search(config, { query: QUERY, limit: 20, evidencePack: true });
    const narrow = await search(config, { query: QUERY, limit: 1, evidencePack: true });
    // The ranked pool is identical; only the delivered window differs.
    expect(narrow.total).toBe(wide.total);
    expect(wide.results).toHaveLength(2);
    expect(narrow.results).toHaveLength(1);
    expect(wide.idfWeightedCoverage).toBe(1);
    // Half the query's IDF mass, because half the rows were sliced off.
    expect(narrow.idfWeightedCoverage).toBeCloseTo(0.5, 6);
  });

  test("the completeness verdict moves with the window too", async () => {
    // Same query, same corpus, same ranking - two different published
    // verdicts. This is the honest reading of the field: it grades the
    // ANSWER, not the vault.
    const wide = await search(config, { query: QUERY, limit: 20, evidencePack: true });
    const narrow = await search(config, { query: QUERY, limit: 1, evidencePack: true });
    expect(wide.evidencePack?.completeness?.verdict).toBe("complete");
    expect(narrow.evidencePack?.completeness?.verdict).toBe("partial");
  });

  test("but it does not move with rank position", async () => {
    // The property that separates it from a score, and the entire reason
    // four thresholds moved onto it: the top row's score is pinned by
    // min-max normalisation whatever it matched, while coverage over the
    // same window is the same number however the rows are ordered inside
    // it. Naming the terms in the other order delivers the same rows and
    // the same coverage.
    const forward = await search(config, { query: QUERY, limit: 20, evidencePack: true });
    const reversed = await search(config, {
      query: "quinine basilisk",
      limit: 20,
      evidencePack: true,
    });
    expect(new Set(reversed.results.map((r) => r.path))).toEqual(
      new Set(forward.results.map((r) => r.path)),
    );
    expect(reversed.idfWeightedCoverage).toBe(forward.idfWeightedCoverage);
  });

  test("the keyword lane alone cannot produce a partial coverage", async () => {
    // Stated as an assertion because it bounds what the four thresholds
    // can currently see on a default install: with no embedding provider
    // and no second pass, every returned row contains every query term,
    // so the number is 1 or it is 0.
    const hit = await search(config, { query: "basilisk cellar", limit: 20 });
    expect(hit.results.length).toBeGreaterThan(0);
    expect(hit.idfWeightedCoverage).toBe(1);
    const miss = await search(config, { query: QUERY, limit: 20 });
    expect(miss.results).toHaveLength(0);
    expect(miss.idfWeightedCoverage).toBe(0);
  });
});
