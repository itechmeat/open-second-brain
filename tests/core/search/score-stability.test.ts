/**
 * Score stability over the committed benchmark corpus
 * (a-label-is-not-a-boundary, U4).
 *
 * U4 moved four absolute thresholds off the result score and onto
 * IDF-weighted coverage, and wired the tier producer that `tierByDoc`
 * never had. Both claims include "no search score moves", and a claim of
 * byte-identity needs an instrument that can see a moved byte.
 * `recall-benchmark.test.ts` cannot: it pins hit@5 / MRR / containment
 * floors, and every score in the corpus could shift while all three stay
 * exactly where they are.
 *
 * So this pins the ordered `(path, score)` window itself. The corpus is
 * committed, the embedding provider is the deterministic local one, and
 * the ranker resolves its clock from the request, so the list is
 * reproducible run to run.
 *
 * The corpus stamps no `tier:` on any note, which is the condition under
 * which the tier producer must be inert: `supporting` is the identity
 * weight, so an untagged vault emits no tier map at all. A tier layer that
 * multiplied by one instead of being absent would move nothing here
 * either - `tier-producer.test.ts` is what separates those two.
 *
 * Re-pinning protocol, same as the benchmark gate's: a number that moves
 * is a finding first. Re-measure only after deciding the move is intended,
 * and say in the commit message which change moved it. Never re-pin to
 * make a red suite green.
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { parseRecallBenchmarkDataset } from "../../../src/core/search/benchmark.ts";
import { makeConfig } from "../../helpers/search-fixtures.ts";
import type { ResolvedSearchConfig } from "../../../src/core/search/types.ts";

const FIXTURE = join(import.meta.dir, "..", "..", "fixtures", "recall-benchmark");

/** The window each query is pinned over; the benchmark gate's own k. */
const WINDOW = 5;

/**
 * Decimals the comparison keeps.
 *
 * Four, not more, and the reason is a property of this corpus worth
 * stating: no note in it declares an `authored_at`, so the freshness
 * prior falls back to storage mtime - which is the instant the fixture
 * was copied into a temp vault. Two runs seconds apart therefore differ
 * in the sixth decimal on the rows freshness touches. Four decimals is
 * reproducible run to run (verified by measuring twice) and still an
 * order of magnitude finer than any ranking change this pin exists to
 * catch.
 */
const SCORE_PRECISION = 4;

/**
 * Measured 2026-08-16 on the committed fixture vault with the local
 * 256-dimension embedding provider. Keyed by the dataset's own query ids.
 *
 * The rows are NOT score-descending, and that is the shipped order, not a
 * transcription slip: MMR and the relevance rerank re-order a ranked
 * window by diversity, so position and score genuinely disagree. Pinning
 * the emitted order rather than a sorted copy is the point - a change that
 * reshuffled the window while preserving every score would otherwise pass.
 */
const PINNED: Readonly<Record<string, ReadonlyArray<readonly [string, number]>>> = Object.freeze({
  canary: [
    ["deploy-canary.md", 0.8716],
    ["link-source.md", 0.1343],
    ["deploy-bluegreen.md", 0.1353],
    ["style-guide.md", 0.1256],
    ["incident-2026-05.md", 0.0986],
  ],
  bluegreen: [
    ["deploy-bluegreen.md", 0.907],
    ["search-tuning.md", 0.1711],
    ["deploy-canary.md", 0.1487],
    ["incident-2026-05.md", 0.1471],
    ["db-backups.md", 0.1503],
  ],
  oauth: [
    ["auth-oauth.md", 0.9139],
    ["incident-2026-05.md", 0.1388],
    ["search-tuning.md", 0.1385],
    ["style-guide.md", 0.1154],
    ["deploy-canary.md", 0.1323],
  ],
  passwords: [
    ["auth-passwords.md", 0.9393],
    ["recipe-borscht.md", 0.1765],
    ["embeddings-pipeline.md", 0.1671],
    ["deploy-bluegreen.md", 0.1573],
    ["db-indexing.md", 0.1626],
  ],
  backups: [
    ["db-backups.md", 0.8881],
    ["style-guide.md", 0.1376],
    ["deploy-canary.md", 0.1543],
    ["notes-standup.md", 0.1294],
    ["project-alpha.md", 0.15],
  ],
  indexing: [
    ["db-indexing.md", 0.8823],
    ["project-alpha.md", 0.1683],
    ["db-backups.md", 0.1714],
    ["style-guide.md", 0.1434],
    ["embeddings-pipeline.md", 0.1423],
  ],
  incident: [
    ["incident-2026-05.md", 0.8523],
    ["deploy-bluegreen.md", 0.1556],
    ["style-guide.md", 0.1257],
    ["deploy-canary.md", 0.1433],
    ["link-source.md", 0.1096],
  ],
  "alias-hop": [
    ["link-source.md", 0.8768],
    ["project-alpha.md", 0.2478],
    ["auth-passwords.md", 0.166],
    ["notes-standup.md", 0.1761],
    ["project-alpha.md", 0.2065],
  ],
  embeddings: [
    ["embeddings-pipeline.md", 0.9405],
    ["style-guide.md", 0.1943],
    ["incident-2026-05.md", 0.1909],
    ["project-alpha.md", 0.1744],
    ["vacation-policy.md", 0.15],
  ],
  tuning: [
    ["search-tuning.md", 0.2675],
    ["project-alpha.md", 0.201],
    ["deploy-bluegreen.md", 0.1724],
    ["notes-standup.md", 0.1538],
    ["deploy-canary.md", 0.1565],
  ],
  standup: [
    ["notes-standup.md", 0.8499],
    ["db-indexing.md", 0.1761],
    ["incident-2026-05.md", 0.1626],
    ["project-alpha.md", 0.1705],
    ["style-guide.md", 0.136],
  ],
  style: [
    ["style-guide.md", 0.8835],
    ["incident-2026-05.md", 0.2101],
    ["auth-oauth.md", 0.1788],
    ["db-backups.md", 0.1871],
    ["vacation-policy.md", 0.1718],
  ],
});

let vault: string;
let config: ResolvedSearchConfig;

beforeAll(async () => {
  vault = mkdtempSync(join(tmpdir(), "o2b-score-pin-"));
  cpSync(join(FIXTURE, "vault"), vault, { recursive: true });
  config = makeConfig({
    vault,
    dbPath: join(vault, "index.sqlite"),
    semantic: { enabled: true, provider: "local", dimension: 256 },
  });
  await indexVault(config, { embeddings: true });
});

afterAll(() => {
  rmSync(vault, { recursive: true, force: true });
});

function loadDataset() {
  return parseRecallBenchmarkDataset(
    JSON.parse(readFileSync(join(FIXTURE, "dataset.json"), "utf8")),
  );
}

describe("the ranked window over the committed corpus", () => {
  test("every dataset query is pinned, so a new query cannot slip in unpinned", () => {
    const ids = loadDataset()
      .queries.map((q) => q.id)
      .toSorted();
    expect(ids).toEqual(Object.keys(PINNED).toSorted());
  });

  test("the ordered (path, score) window is unchanged", async () => {
    const dataset = loadDataset();
    const actual: Record<string, Array<readonly [string, number]>> = {};
    for (const query of dataset.queries) {
      // eslint-disable-next-line no-await-in-loop -- one indexed corpus, sequential by design
      const outcome = await search(config, { query: query.query, limit: WINDOW });
      actual[query.id] = outcome.results.map(
        (r) => [r.path, Number(r.score.toFixed(SCORE_PRECISION))] as const,
      );
    }
    // One comparison over the whole corpus: a per-query loop of assertions
    // stops at the first mismatch and hides how wide a ranking change was.
    expect(actual).toEqual(PINNED as unknown as typeof actual);
  });
});
