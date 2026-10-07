/**
 * Hook refusals become visible (honest-query-embed-and-safe-upgrades,
 * task 7).
 *
 * The recall-inject hook resolves to remote reach (it passes none), so
 * under a positive `embedding_cost_gate_usd` with an unpriced model its
 * semantic lane is refused by the query-embed gateway. Before this, the
 * default retriever mapped only `outcome.results` and dropped the search
 * trail, so that refusal - and every other semantic degradation at the
 * hook - was silent. The codes now ride the retrieval result, the
 * decision and the local audit line. The synced telemetry record does
 * not change.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  decideRecallInject,
  defaultRecallRetriever,
  recallInjectAuditDetails,
  recallInjectTelemetryMetadata,
  type RecallCandidate,
  type RecallRetriever,
} from "../../../src/core/brain/recall-inject.ts";
import type { RecallSliceSpec } from "../../../src/core/brain/types.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { indexVault, resolveSearchConfig } from "../../../src/core/search/index.ts";
import {
  RETRIEVAL_DEGRADATION,
  type RetrievalDegradationCode,
} from "../../../src/core/search/retrieval-trail.ts";
import { FAKE_PROVIDER_KEY } from "../../helpers/fake-credentials.ts";
import { startFakeHttp, type FakeHttp } from "../../helpers/fake-http.ts";
import { sqliteVecLoadable } from "../../helpers/sqlite-vec.ts";

const UNPRICED = RETRIEVAL_DEGRADATION.semanticCostUnpriced;
const HYBRID = RETRIEVAL_DEGRADATION.hybridDegraded;

function candidate(path: string): RecallCandidate {
  return {
    path,
    title: path,
    score: 0.9,
    searchType: "keyword",
    startLine: 1,
    endLine: 2,
  };
}

function retrieverWith(degraded?: ReadonlyArray<RetrievalDegradationCode>): RecallRetriever {
  return async () => ({
    candidates: [candidate("Notes/a.md")],
    total: 1,
    idfWeightedCoverage: 1,
    ...(degraded !== undefined ? { degraded } : {}),
  });
}

describe("the decision carries the retrieval's degradation codes", () => {
  test("an inject decision carries them onto the local audit line only", async () => {
    const decision = await decideRecallInject("ledger", retrieverWith([UNPRICED, HYBRID]));
    expect(decision.kind).toBe("inject");
    const audit = recallInjectAuditDetails(decision);
    expect(audit["retrieval_degraded"]).toEqual([UNPRICED, HYBRID]);

    const telemetry = recallInjectTelemetryMetadata(decision);
    expect("retrieval_degraded" in telemetry).toBe(false);
    expect(JSON.stringify(telemetry)).not.toContain(UNPRICED);
  });

  test("an abstain decision carries them too", async () => {
    const empty: RecallRetriever = async () => ({
      candidates: [],
      total: 0,
      idfWeightedCoverage: 0,
      degraded: [UNPRICED, HYBRID],
    });
    const decision = await decideRecallInject("ledger", empty);
    expect(decision.kind).toBe("abstain");
    expect(recallInjectAuditDetails(decision)["retrieval_degraded"]).toEqual([UNPRICED, HYBRID]);
  });

  test("a retrieval that reports nothing leaves the audit line byte-identical", async () => {
    for (const degraded of [undefined, []]) {
      const decision = await decideRecallInject("ledger", retrieverWith(degraded));
      expect(recallInjectAuditDetails(decision)).toEqual(recallInjectTelemetryMetadata(decision));
    }
  });

  test("the slice path carries the union of its slices' codes, once each", async () => {
    const spec = (name: string): RecallSliceSpec => ({
      name,
      heading: name,
      pathPrefix: null,
      types: [],
      limit: null,
      maxChars: null,
    });
    const perSlice: Record<string, ReadonlyArray<RetrievalDegradationCode>> = {
      first: [UNPRICED, HYBRID],
      second: [HYBRID, RETRIEVAL_DEGRADATION.rankCapTruncatedPool],
    };
    const decision = await decideRecallInject("ledger", retrieverWith(), {
      slices: [spec("first"), spec("second")],
      sliceRetriever: (s) => async () => ({
        candidates: [candidate(`${s.name}/a.md`)],
        total: 1,
        idfWeightedCoverage: 1,
        degraded: perSlice[s.name]!,
      }),
    });
    expect(recallInjectAuditDetails(decision)["retrieval_degraded"]).toEqual([
      UNPRICED,
      HYBRID,
      RETRIEVAL_DEGRADATION.rankCapTruncatedPool,
    ]);
  });

  test("an error decision keeps the codes of a slice that answered first", async () => {
    const spec = (name: string): RecallSliceSpec => ({
      name,
      heading: name,
      pathPrefix: null,
      types: [],
      limit: null,
      maxChars: null,
    });
    const decision = await decideRecallInject("ledger", retrieverWith(), {
      slices: [spec("gated"), spec("broken")],
      sliceRetriever: (s) =>
        s.name === "gated"
          ? retrieverWith([UNPRICED])
          : async () => {
              await new Promise((resolve) => setTimeout(resolve, 5));
              throw new Error("slice store unreadable");
            },
    });
    expect(decision.kind).toBe("error");
    expect(recallInjectAuditDetails(decision)["retrieval_degraded"]).toEqual([UNPRICED]);
    expect(JSON.stringify(recallInjectTelemetryMetadata(decision))).not.toContain(UNPRICED);
  });
});

describe("the default retriever under a positive gate and an unpriced model", () => {
  let tmp: string;
  let vault: string;
  let configPath: string;
  let server: FakeHttp;

  beforeEach(async () => {
    server = await startFakeHttp();
    tmp = mkdtempSync(join(tmpdir(), "o2b-recall-gate-"));
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
    "sends no embed, returns keyword candidates and names the refusal",
    async () => {
      const before = server.callCount();
      const set = await defaultRecallRetriever(configPath, vault)("quarterly ledger");
      expect(server.callCount()).toBe(before);
      expect(set.candidates.map((c) => c.path.replaceAll("\\", "/"))).toContain("Notes/ledger.md");
      expect(set.degraded).toContain(UNPRICED);
      expect(set.degraded).toContain(HYBRID);

      const decision = await decideRecallInject(
        "quarterly ledger",
        defaultRecallRetriever(configPath, vault),
        { confidenceFloor: 0 },
      );
      expect(recallInjectAuditDetails(decision)["retrieval_degraded"]).toContain(UNPRICED);
      expect(server.callCount()).toBe(before);
    },
  );
});
