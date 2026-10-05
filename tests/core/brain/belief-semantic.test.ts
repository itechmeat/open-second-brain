/**
 * Belief vector scorer and loader (Honest Embedding Spend, task 11).
 *
 * Pins the read side of `brain_context_pack` `semantic` mode: the pure
 * scorer takes the maximum cosine per belief note over the vectors it is
 * handed, counts a row written by another model or at another dimension
 * as unembedded rather than scored, and orders ties by path; the
 * store-backed loader reads the stored vectors of `Brain/preferences/`
 * and `Brain/retired/` notes, embeds the query exactly once with the
 * `query` prefix kind, refuses a blocked tier and a missing sqlite-vec
 * by name BEFORE any query embed, and discloses the model, the price
 * source, the query tokens and the nullable query cost.
 *
 * Deliberately not covered here: the reach filter and the
 * `BELIEF_VECTORS_MISSING` refusal, which are decided after the pack
 * knows its kept set (context-pack-semantic.test.ts and the MCP tool
 * test).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  BELIEF_SEMANTIC_PATH_PREFIXES,
  BELIEF_VECTORS_BACKFILL_COMMAND,
  loadBeliefSemanticRelevance,
  scoreBeliefsByVector,
  type StoredBeliefVector,
} from "../../../src/core/brain/belief-semantic.ts";
import { EMBEDDING_PRICE_SOURCE } from "../../../src/core/search/embeddings/pricing.ts";
import { LOCAL_EMBEDDING_MODEL } from "../../../src/core/search/embeddings/signature.ts";
import type { EmbedKind, EmbeddingProvider } from "../../../src/core/search/embeddings/contract.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { Store } from "../../../src/core/search/store.ts";
import { SearchError } from "../../../src/core/search/search-error.ts";
import type {
  ResolvedEmbeddingConfig,
  ResolvedSearchConfig,
} from "../../../src/core/search/types.ts";
import { sqliteVecLoadable } from "../../helpers/sqlite-vec.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

const MODEL = "c11-model";
const OTHER_MODEL = "c11-older-model";
const DIMENSION = 4;
const QUERY = "how should replies be phrased";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("c11-belief-semantic"));
});

afterEach(() => cleanup());

function unit(values: number[]): number[] {
  const norm = Math.hypot(...values);
  return values.map((v) => v / norm);
}

function row(values: number[], model = MODEL, dimension = values.length): StoredBeliefVector {
  return { vector: Float32Array.from(unit(values)), model, dimension };
}

function vecConfig(semantic: Partial<ResolvedEmbeddingConfig> = {}): ResolvedSearchConfig {
  return makeConfig({
    vault,
    dbPath,
    semantic: {
      enabled: true,
      baseUrl: "https://x/v1",
      model: MODEL,
      apiKey: "k",
      dimension: DIMENSION,
      ...semantic,
    },
  });
}

/** A provider that records every embed call and answers with one fixed vector. */
function countingProvider(vector: number[]): {
  provider: EmbeddingProvider;
  calls: Array<{ texts: ReadonlyArray<string>; kind: EmbedKind | undefined }>;
} {
  const calls: Array<{ texts: ReadonlyArray<string>; kind: EmbedKind | undefined }> = [];
  const provider: EmbeddingProvider = {
    name: "c11-counting",
    model: MODEL,
    dimension: vector.length,
    async embed(texts, kind) {
      calls.push({ texts, kind });
      return texts.map(() => [...vector]);
    },
    async ping() {
      return { ok: true, dimension: vector.length };
    },
  };
  return { provider, calls };
}

/** A provider that fails the test the moment anything asks it to embed. */
const throwingProvider: EmbeddingProvider = {
  name: "c11-throwing",
  model: MODEL,
  dimension: DIMENSION,
  async embed() {
    throw new Error("the query must not be embedded before the refusal");
  },
  async ping() {
    return { ok: false, reason: "never pinged" };
  },
};

function writeBelief(relPath: string, id: string, principle: string): void {
  writeMd(
    vault,
    relPath,
    `---\nid: ${id}\ntopic: ${id}\nprinciple: ${principle}\n---\n\n## Principle\n\n${principle}\n`,
  );
}

async function plant(
  config: ResolvedSearchConfig,
  byPath: Record<string, { vector: number[]; model?: string }>,
): Promise<void> {
  const store = await Store.open(config, { mode: "write" });
  try {
    for (const [path, planted] of Object.entries(byPath)) {
      const docId = store.getDocumentIdByPath(path);
      expect(docId).not.toBeNull();
      for (const chunk of store.chunksForDocument(docId!)) {
        store.vecUpsert(
          chunk.id,
          unit(planted.vector),
          planted.model ?? MODEL,
          DIMENSION,
          `eh-${path}-${chunk.id}`,
        );
      }
    }
  } finally {
    await store.close();
  }
}

describe("scoreBeliefsByVector", () => {
  test("scores each path by its best chunk and orders by score, then path", () => {
    const result = scoreBeliefsByVector({
      model: MODEL,
      queryVector: unit([1, 0, 0, 0]),
      vectorsByPath: new Map([
        ["Brain/preferences/b.md", [row([0, 1, 0, 0]), row([1, 0.1, 0, 0])]],
        ["Brain/preferences/a.md", [row([1, 0.1, 0, 0])]],
        ["Brain/preferences/c.md", [row([0, 0, 1, 0])]],
      ]),
    });
    expect(result.order).toEqual([
      "Brain/preferences/a.md",
      "Brain/preferences/b.md",
      "Brain/preferences/c.md",
    ]);
    expect(result.relevanceByPath.get("Brain/preferences/a.md")).toBeCloseTo(
      result.relevanceByPath.get("Brain/preferences/b.md")!,
      12,
    );
    expect(result.relevanceByPath.get("Brain/preferences/c.md")).toBeCloseTo(0, 12);
    expect(result.scored).toBe(3);
    expect(result.unembedded).toEqual([]);
  });

  test("rows from another model or dimension count as unembedded, never as scored", () => {
    const result = scoreBeliefsByVector({
      model: MODEL,
      queryVector: unit([1, 0, 0, 0]),
      vectorsByPath: new Map([
        ["Brain/preferences/stale-model.md", [row([1, 0, 0, 0], OTHER_MODEL)]],
        ["Brain/preferences/stale-dim.md", [row([1, 0, 0], MODEL)]],
        ["Brain/preferences/none.md", []],
        ["Brain/preferences/fresh.md", [row([0, 1, 0, 0]), row([1, 0, 0, 0], OTHER_MODEL)]],
      ]),
    });
    expect(result.scored).toBe(1);
    expect([...result.relevanceByPath.keys()]).toEqual(["Brain/preferences/fresh.md"]);
    expect(result.relevanceByPath.get("Brain/preferences/fresh.md")).toBeCloseTo(0, 12);
    expect(result.unembedded).toEqual([
      "Brain/preferences/none.md",
      "Brain/preferences/stale-dim.md",
      "Brain/preferences/stale-model.md",
    ]);
  });
});

describe("loadBeliefSemanticRelevance", () => {
  test("reads stored belief vectors, embeds the query once and discloses the spend", async () => {
    if (!sqliteVecLoadable()) return;
    writeBelief("Brain/preferences/pref-near.md", "pref-near", "Keep answers short");
    writeBelief("Brain/preferences/pref-far.md", "pref-far", "Use tabs in makefiles");
    writeBelief("Brain/retired/pref-old.md", "pref-old", "Answer in long form");
    writeBelief("Brain/preferences/pref-stale.md", "pref-stale", "Reply politely");
    writeBelief("Brain/preferences/pref-new.md", "pref-new", "Never guess");
    writeMd(vault, "Notes/elsewhere.md", "# Elsewhere\n\nA note that is not a belief.\n");
    const config = vecConfig();
    await indexVault(config);
    await plant(config, {
      "Brain/preferences/pref-near.md": { vector: [1, 0.05, 0, 0] },
      "Brain/preferences/pref-far.md": { vector: [0, 0, 0, 1] },
      "Brain/retired/pref-old.md": { vector: [0.7, 0.7, 0, 0] },
      "Brain/preferences/pref-stale.md": { vector: [1, 0, 0, 0], model: OTHER_MODEL },
      "Notes/elsewhere.md": { vector: [1, 0, 0, 0] },
    });
    const { provider, calls } = countingProvider(unit([1, 0, 0, 0]));

    const loaded = await loadBeliefSemanticRelevance(config, QUERY, { provider });

    expect(calls).toEqual([{ texts: [QUERY], kind: "query" }]);
    expect(loaded.order).toEqual([
      "Brain/preferences/pref-near.md",
      "Brain/retired/pref-old.md",
      "Brain/preferences/pref-far.md",
    ]);
    expect(loaded.relevanceByPath.has("Notes/elsewhere.md")).toBe(false);
    expect(loaded.unembedded).toEqual([
      "Brain/preferences/pref-new.md",
      "Brain/preferences/pref-stale.md",
    ]);
    expect(loaded.scored).toBe(3);
    expect(loaded.report.model).toBe(MODEL);
    expect(loaded.report.priceSource).toBe(EMBEDDING_PRICE_SOURCE.unknown);
    expect(loaded.report.estimatedUsd).toBeNull();
    expect(loaded.report.queryTokens).toBeGreaterThan(0);
    expect(loaded.warnings).toEqual([]);
  });

  test("an operator-priced model reports its query cost", async () => {
    if (!sqliteVecLoadable()) return;
    writeBelief("Brain/preferences/pref-a.md", "pref-a", "Keep answers short");
    const config = vecConfig({ priceOverride: { model: MODEL, usdPerMtok: 2 } });
    await indexVault(config);
    await plant(config, { "Brain/preferences/pref-a.md": { vector: [1, 0, 0, 0] } });
    const { provider } = countingProvider(unit([1, 0, 0, 0]));

    const loaded = await loadBeliefSemanticRelevance(config, QUERY, { provider });

    expect(loaded.report.priceSource).toBe(EMBEDDING_PRICE_SOURCE.operator);
    expect(loaded.report.estimatedUsd).toBeCloseTo((loaded.report.queryTokens / 1_000_000) * 2, 12);
  });

  test("the local provider prices its query as the local model, not a leftover embedding_model", async () => {
    if (!sqliteVecLoadable()) return;
    writeBelief("Brain/preferences/pref-a.md", "pref-a", "Keep answers short");
    const config = vecConfig({ provider: "local", apiKey: null });
    await indexVault(config);
    await plant(config, { "Brain/preferences/pref-a.md": { vector: [1, 0, 0, 0] } });
    const { provider } = countingProvider(unit([1, 0, 0, 0]));

    const loaded = await loadBeliefSemanticRelevance(config, QUERY, { provider });

    expect(loaded.scored).toBe(1);
    expect(loaded.report.model).toBe(LOCAL_EMBEDDING_MODEL);
    expect(loaded.report.priceSource).toBe(EMBEDDING_PRICE_SOURCE.builtin);
    expect(loaded.report.estimatedUsd).toBe(0);
  });

  test("no belief row under the model refuses with BELIEF_VECTORS_MISSING before any query embed", async () => {
    if (!sqliteVecLoadable()) return;
    writeBelief("Brain/preferences/pref-a.md", "pref-a", "Keep answers short");
    writeBelief("Brain/preferences/pref-b.md", "pref-b", "Reply politely");
    const config = vecConfig();
    await indexVault(config);
    await plant(config, {
      "Brain/preferences/pref-b.md": { vector: [1, 0, 0, 0], model: OTHER_MODEL },
    });

    const refusal = await loadBeliefSemanticRelevance(config, QUERY, {
      provider: throwingProvider,
    }).catch((e: unknown) => e);

    expect(refusal).toBeInstanceOf(SearchError);
    expect((refusal as SearchError).code).toBe("BELIEF_VECTORS_MISSING");
    expect((refusal as SearchError).message).toContain(BELIEF_VECTORS_BACKFILL_COMMAND);
  });

  test("a row under the model at another dimension still embeds and reads as unembedded", async () => {
    if (!sqliteVecLoadable()) return;
    writeBelief("Brain/preferences/pref-a.md", "pref-a", "Keep answers short");
    const config = vecConfig();
    await indexVault(config);
    await plant(config, { "Brain/preferences/pref-a.md": { vector: [1, 0, 0, 0] } });
    const { provider, calls } = countingProvider(unit([1, 0, 0]));

    const loaded = await loadBeliefSemanticRelevance(config, QUERY, { provider });

    expect(calls).toHaveLength(1);
    expect(loaded.scored).toBe(0);
    expect(loaded.unembedded).toEqual(["Brain/preferences/pref-a.md"]);
  });

  test("a disabled tier refuses with EMBEDDING_DISABLED before any query embed", async () => {
    const config = vecConfig({ enabled: false });
    const refusal = await loadBeliefSemanticRelevance(config, QUERY, {
      provider: throwingProvider,
    }).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(SearchError);
    expect((refusal as SearchError).code).toBe("EMBEDDING_DISABLED");
  });

  test("a missing credential refuses with EMBEDDING_KEY_MISSING before any query embed", async () => {
    const config = vecConfig({ apiKey: null });
    const refusal = await loadBeliefSemanticRelevance(config, QUERY, {
      provider: throwingProvider,
    }).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(SearchError);
    expect((refusal as SearchError).code).toBe("EMBEDDING_KEY_MISSING");
  });

  test("a store without sqlite-vec refuses with VEC_EXTENSION_UNAVAILABLE before any query embed", async () => {
    writeBelief("Brain/preferences/pref-a.md", "pref-a", "Keep answers short");
    const config = vecConfig();
    await indexVault(config);
    const refusal = await loadBeliefSemanticRelevance(config, QUERY, {
      provider: throwingProvider,
      loadVec: false,
    }).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(SearchError);
    expect((refusal as SearchError).code).toBe("VEC_EXTENSION_UNAVAILABLE");
  });

  test("the scored set is the preferences and retired directories", () => {
    expect(BELIEF_SEMANTIC_PATH_PREFIXES).toEqual(["Brain/preferences/", "Brain/retired/"]);
  });
});
