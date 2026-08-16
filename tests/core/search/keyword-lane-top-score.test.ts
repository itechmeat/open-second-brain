/**
 * The keyword-lane top-score pin, measured rather than asserted.
 *
 * Five docblocks and a CHANGELOG entry state what the top row of a
 * keyword-only recall scores, and the whole threshold rework rests on it:
 * a floor a score could never fall below is why four constants stopped
 * being compared against a score at all. The branch that made that
 * argument stated the number as `0.6` and as an equality, and both were
 * wrong - the shipped pipeline returns `0.6499997...`, because the
 * freshness prior is added after the lane is normalised, and a row that
 * also draws a link or entity boost goes higher still.
 *
 * Nothing tied the stated number to the shipped one, which is how a claim
 * about a measurement drifted from the measurement. This file is that
 * tie: it drives the real indexer and the real search over a vault with
 * no embeddings, and compares what comes back against the exported
 * bindings the prose cites - never against a literal. A digit typed into
 * a docblock cannot be checked; a symbol can.
 */

import { test, expect, describe, afterAll } from "bun:test";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import {
  DEFAULT_KEYWORD_WEIGHT,
  FRESH_KEYWORD_ONLY_TOP_SCORE,
  resolveSearchConfig,
} from "../../../src/core/search/index.ts";
import { DEFAULT_RECENCY } from "../../../src/core/search/recency.ts";
import { createTempVault, writeMd, makeConfig } from "../../helpers/search-fixtures.ts";

/**
 * The queries driven through the pipeline. Four rather than one, and each
 * matching a different note, because the claim is about EVERY non-empty
 * keyword recall and a single query could be a coincidence.
 */
const QUERIES: ReadonlyArray<string> = Object.freeze([
  "fox",
  "postgres",
  "forest",
  "aviary griffin",
]);

/**
 * Slack allowed between the measured top score and
 * {@link FRESH_KEYWORD_ONLY_TOP_SCORE}.
 *
 * The freshness prior decays continuously from the file's mtime, so a
 * vault written milliseconds ago sits a hair under the full amplitude -
 * measured at 2.5e-7 over a run. A tolerance three orders of magnitude
 * looser than that is still four orders tighter than the 0.05 the prior
 * itself is worth, so a prior that stopped firing could not hide inside
 * it.
 */
const FRESHNESS_SLACK = 1e-4;

const { vault, dbPath, cleanup } = createTempVault("keyword-top-score");
afterAll(cleanup);

writeMd(vault, "alpha.md", "# Alpha\n\nThe quick brown fox jumps over the lazy dog.\n");
writeMd(vault, "beta.md", "# Beta\n\nDatabase migration notes about postgres and indexes.\n");
writeMd(vault, "gamma.md", "# Gamma\n\nA note about the fox and the hound in the forest.\n");
writeMd(vault, "delta.md", "# Delta\n\nThe griffin aviary keeps its own weather.\n");

/** No embeddings configured: the semantic lane cannot contribute. */
const config = makeConfig({ vault, dbPath });

describe("keyword-lane top score", () => {
  test("the shipped default is the weight the pin is stated in", () => {
    // The RESOLVER, not the fixture: the claim is about what a default
    // install ships, and a fixture asserting against itself would prove
    // nothing. The fixture is then held to the same values, so a drifted
    // fixture cannot make the measurement below describe another vault.
    const resolved = resolveSearchConfig({ vault });
    expect(resolved.keywordWeight).toBe(DEFAULT_KEYWORD_WEIGHT);
    expect(resolved.recall.recencyAmplitude).toBe(DEFAULT_RECENCY.amplitude);
    expect(config.keywordWeight).toBe(resolved.keywordWeight);
    expect(config.recall.recencyAmplitude).toBe(resolved.recall.recencyAmplitude);
  });

  test("every non-empty keyword recall clears the weight, and only just", async () => {
    await indexVault(config);
    const measured: string[] = [];
    for (const query of QUERIES) {
      // eslint-disable-next-line no-await-in-loop -- one measurement per query, sequential by design
      const outcome = await search(config, { query, limit: 5 });
      const top = outcome.results[0];
      expect(top).toBeDefined();
      if (top === undefined) continue;
      measured.push(`${query}=${top.score.toFixed(6)}`);
      // The floor: min-max normalisation pins the best keyword lane value
      // at 1, so the relevance term alone is the configured weight, and
      // every layer above it is non-negative.
      expect(top.keywordScore).toBe(1);
      expect(top.semanticScore).toBe(0);
      expect(top.score).toBeGreaterThanOrEqual(DEFAULT_KEYWORD_WEIGHT);
      // …and NOT equal to it, which is the sentence this file exists to
      // correct. The excess is the freshness prior and nothing else on a
      // vault with no links, tags, entities or activation history.
      expect(top.score).toBeGreaterThan(DEFAULT_KEYWORD_WEIGHT);
      expect(top.score - top.recencyBoost).toBeCloseTo(DEFAULT_KEYWORD_WEIGHT, 10);
      expect(top.score).toBeGreaterThan(FRESH_KEYWORD_ONLY_TOP_SCORE - FRESHNESS_SLACK);
      expect(top.score).toBeLessThanOrEqual(FRESH_KEYWORD_ONLY_TOP_SCORE);
    }
    // Printed so a re-measurement never has to reconstruct the harness.
    expect(measured.length).toBe(QUERIES.length);
  });

  test("the two unreachability facts the threshold rework rests on", () => {
    // Every floor a score used to be compared against is below the top
    // row's floor, so none of them could ever refuse anything…
    for (const floor of [0.35, 0.5, DEFAULT_KEYWORD_WEIGHT]) {
      expect(FRESH_KEYWORD_ONLY_TOP_SCORE).toBeGreaterThanOrEqual(floor);
    }
    // …and the chain stop sits above it, so it could never fire.
    expect(FRESH_KEYWORD_ONLY_TOP_SCORE).toBeLessThan(0.8);
  });
});
