/**
 * A tuning sweep measured with the semantic lane missing never saves its
 * winner (honest-query-embed-and-safe-upgrades, security final).
 *
 * The refusal reads the one shared "semantic lane missing" predicate, so
 * every stop that leaves a hybrid caller keyword-only refuses, including
 * the composite deadline, which no lane-specific code names. A blocked
 * capability refuses with the code the explicit lane throws for the same
 * rung, so a missing credential is not reported as a disabled provider.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

import { TRANSPORT_REACH } from "../../../src/core/graph/transport-reach.ts";
import { parseRecallBenchmarkDataset } from "../../../src/core/search/benchmark.ts";
import { INPUT_WINDOW_TOKENS_KEY } from "../../../src/core/search/embeddings/presets.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import {
  RETRIEVAL_DEGRADATION,
  semanticLaneMissing,
} from "../../../src/core/search/retrieval-trail.ts";
import { tuneRecall } from "../../../src/core/search/tuning.ts";
import { tuningPath } from "../../../src/core/search/tuning-store.ts";
import { SearchError, type ResolvedSearchConfig } from "../../../src/core/search/types.ts";
import { FAKE_PROVIDER_KEY } from "../../helpers/fake-credentials.ts";
import { startFakeHttp, type FakeHttp, type FakeResponseSpec } from "../../helpers/fake-http.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";
import { sqliteVecLoadable } from "../../helpers/sqlite-vec.ts";

const MODEL = "fake-model";
const NOW = new Date("2026-10-06T12:00:00Z");
const GRID = [{ poolMultiplier: 3, traversalDepth: 1, learnedWeights: false, expansion: false }];
const DATASET = parseRecallBenchmarkDataset({
  queries: [{ id: "fox", query: "fox", expected: ["Notes/fox.md"] }],
});

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

async function embeddedIndex(): Promise<ResolvedSearchConfig> {
  const v = createTempVault("tuning-semantic-lane");
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
  return config;
}

async function refusal(config: ResolvedSearchConfig): Promise<SearchError> {
  let err: unknown = null;
  try {
    await tuneRecall(config, DATASET, {
      grid: GRID,
      now: NOW,
      transportReach: TRANSPORT_REACH.local,
    });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(SearchError);
  return err as SearchError;
}

describe("semanticLaneMissing", () => {
  test("a hybrid caller served keyword-only is missing the lane", () => {
    expect(
      semanticLaneMissing([
        RETRIEVAL_DEGRADATION.hybridDeadlineExceeded,
        RETRIEVAL_DEGRADATION.hybridDegraded,
      ]),
    ).toBe(true);
  });

  test("a keyword-only-by-construction index or machine is not", () => {
    for (const code of [
      RETRIEVAL_DEGRADATION.semanticEmbeddingsAbsent,
      RETRIEVAL_DEGRADATION.semanticVecExtensionUnavailable,
    ]) {
      expect(semanticLaneMissing([code, RETRIEVAL_DEGRADATION.hybridDegraded])).toBe(false);
    }
  });

  test("a lane stop counts without the umbrella, which needs a keyword hit", () => {
    for (const code of [
      RETRIEVAL_DEGRADATION.semanticCapabilityBlocked,
      RETRIEVAL_DEGRADATION.semanticCostUnpriced,
      RETRIEVAL_DEGRADATION.semanticProviderUnavailable,
      RETRIEVAL_DEGRADATION.semanticEmptyQueryVector,
      RETRIEVAL_DEGRADATION.semanticQueryEmptyFit,
    ]) {
      expect(semanticLaneMissing([code])).toBe(true);
    }
  });

  test("a cut query or a clean trail is not", () => {
    expect(semanticLaneMissing([RETRIEVAL_DEGRADATION.semanticQueryTruncated])).toBe(false);
    expect(semanticLaneMissing([])).toBe(false);
  });
});

test.skipIf(!sqliteVecLoadable())(
  "a sweep the hybrid deadline cut refuses to save its winner",
  async () => {
    const config = await embeddedIndex();
    // The provider sleeps past the composite budget on every query embed.
    server.setHandler(() => new Promise<FakeResponseSpec>(() => {}));
    const err = await refusal({ ...config, hybridDeadlineMs: 200 });
    expect(err.message).toContain(RETRIEVAL_DEGRADATION.hybridDeadlineExceeded);
    expect(existsSync(tuningPath(config.vault))).toBe(false);
  },
);
test.skipIf(!sqliteVecLoadable())(
  "a sweep under a missing credential refuses with the credential code",
  async () => {
    const config = await embeddedIndex();
    const err = await refusal({ ...config, semantic: { ...config.semantic, apiKey: null } });
    expect(err.code).toBe("EMBEDDING_KEY_MISSING");
    expect(err.message).toContain("Complete the embedding provider configuration");
    expect(existsSync(tuningPath(config.vault))).toBe(false);
  },
);

test.skipIf(!sqliteVecLoadable())(
  "a sweep under a disabled provider keeps the disabled code",
  async () => {
    const config = await embeddedIndex();
    const err = await refusal({
      ...config,
      semantic: { ...config.semantic, provider: "disabled" },
    });
    expect(err.code).toBe("EMBEDDING_DISABLED");
    expect(existsSync(tuningPath(config.vault))).toBe(false);
  },
);

test.skipIf(!sqliteVecLoadable())(
  "a sweep whose query prefix fills the input window names the window lever",
  async () => {
    const config = await embeddedIndex();
    const err = await refusal({
      ...config,
      semantic: { ...config.semantic, inputWindowTokens: 1, queryPrefix: "query: " },
    });
    expect(err.message).toContain(RETRIEVAL_DEGRADATION.semanticQueryEmptyFit);
    expect(err.message).toContain(INPUT_WINDOW_TOKENS_KEY);
    expect(existsSync(tuningPath(config.vault))).toBe(false);
  },
);
