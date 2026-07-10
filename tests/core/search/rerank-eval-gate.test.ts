import { test, expect, afterEach } from "bun:test";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { runRerankEvalGate } from "../../../src/core/search/rerank-eval-gate.ts";
import type { RecallBenchmarkDataset } from "../../../src/core/search/benchmark.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

async function indexed() {
  const v = createTempVault("rerank-gate");
  cleanups.push(v.cleanup);
  writeMd(v.vault, "ml.md", "# Machine learning\n\nGradient descent optimizes the loss surface.");
  writeMd(v.vault, "garden.md", "# Gardening\n\nTomatoes and compost in the spring season.");
  const cfg = makeConfig({ vault: v.vault, dbPath: v.dbPath });
  await indexVault(cfg, {});
  return cfg;
}

const dataset: RecallBenchmarkDataset = {
  queries: [{ id: "q1", query: "gradient descent", expected: ["ml.md"] }],
};

test("the eval gate runs both benchmarks and returns comparable metric families", async () => {
  const cfg = await indexed();
  const gate = await runRerankEvalGate(cfg, dataset, { kind: "local" });
  expect(typeof gate.improves).toBe("boolean");
  expect(["enable", "keep-disabled"]).toContain(gate.recommendation);
  expect(gate.baseline.hitAtK).toBeGreaterThanOrEqual(0);
  expect(gate.reranked.hitAtK).toBeGreaterThanOrEqual(0);
  expect(gate.deltas).toHaveProperty("mrr");
  expect(gate.deltas).toHaveProperty("hitAtK");
});

test("no lift (answer already top-ranked) recommends keep-disabled", async () => {
  const cfg = await indexed();
  const gate = await runRerankEvalGate(cfg, dataset, { kind: "local" });
  // The single expected doc is already the only strong match, so reranking
  // cannot lift ranking further: no improvement, no regression.
  expect(gate.deltas.hitAtK).toBe(0);
  expect(gate.improves).toBe(false);
  expect(gate.recommendation).toBe("keep-disabled");
});
