/**
 * Match quality for a query the report cannot weigh, end to end.
 *
 * The coverage engine used to answer `totalIdf === 0 ? 1` - maximum
 * confidence for a query it had measured nothing about. Two inputs
 * produced it, and one of them was routine rather than exotic: the
 * significant-term splitter dropped tokens under three characters, and
 * `\p{L}` matches CJK, so every one- or two-character Chinese or Japanese
 * query - the common word length in those scripts - arrived at the report
 * with no terms and left it with a perfect score. Four thresholds read
 * that number, two of them with no result-count guard at all.
 *
 * This file drives the shipped indexer and search rather than the pure
 * engine, because the defect was only visible end to end: the pure report
 * looked correct in isolation, and it was the SPLITTER upstream that
 * emptied it.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { decideRecallInject } from "../../../src/core/brain/recall-inject.ts";
import { createTempVault, writeMd, makeConfig } from "../../helpers/search-fixtures.ts";

const { vault, dbPath, cleanup } = createTempVault("coverage-unmeasurable");
afterAll(cleanup);

const config = makeConfig({ vault, dbPath });

beforeAll(async () => {
  writeMd(vault, "ai.md", "# AI notes\n\nai systems and their evaluation.\n");
  writeMd(vault, "kensaku.md", "# 検索\n\n検索 は 全文 の 索引 を 使う。\n");
  writeMd(vault, "other.md", "# Other\n\nA note about gardening tools.\n");
  await indexVault(config);
});

describe("unmeasurable match quality", () => {
  test("a two-character query is weighed rather than dropped", async () => {
    // Before: `significantTerms("検索")` was empty, coverage came back 1,
    // and a query that matched a real note was indistinguishable from one
    // that matched nothing. Now the term is weighed, and because the note
    // does cover it the coverage is a real number at the top of the range.
    const outcome = await search(config, { query: "検索", limit: 5 });
    expect(outcome.results.length).toBeGreaterThan(0);
    expect(outcome.idfWeightedCoverage).not.toBeNull();
    expect(outcome.idfWeightedCoverage).toBe(1);
  });

  test("a two-character query that matches nothing scores zero, not one", async () => {
    // The reviewer's reproduction, inverted into an assertion: a CJK
    // query the corpus does not answer reported `results=0 coverage=1`.
    const outcome = await search(config, { query: "犬猫", limit: 5 });
    expect(outcome.results).toHaveLength(0);
    expect(outcome.idfWeightedCoverage).toBe(0);
  });

  test("a two-character latin query is weighed the same way", async () => {
    // Same rule, different script, and that is the point: nothing here
    // behaves differently because of which writing system the query used.
    const hit = await search(config, { query: "ai", limit: 5 });
    expect(hit.results.length).toBeGreaterThan(0);
    expect(hit.idfWeightedCoverage).toBe(1);
    const miss = await search(config, { query: "qz", limit: 5 });
    expect(miss.results).toHaveLength(0);
    expect(miss.idfWeightedCoverage).toBe(0);
  });

  test("a query with no word characters reports no measurement at all", async () => {
    // The residual unmeasurable case, and the one that stays unmeasurable
    // in every language: there is no term to weigh, so there is no share
    // to report. Null, not one, and not zero either - zero would be the
    // claim that the retrieval covered none of a query that asked nothing.
    const outcome = await search(config, { query: "???", limit: 5 });
    expect(outcome.idfWeightedCoverage).toBeNull();
  });

  test("the recall-inject floor abstains on an unmeasurable quality, by name", async () => {
    // Two consumers had no result-count guard and fired on quality 1.0 the
    // moment any candidate existed. The floor now has a state for "there
    // was no quality", and it abstains under its own reason rather than
    // borrowing `below_floor`, which would report a weak match.
    const decision = await decideRecallInject("???", async () => ({
      candidates: [
        {
          path: "Brain/x.md",
          title: "X",
          score: 0.99,
          searchType: "hybrid",
          startLine: 1,
          endLine: 2,
        },
      ],
      total: 1,
      idfWeightedCoverage: null,
    }));
    expect(decision.kind).toBe("abstain");
    if (decision.kind !== "abstain") return;
    expect(decision.reason).toBe("unmeasurable_quality");
    expect(decision.matchQuality).toBeNull();
    // The score was high, and it decided nothing - which is the whole
    // point of the floor reading quality instead.
    expect(decision.topScore).toBe(0.99);
  });
});
