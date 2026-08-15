/**
 * The recall benchmark's fan-out is bounded (nothing-runs-unwatched, U4).
 *
 * `runRecallBenchmark` issued one concurrent `search()` per dataset query
 * with no cap - and `tuneRecall` amplifies that 24x through its parameter
 * grid, so an operator-supplied dataset of a few hundred queries opened a
 * few thousand concurrent SQLite reads. The queries being read-only makes
 * the concurrency CORRECT; it never made it bounded.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BENCHMARK_QUERY_CONCURRENCY,
  _benchmarkQueryPeakForTests,
  parseRecallBenchmarkDataset,
  runRecallBenchmark,
} from "../../../src/core/search/benchmark.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { makeConfig } from "../../helpers/search-fixtures.ts";
import type { ResolvedSearchConfig } from "../../../src/core/search/types.ts";

/** Comfortably more queries than the ceiling, so the ceiling binds. */
const QUERY_COUNT = BENCHMARK_QUERY_CONCURRENCY * 2;

let vault: string;
let config: ResolvedSearchConfig;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-benchmark-ceiling-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
  writeFileSync(
    join(vault, "canary.md"),
    "# Canary rollout\n\nShip one instance, observe it, then widen the rollout.\n",
  );
  config = makeConfig({ vault, dbPath: join(vault, "index.sqlite") });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

test("the fan-out never exceeds its named ceiling on a larger dataset", async () => {
  await indexVault(config);
  const dataset = parseRecallBenchmarkDataset({
    queries: Array.from({ length: QUERY_COUNT }, (_, i) => ({
      id: `q${i}`,
      query: "canary rollout",
      expected: ["canary.md"],
    })),
  });

  const report = await runRecallBenchmark(config, dataset);

  expect(report.perQuery.length).toBe(QUERY_COUNT);
  // Exactly the ceiling: every task takes its permit before any search
  // can release one, so the high-water mark saturates.
  expect(_benchmarkQueryPeakForTests()).toBe(BENCHMARK_QUERY_CONCURRENCY);
});
