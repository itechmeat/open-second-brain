/**
 * The gap-promote hook's retriever carries the search trail's codes
 * (honest-query-embed-and-safe-upgrades, task 7).
 *
 * `gapScopedRecallRetriever` resolves to remote reach like every hook,
 * so under a positive cost gate with an unpriced model its semantic lane
 * is refused. The refusal is now named on its result instead of dropped,
 * and `autoCloseRecalledGaps` gathers the codes of every recall it ran so
 * the hook can put them on its audit line.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  autoCloseRecalledGaps,
  GAP_SOURCE_TELEMETRY,
  GAP_TASK_KIND,
  GAP_TASK_STATUS_OPEN,
  type GapRecallRetriever,
} from "../../../../src/core/brain/gaps/gap-loop.ts";
import { gapScopedRecallRetriever } from "../../../../src/core/brain/gaps/gap-recall.ts";
import { brainGapTasksDir } from "../../../../src/core/brain/paths.ts";
import type { RecallResultSet } from "../../../../src/core/brain/recall-inject.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { indexVault, resolveSearchConfig } from "../../../../src/core/search/index.ts";
import {
  RETRIEVAL_DEGRADATION,
  type RetrievalDegradationCode,
} from "../../../../src/core/search/retrieval-trail.ts";
import { writeFrontmatterAtomic } from "../../../../src/core/vault.ts";
import { FAKE_PROVIDER_KEY } from "../../../helpers/fake-credentials.ts";
import { startFakeHttp, type FakeHttp } from "../../../helpers/fake-http.ts";
import { sqliteVecLoadable } from "../../../helpers/sqlite-vec.ts";

let tmp: string;
let vault: string;
let configPath: string;
let server: FakeHttp;

beforeEach(async () => {
  server = await startFakeHttp();
  tmp = mkdtempSync(join(tmpdir(), "o2b-gap-gate-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Notes"), { recursive: true });
  writeFileSync(
    join(vault, "Notes", "ledger.md"),
    "# Ledger\n\nthe quarterly ledger reconciliation runbook\n",
  );
  configPath = join(tmp, "config.yaml");
  const lines = (gate: number) =>
    [
      `vault: ${vault}`,
      "search_semantic_enabled: true",
      "embedding_provider: openai-compat",
      `embedding_base_url: ${server.url}`,
      "embedding_model: fake-model",
      `embedding_api_key: ${FAKE_PROVIDER_KEY}`,
      "embedding_dimension: 4",
      `embedding_cost_gate_usd: ${gate}`,
      "",
    ].join("\n");
  atomicWriteFileSync(configPath, lines(0));
  if (sqliteVecLoadable()) {
    await indexVault(resolveSearchConfig({ vault, configPath }), { embeddings: true });
  }
  atomicWriteFileSync(configPath, lines(1));
});

afterEach(async () => {
  await server.close();
  rmSync(tmp, { recursive: true, force: true });
});

test.skipIf(!sqliteVecLoadable())(
  "a gated gap recall sends no embed and names the refusal on its result",
  async () => {
    const before = server.callCount();
    const set = await gapScopedRecallRetriever(configPath, vault)("quarterly ledger", () => true);
    expect(server.callCount()).toBe(before);
    expect(set.candidates.map((c) => c.path.replaceAll("\\", "/"))).toContain("Notes/ledger.md");
    expect(set.degraded).toContain(RETRIEVAL_DEGRADATION.semanticCostUnpriced);
    expect(set.degraded).toContain(RETRIEVAL_DEGRADATION.hybridDegraded);
  },
);

// ----- the codes reach the auto-close result, and from there the audit line --

const NOW = new Date("2026-10-06T12:00:00.000Z");

/** Write one open gap-task note directly, the way a minted one reads. */
function writeOpenTask(key: string, topic: string): void {
  writeFrontmatterAtomic(
    join(brainGapTasksDir(vault), `${key}.md`),
    {
      kind: GAP_TASK_KIND,
      gap_key: key,
      gap_topic: topic,
      gap_source: GAP_SOURCE_TELEMETRY,
      status: GAP_TASK_STATUS_OPEN,
      occurrences: "3",
      created_at: "2026-01-01T00:00:00.000Z",
    },
    `Recurring recall gap for ${topic}.`,
    { vaultForRelativePath: vault, overwrite: true },
  );
}

/** A retriever that admits nothing and reports `codes` as its narrowing. */
function degradedRetriever(codes: ReadonlyArray<RetrievalDegradationCode>): GapRecallRetriever {
  return async () =>
    ({
      candidates: [],
      total: 0,
      idfWeightedCoverage: null,
      ...(codes.length > 0 ? { degraded: codes } : {}),
    }) satisfies RecallResultSet;
}

test.skipIf(!sqliteVecLoadable())(
  "a gated gap recall carries its refusal onto the auto-close result",
  async () => {
    writeOpenTask("gap-ledger", "quarterly ledger");
    const before = server.callCount();
    const result = await autoCloseRecalledGaps(vault, gapScopedRecallRetriever(configPath, vault), {
      now: NOW,
    });
    expect(server.callCount()).toBe(before);
    expect(result.retrievalDegraded).toContain(RETRIEVAL_DEGRADATION.semanticCostUnpriced);
    expect(result.closed.length + result.kept.length).toBe(1);
  },
);

test("the auto-close result names each code once, in first-seen order", async () => {
  writeOpenTask("gap-one", "first topic");
  const result = await autoCloseRecalledGaps(
    vault,
    degradedRetriever([
      RETRIEVAL_DEGRADATION.hybridDegraded,
      RETRIEVAL_DEGRADATION.semanticCostUnpriced,
      RETRIEVAL_DEGRADATION.hybridDegraded,
    ]),
    { now: NOW },
  );
  expect(result.retrievalDegraded).toEqual([
    RETRIEVAL_DEGRADATION.hybridDegraded,
    RETRIEVAL_DEGRADATION.semanticCostUnpriced,
  ]);
});

test("a code every task's recall reports is named once for the run", async () => {
  writeOpenTask("gap-one", "first topic");
  writeOpenTask("gap-two", "second topic");
  const result = await autoCloseRecalledGaps(
    vault,
    degradedRetriever([RETRIEVAL_DEGRADATION.semanticCostUnpriced]),
    { now: NOW },
  );
  expect(result.kept).toHaveLength(2);
  expect(result.retrievalDegraded).toEqual([RETRIEVAL_DEGRADATION.semanticCostUnpriced]);
});

test("a recall that narrowed nothing leaves the codes off the result", async () => {
  writeOpenTask("gap-one", "first topic");
  const result = await autoCloseRecalledGaps(vault, degradedRetriever([]), { now: NOW });
  expect(result.kept).toHaveLength(1);
  expect("retrievalDegraded" in result).toBe(false);
});
