/**
 * Recall benchmark CI gate (link-recall-intelligence, t_e2215d49):
 * the committed fixture vault + dataset score against the live hybrid
 * pipeline with the deterministic local embedding provider; pinned
 * thresholds fail the suite on a ranking regression. Re-measured on
 * 2026-08-15 after D1 moved the freshness prior onto the authoring
 * instant: hit@5 = 1.000, MRR = 0.958, answer-containment@5 = 1.000,
 * unchanged from the 2026-06-05 measurement, and identical in expand
 * mode. Thresholds sit one failing-direction margin below so legitimate
 * ranking improvements do not flap the gate.
 *
 * What that unchanged number does and does not prove. No note in the
 * fixture vault declares an `authored_at`, so every candidate here falls
 * back to storage mtime and D1 is inert over this corpus - which is the
 * byte-identity half of its claim, and the whole of what this gate
 * witnessed. It is NOT evidence that ranking on the authoring instant
 * works; that lives in `recency-authored-at.test.ts`, and a regression
 * in it would leave these numbers exactly where they are.
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { indexVault } from "../../../src/core/search/indexer.ts";
import {
  parseRecallBenchmarkDataset,
  runRecallBenchmark,
} from "../../../src/core/search/benchmark.ts";
import { SearchError } from "../../../src/core/search/types.ts";
import { makeConfig, writeMd } from "../../helpers/search-fixtures.ts";
import { TRANSPORT_REACH } from "../../../src/core/graph/transport-reach.ts";
import type { ResolvedSearchConfig } from "../../../src/core/search/types.ts";

const FIXTURE = join(import.meta.dir, "..", "..", "fixtures", "recall-benchmark");

/**
 * CI thresholds - margin below the measured values above. Re-measure
 * (run the suite and read the report) whenever the fixture vault,
 * dataset, or ranking pipeline changes, and update both the pins and
 * the header comment. A pin is never loosened to admit a measurement
 * that fell: a fallen number is the finding.
 */
const MIN_HIT_AT_5 = 0.9;
const MIN_MRR = 0.85;
// Answer-containment floor over the answer-bearing fixture queries. The
// three answers are verbatim substrings of their source notes, so a
// correct retrieval contains them; the pin sits one failing-direction
// margin below the measured 1.0.
const MIN_ANSWER_CONTAINMENT_AT_5 = 0.99;

let vault: string;
let config: ResolvedSearchConfig;

beforeAll(async () => {
  vault = mkdtempSync(join(tmpdir(), "o2b-bench-"));
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

describe("parseRecallBenchmarkDataset", () => {
  test("accepts the committed dataset", () => {
    const dataset = loadDataset();
    expect(dataset.queries.length).toBeGreaterThanOrEqual(10);
  });

  test("rejects malformed datasets naming the offender", () => {
    expect(() => parseRecallBenchmarkDataset([])).toThrow(SearchError);
    expect(() => parseRecallBenchmarkDataset({ queries: [] })).toThrow(/non-empty/);
    expect(() =>
      parseRecallBenchmarkDataset({ queries: [{ id: "x", query: "q", expected: [] }] }),
    ).toThrow(/expected path/);
    expect(() =>
      parseRecallBenchmarkDataset({
        queries: [
          { id: "x", query: "q", expected: ["a.md"] },
          { id: "x", query: "q2", expected: ["b.md"] },
        ],
      }),
    ).toThrow(/duplicated/);
    expect(() =>
      parseRecallBenchmarkDataset({ queries: [{ id: "x", query: "q", expected: ["a.md"], k: 0 }] }),
    ).toThrow(/k must be/);
    expect(() =>
      parseRecallBenchmarkDataset({
        queries: [{ id: "x", query: "q", expected: ["a.md"], answer: "  " }],
      }),
    ).toThrow(/answer must be/);
  });
});

describe("runRecallBenchmark", () => {
  test("the fixture vault holds the pinned recall thresholds", async () => {
    const report = await runRecallBenchmark(config, loadDataset(), { k: 5 });
    expect(report.total).toBe(12);
    expect(report.hitAtK).toBeGreaterThanOrEqual(MIN_HIT_AT_5);
    expect(report.mrr).toBeGreaterThanOrEqual(MIN_MRR);
  });

  test("answer-containment@k scores the answer-bearing queries and holds the pinned floor", async () => {
    const report = await runRecallBenchmark(config, loadDataset(), { k: 5 });
    expect(report.answerQueries).toBe(3);
    expect(report.answerContainmentAtK).toBeGreaterThanOrEqual(MIN_ANSWER_CONTAINMENT_AT_5);
    // Queries without an answer report null containment, not a false miss.
    const noAnswer = report.perQuery.find((q) => q.id === "style")!;
    expect(noAnswer.answerContained).toBeNull();
  });

  test("an answer absent from the retrieved content scores a containment miss", async () => {
    const report = await runRecallBenchmark(
      config,
      parseRecallBenchmarkDataset({
        queries: [
          {
            id: "miss",
            query: "canary rollout",
            expected: ["deploy-canary.md"],
            answer: "this phrase appears in no note",
          },
        ],
      }),
      { k: 5 },
    );
    expect(report.answerQueries).toBe(1);
    expect(report.answerContainmentAtK).toBe(0);
    expect(report.perQuery[0]!.answerContained).toBe(false);
  });

  test("answer-containment is vacuously 1 for a dataset with no answers", async () => {
    const report = await runRecallBenchmark(
      config,
      parseRecallBenchmarkDataset({
        queries: [{ id: "plain", query: "canary rollout", expected: ["deploy-canary.md"] }],
      }),
      { k: 5 },
    );
    expect(report.answerQueries).toBe(0);
    expect(report.answerContainmentAtK).toBe(1);
  });

  test("the benchmark is deterministic across runs", async () => {
    const first = await runRecallBenchmark(config, loadDataset(), { k: 5 });
    const second = await runRecallBenchmark(config, loadDataset(), { k: 5 });
    expect(second).toEqual(first);
  });

  test("the alias-hop query reaches the alias owner through traversal", async () => {
    const report = await runRecallBenchmark(config, loadDataset(), { k: 5 });
    const aliasHop = report.perQuery.find((q) => q.id === "alias-hop")!;
    expect(aliasHop.hit).toBe(true);
  });

  test("wrong expectations score as misses - the metric points the right way", async () => {
    const report = await runRecallBenchmark(
      config,
      parseRecallBenchmarkDataset({
        queries: [{ id: "wrong", query: "canary rollout", expected: ["recipe-borscht.md"] }],
      }),
      { k: 5 },
    );
    expect(report.hitAtK).toBe(0);
    expect(report.mrr).toBe(0);
    expect(report.perQuery[0]!.rank).toBeNull();
  });

  test("expand mode reports itself and keeps the gate", async () => {
    const report = await runRecallBenchmark(config, loadDataset(), { k: 5, expand: true });
    expect(report.expand).toBe(true);
    expect(report.hitAtK).toBeGreaterThanOrEqual(MIN_HIT_AT_5);
  });
});

// --- The dataset is the caller's, and so is its reach ------------------------
//
// `brain_benchmark` and `brain_tune` take the dataset as a required tool
// argument over any transport, and the report answers per query with
// `hit`, `rank`, `expectedFound` for caller-named paths and
// `answerContained` for a caller-supplied string. The lane used to pin
// `local` regardless.
//
// REFUTED, and recorded rather than dropped: that pin was NOT an oracle
// over `visibility:`-tagged pages. `search()` also applies the caller's
// visibility SCOPE, and the benchmark passes none, so a tagged page was
// already outside every benchmark run at every reach - reverting the fix
// leaves a tagged-page probe scoring absent either way.
//
// What the pin DID reach is the unmeasurable page: a document still in
// the index whose file cannot be read. The reach rule substitutes the
// reserved token for it and denies at `remote`; the caller-scope rule
// reads its empty frontmatter as untagged and keeps it. That is the
// difference below, and it is the whole observable difference.

describe("runRecallBenchmark at the caller's reach", () => {
  const reachVault = mkdtempSync(join(tmpdir(), "o2b-bench-reach-"));
  const dbPath = join(reachVault, "index.sqlite");
  let cfg: ResolvedSearchConfig;

  beforeAll(async () => {
    writeMd(reachVault, "open.md", "# Open\n\nthe payments tier rollout is staged");
    writeMd(
      reachVault,
      "vanished.md",
      "# Vanished\n\nthe payments tier rollout is staged, revised",
    );
    cfg = makeConfig({ vault: reachVault, dbPath });
    await indexVault(cfg);
    // Indexed, then gone: the routine trigger is a page deleted or
    // renamed between runs. The document row survives, so it can still
    // rank; only its frontmatter has become unmeasurable.
    rmSync(join(reachVault, "vanished.md"), { force: true });
  });

  afterAll(() => rmSync(reachVault, { recursive: true, force: true }));

  const probe = (expected: string) =>
    parseRecallBenchmarkDataset({
      queries: [{ id: "probe", query: "payments tier rollout staged", expected: [expected] }],
    });

  test("an unmeasurable page scores as absent for a caller that established nothing", async () => {
    const report = await runRecallBenchmark(cfg, probe("vanished.md"), { k: 5 });
    const q = report.perQuery[0]!;
    expect(q.hit).toBe(false);
    expect(q.rank).toBeNull();
    expect(q.expectedFound).toBe(0);
  });

  test("a lane that established local reach still scores the whole corpus", async () => {
    const report = await runRecallBenchmark(cfg, probe("vanished.md"), {
      k: 5,
      transportReach: TRANSPORT_REACH.local,
    });
    expect(report.perQuery[0]!.hit).toBe(true);
  });

  test("an ordinary page scores at both reaches, so the gate is not blanket-denying", async () => {
    const reports = await Promise.all(
      [TRANSPORT_REACH.local, TRANSPORT_REACH.remote].map((transportReach) =>
        runRecallBenchmark(cfg, probe("open.md"), { k: 5, transportReach }),
      ),
    );
    for (const report of reports) expect(report.perQuery[0]!.hit).toBe(true);
  });
});
