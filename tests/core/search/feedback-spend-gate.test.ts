/**
 * Recall feedback on a re-run the semantic lane never reached
 * (honest-query-embed-and-safe-upgrades, security audit round 1).
 *
 * `captureRecallFeedback` re-runs the query to read the judged result's
 * per-layer contributions. Under the spend gate a remote re-run is
 * keyword-only, so those shares describe the refusal, not the result:
 * recorded as a normal event they would push the vault-wide learned
 * weights toward keyword for as long as the gate holds. The event keeps
 * its audit row with zero contributions, which the fold skips.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";

import { TRANSPORT_REACH } from "../../../src/core/graph/transport-reach.ts";
import {
  captureRecallFeedback,
  NEUTRAL_LEARNED_WEIGHTS,
} from "../../../src/core/search/feedback.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { RETRIEVAL_DEGRADATION } from "../../../src/core/search/retrieval-trail.ts";
import type { ResolvedSearchConfig } from "../../../src/core/search/types.ts";
import { FAKE_PROVIDER_KEY } from "../../helpers/fake-credentials.ts";
import { startFakeHttp, type FakeHttp } from "../../helpers/fake-http.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";
import { sqliteVecLoadable } from "../../helpers/sqlite-vec.ts";

const MODEL = "fake-model";
const NOW = new Date("2026-10-06T12:00:00Z");

let server: FakeHttp;
let cleanup: () => void = () => {};

beforeEach(async () => {
  server = await startFakeHttp();
  server.setHandler((req) => {
    const body = (req.body ?? {}) as { input?: string[] };
    const batch = Array.isArray(body.input) ? body.input : [];
    return {
      status: 200,
      body: {
        data: batch.map((text, index) => ({
          object: "embedding",
          embedding: [text.length, index, 1, 1],
          index,
        })),
        model: MODEL,
      },
    };
  });
});

afterEach(async () => {
  cleanup();
  cleanup = () => {};
  await server.close();
});

/** Indexed with embeddings, then served under a positive gate on an unpriced model. */
async function gatedIndex(): Promise<ResolvedSearchConfig> {
  const v = createTempVault("feedback-spend-gate");
  cleanup = v.cleanup;
  writeMd(v.vault, "Notes/fox.md", "# Fox\n\nThe quick brown fox jumps over the lazy dog.");
  const config = makeConfig({
    vault: v.vault,
    dbPath: v.dbPath,
    semantic: {
      enabled: true,
      provider: "openai-compat",
      baseUrl: server.url,
      model: MODEL,
      apiKey: FAKE_PROVIDER_KEY,
      dimension: 4,
      maxRetries: 1,
      costGateUsd: 0,
    },
  });
  await indexVault(config, { embeddings: true });
  return { ...config, semantic: { ...config.semantic, costGateUsd: 1 } };
}

test.skipIf(!sqliteVecLoadable())(
  "feedback on a gated re-run keeps the row and carries no layer signal",
  async () => {
    const config = await gatedIndex();
    const out = await captureRecallFeedback(config, {
      query: "fox",
      resultPath: "Notes/fox.md",
      verdict: "up",
      nowMs: NOW.getTime(),
    });
    expect(out.resultFound).toBe(true);
    expect(out.degraded).toContain(RETRIEVAL_DEGRADATION.semanticCostUnpriced);
    expect(out.event.contributions).toEqual({ keyword: 0, semantic: 0, entity: 0, recency: 0 });
    // The row is kept and counted; it moves no multiplier.
    expect(out.learned.events).toBe(1);
    expect(out.learned).toMatchObject({
      keywordMul: NEUTRAL_LEARNED_WEIGHTS.keywordMul,
      semanticMul: NEUTRAL_LEARNED_WEIGHTS.semanticMul,
      entityMul: NEUTRAL_LEARNED_WEIGHTS.entityMul,
      recencyMul: NEUTRAL_LEARNED_WEIGHTS.recencyMul,
    });
  },
);

test.skipIf(!sqliteVecLoadable())(
  "feedback on an ungated local re-run records the layer contributions",
  async () => {
    const config = await gatedIndex();
    const out = await captureRecallFeedback(config, {
      query: "fox",
      resultPath: "Notes/fox.md",
      verdict: "up",
      nowMs: NOW.getTime(),
      transportReach: TRANSPORT_REACH.local,
    });
    expect(out.degraded).toEqual([]);
    expect(out.event.contributions.keyword).toBeGreaterThan(0);
    expect(out.learned.events).toBe(1);
    expect(out.learned.keywordMul).toBeGreaterThan(1);
  },
);

test("feedback on an index with no embeddings records the layer contributions", async () => {
  // Keyword-only by construction: the system the re-run measured is the
  // one that serves, so its shares are signal, not a degradation.
  const v = createTempVault("feedback-no-embeddings");
  cleanup = v.cleanup;
  writeMd(v.vault, "Notes/fox.md", "# Fox\n\nThe quick brown fox jumps over the lazy dog.");
  const config = makeConfig({
    vault: v.vault,
    dbPath: v.dbPath,
    semantic: {
      enabled: true,
      provider: "openai-compat",
      baseUrl: server.url,
      model: MODEL,
      apiKey: FAKE_PROVIDER_KEY,
      dimension: 4,
      maxRetries: 1,
      costGateUsd: 0,
    },
  });
  await indexVault(config);
  const out = await captureRecallFeedback(config, {
    query: "fox",
    resultPath: "Notes/fox.md",
    verdict: "up",
    nowMs: NOW.getTime(),
    transportReach: TRANSPORT_REACH.local,
  });
  expect(out.degraded).toContain(RETRIEVAL_DEGRADATION.semanticEmbeddingsAbsent);
  expect(out.degraded).toContain(RETRIEVAL_DEGRADATION.hybridDegraded);
  expect(out.event.contributions.keyword).toBeGreaterThan(0);
  expect(out.learned.keywordMul).toBeGreaterThan(1);
});

test.skipIf(!sqliteVecLoadable())(
  "feedback on an empty-fit re-run with no keyword hit carries no layer signal",
  async () => {
    // The instruction prefix alone fills the input window, so the semantic
    // lane never runs; the keyword lane finds nothing either, so no
    // `hybrid-degraded` umbrella is noted. The judged page still arrives
    // through the relational arm, scored without the semantic lane.
    const v = createTempVault("feedback-empty-fit");
    cleanup = v.cleanup;
    writeMd(v.vault, "qx.md", '---\nrelated: "[[neighbor]]"\n---\n\nalpha topic.');
    writeMd(v.vault, "neighbor.md", "# Beta\n\nbeta divergent content.");
    const semantic = {
      enabled: true,
      provider: "openai-compat" as const,
      baseUrl: server.url,
      model: MODEL,
      apiKey: FAKE_PROVIDER_KEY,
      dimension: 4,
      maxRetries: 1,
      costGateUsd: 0,
    };
    const indexed = makeConfig({ vault: v.vault, dbPath: v.dbPath, semantic });
    await indexVault(indexed, { embeddings: true });
    const config = makeConfig({
      vault: v.vault,
      dbPath: v.dbPath,
      fusionMode: "rrf",
      relationalArmEnabled: true,
      semantic: { ...semantic, inputWindowTokens: 1, queryPrefix: "a long instruction prefix: " },
    });
    const embedsBefore = server.callCount();
    const out = await captureRecallFeedback(config, {
      query: "[[qx]] related",
      resultPath: "neighbor.md",
      verdict: "up",
      nowMs: NOW.getTime(),
      transportReach: TRANSPORT_REACH.local,
    });
    expect(server.callCount()).toBe(embedsBefore);
    expect(out.resultFound).toBe(true);
    expect(out.degraded).toEqual([RETRIEVAL_DEGRADATION.semanticQueryEmptyFit]);
    expect(out.event.contributions).toEqual({ keyword: 0, semantic: 0, entity: 0, recency: 0 });
    expect(out.learned.events).toBe(1);
  },
);
