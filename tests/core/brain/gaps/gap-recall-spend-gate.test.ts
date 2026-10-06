/**
 * The gap-promote hook's retriever carries the search trail's codes
 * (honest-query-embed-and-safe-upgrades, task 7).
 *
 * `gapScopedRecallRetriever` resolves to remote reach like every hook,
 * so under a positive cost gate with an unpriced model its semantic lane
 * is refused. The refusal is now named on its result instead of dropped.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gapScopedRecallRetriever } from "../../../../src/core/brain/gaps/gap-recall.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { indexVault, resolveSearchConfig } from "../../../../src/core/search/index.ts";
import { RETRIEVAL_DEGRADATION } from "../../../../src/core/search/retrieval-trail.ts";
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
