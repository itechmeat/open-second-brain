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
 * source, the query tokens and the nullable query cost. The query goes
 * through the shared query-embed gateway: an omitted reach is remote, the
 * text is fitted to the model's input window (a cut adds one warning) and
 * the disclosed query tokens count the instruction prefix.
 *
 * Deliberately not covered here: the reach filter and the
 * `BELIEF_VECTORS_MISSING` refusal, which are decided after the pack
 * knows its kept set (context-pack-semantic.test.ts and the MCP tool
 * test).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  BELIEF_VECTORS_BACKFILL_COMMAND,
  loadBeliefSemanticRelevance,
  scoreBeliefsByVector,
  type StoredBeliefVector,
} from "../../../src/core/brain/belief-semantic.ts";
import { TRANSPORT_REACH } from "../../../src/core/graph/transport-reach.ts";
import { COST_GATE_KEY, formatEstimatedUsd } from "../../../src/core/search/embedding-spend.ts";
import {
  E5_QUERY_PREFIX,
  INPUT_WINDOW_TOKENS_KEY,
} from "../../../src/core/search/embeddings/presets.ts";
import { EMBEDDING_PRICE_SOURCE } from "../../../src/core/search/embeddings/pricing.ts";
import {
  estimateTokens,
  LOCAL_EMBEDDING_MODEL,
} from "../../../src/core/search/embeddings/signature.ts";
import type { EmbedKind, EmbeddingProvider } from "../../../src/core/search/embeddings/contract.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { EMBEDDING_DIMENSION_STATE_KEY, Store } from "../../../src/core/search/store.ts";
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
const VEC_LOADABLE = sqliteVecLoadable();

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

  test("a note's relevance is its best chunk, not the sum of its chunks", () => {
    const result = scoreBeliefsByVector({
      model: MODEL,
      queryVector: [1, 0, 0, 0],
      vectorsByPath: new Map([
        ["Brain/preferences/a.md", [row([0.6, 0.8, 0, 0]), row([0.6, 0, 0.8, 0])]],
        ["Brain/preferences/b.md", [row([0.9, Math.sqrt(0.19), 0, 0])]],
      ]),
    });
    expect(result.order).toEqual(["Brain/preferences/b.md", "Brain/preferences/a.md"]);
    expect(result.relevanceByPath.get("Brain/preferences/a.md")).toBeCloseTo(0.6, 6);
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

  test("a stored vector longer than its recorded dimension is unusable, never a truncated score", () => {
    // Recorded at the query's dimension, but the blob holds more values:
    // a cosine over the first DIMENSION of them is a score of a vector
    // nobody stored.
    const query = unit([1, 0, 0, 0]);
    const scores = scoreBeliefsByVector({
      model: MODEL,
      queryVector: query,
      vectorsByPath: new Map([
        ["Brain/preferences/long.md", [{ ...row([1, 0, 0, 0, 1]), dimension: DIMENSION }]],
        ["Brain/preferences/ok.md", [row([0, 1, 0, 0])]],
      ]),
    });
    expect(scores.unembedded).toEqual(["Brain/preferences/long.md"]);
    expect(scores.order).toEqual(["Brain/preferences/ok.md"]);
  });

  // The store guard rejects such rows only since v1.32.0; an older index
  // can still hold one, and its NaN cosine must not reach the order.
  test("a stored zero or non-finite vector is unusable, never a NaN relevance", () => {
    const stored = (values: number[]): StoredBeliefVector => ({
      vector: Float32Array.from(values),
      model: MODEL,
      dimension: values.length,
    });
    const result = scoreBeliefsByVector({
      model: MODEL,
      queryVector: unit([1, 0, 0, 0]),
      vectorsByPath: new Map([
        ["Brain/preferences/zero.md", [stored([0, 0, 0, 0])]],
        ["Brain/preferences/nan.md", [stored([Number.NaN, 0, 0, 0])]],
        ["Brain/preferences/mixed.md", [stored([0, 0, 0, 0]), row([1, 0, 0, 0])]],
      ]),
    });
    expect([...result.relevanceByPath.keys()]).toEqual(["Brain/preferences/mixed.md"]);
    expect(result.relevanceByPath.get("Brain/preferences/mixed.md")).toBeCloseTo(1, 6);
    expect(result.unembedded).toEqual(["Brain/preferences/nan.md", "Brain/preferences/zero.md"]);
  });
});

describe("loadBeliefSemanticRelevance", () => {
  test.skipIf(!VEC_LOADABLE)(
    "reads stored belief vectors, embeds the query once and discloses the spend",
    async () => {
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
    },
  );

  test.skipIf(!VEC_LOADABLE)("an operator-priced model reports its query cost", async () => {
    writeBelief("Brain/preferences/pref-a.md", "pref-a", "Keep answers short");
    const config = vecConfig({ priceOverride: { model: MODEL, usdPerMtok: 2 } });
    await indexVault(config);
    await plant(config, { "Brain/preferences/pref-a.md": { vector: [1, 0, 0, 0] } });
    const { provider } = countingProvider(unit([1, 0, 0, 0]));

    const loaded = await loadBeliefSemanticRelevance(config, QUERY, { provider });

    expect(loaded.report.priceSource).toBe(EMBEDDING_PRICE_SOURCE.operator);
    expect(loaded.report.estimatedUsd).toBeCloseTo((loaded.report.queryTokens / 1_000_000) * 2, 12);
  });

  test.skipIf(!VEC_LOADABLE)(
    "the local provider prices its query as the local model, not a leftover embedding_model",
    async () => {
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
    },
  );

  test.skipIf(!VEC_LOADABLE)(
    "no belief row under the model refuses with BELIEF_VECTORS_MISSING before any query embed",
    async () => {
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
    },
  );

  test.skipIf(!VEC_LOADABLE)(
    "a row under the model at another dimension still embeds and reads as unembedded",
    async () => {
      writeBelief("Brain/preferences/pref-a.md", "pref-a", "Keep answers short");
      const config = vecConfig();
      await indexVault(config);
      await plant(config, { "Brain/preferences/pref-a.md": { vector: [1, 0, 0, 0] } });
      const { provider, calls } = countingProvider(unit([1, 0, 0]));

      const loaded = await loadBeliefSemanticRelevance(config, QUERY, { provider });

      expect(calls).toHaveLength(1);
      expect(loaded.scored).toBe(0);
      expect(loaded.unembedded).toEqual(["Brain/preferences/pref-a.md"]);
    },
  );

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

  // No belief note on purpose: with one, the per-document vector read
  // throws the same code, so only an empty belief set proves the guard
  // runs before the query embed.
  test("a store without sqlite-vec refuses with VEC_EXTENSION_UNAVAILABLE before any query embed", async () => {
    writeMd(vault, "notes/n.md", "# A note\n\nNot a belief.\n");
    const config = vecConfig();
    await indexVault(config);
    const refusal = await loadBeliefSemanticRelevance(config, QUERY, {
      provider: throwingProvider,
      loadVec: false,
    }).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(SearchError);
    expect((refusal as SearchError).code).toBe("VEC_EXTENSION_UNAVAILABLE");
  });

  test.skipIf(!VEC_LOADABLE)(
    "a sibling directory sharing the prefix string is not a belief",
    async () => {
      writeBelief("Brain/preferences/pref-a.md", "pref-a", "Keep answers short");
      writeBelief("Brain/preferences-archive/x.md", "pref-x", "Keep answers short");
      const config = vecConfig();
      await indexVault(config);
      await plant(config, {
        "Brain/preferences/pref-a.md": { vector: [1, 0, 0, 0] },
        "Brain/preferences-archive/x.md": { vector: [1, 0, 0, 0] },
      });
      const { provider } = countingProvider(unit([1, 0, 0, 0]));

      const loaded = await loadBeliefSemanticRelevance(config, QUERY, { provider });

      expect([...loaded.relevanceByPath.keys()]).toEqual(["Brain/preferences/pref-a.md"]);
      expect(loaded.unembedded).toEqual([]);
    },
  );

  for (const [label, vector] of [
    ["an empty", []],
    ["a non-finite", [Number.NaN, 0, 0, 0]],
  ] as const) {
    test.skipIf(!VEC_LOADABLE)(
      `${label} query vector is refused with EMBEDDING_INVALID_VECTOR`,
      async () => {
        writeBelief("Brain/preferences/pref-a.md", "pref-a", "Keep answers short");
        const config = vecConfig();
        await indexVault(config);
        await plant(config, { "Brain/preferences/pref-a.md": { vector: [1, 0, 0, 0] } });
        const { provider } = countingProvider([...vector]);

        const refusal = await loadBeliefSemanticRelevance(config, QUERY, { provider }).catch(
          (e: unknown) => e,
        );

        expect(refusal).toBeInstanceOf(SearchError);
        expect((refusal as SearchError).code).toBe("EMBEDDING_INVALID_VECTOR");
        expect((refusal as SearchError).message).toContain("belief semantic query");
        // The provider answered, so the call was paid: the refusal names it.
        expect((refusal as SearchError).message).toContain("the query embed was still spent");
        expect((refusal as SearchError).message).toContain(`model ${MODEL}`);
        expect((refusal as SearchError).message).toContain("price source unknown");
      },
    );
  }

  describe("an unpriced query embed under a positive cost gate", () => {
    async function seed(semantic: Partial<ResolvedEmbeddingConfig>): Promise<ResolvedSearchConfig> {
      writeBelief("Brain/preferences/pref-a.md", "pref-a", "Keep answers short");
      const config = vecConfig(semantic);
      await indexVault(config);
      await plant(config, { "Brain/preferences/pref-a.md": { vector: [1, 0, 0, 0] } });
      return config;
    }

    test.skipIf(!VEC_LOADABLE)(
      "is refused for a remote caller with EMBEDDING_COST_UNPRICED before anything is embedded",
      async () => {
        const config = await seed({ costGateUsd: 1 });

        const refusal = await loadBeliefSemanticRelevance(config, QUERY, {
          provider: throwingProvider,
          reach: TRANSPORT_REACH.remote,
        }).catch((e: unknown) => e);

        expect(refusal).toBeInstanceOf(SearchError);
        expect((refusal as SearchError).code).toBe("EMBEDDING_COST_UNPRICED");
        // The operator's budget is not the remote caller's business.
        expect((refusal as SearchError).message).toContain(`${COST_GATE_KEY} is positive`);
        expect((refusal as SearchError).message).not.toContain(formatEstimatedUsd(1));
      },
    );

    // An omitted reach resolves as everywhere else in the tree: remote.
    test.skipIf(!VEC_LOADABLE)(
      "is refused with EMBEDDING_COST_UNPRICED when the caller names no reach",
      async () => {
        const config = await seed({ costGateUsd: 1 });

        const refusal = await loadBeliefSemanticRelevance(config, QUERY, {
          provider: throwingProvider,
        }).catch((e: unknown) => e);

        expect(refusal).toBeInstanceOf(SearchError);
        expect((refusal as SearchError).code).toBe("EMBEDDING_COST_UNPRICED");
      },
    );

    test.skipIf(!VEC_LOADABLE)("is embedded once and disclosed for a local caller", async () => {
      const config = await seed({ costGateUsd: 1 });
      const { provider, calls } = countingProvider(unit([1, 0, 0, 0]));

      const loaded = await loadBeliefSemanticRelevance(config, QUERY, {
        provider,
        reach: TRANSPORT_REACH.local,
      });

      expect(calls).toHaveLength(1);
      expect(loaded.report.priceSource).toBe(EMBEDDING_PRICE_SOURCE.unknown);
    });

    test.skipIf(!VEC_LOADABLE)(
      "is embedded for a remote caller once the model is priced or the gate is off",
      async () => {
        await seed({});
        for (const semantic of [
          { costGateUsd: 1, priceOverride: { model: MODEL, usdPerMtok: 2 } },
          { costGateUsd: 0 },
        ]) {
          const config = vecConfig(semantic);
          const { provider, calls } = countingProvider(unit([1, 0, 0, 0]));
          // eslint-disable-next-line no-await-in-loop
          await loadBeliefSemanticRelevance(config, QUERY, {
            provider,
            reach: TRANSPORT_REACH.remote,
          });
          expect(calls).toHaveLength(1);
        }
      },
    );
  });

  describe("the query is fitted to the model's input window", () => {
    const E5_MODEL = "intfloat/multilingual-e5-small";

    async function seed(semantic: Partial<ResolvedEmbeddingConfig>): Promise<ResolvedSearchConfig> {
      writeBelief("Brain/preferences/pref-a.md", "pref-a", "Keep answers short");
      const config = vecConfig({ model: E5_MODEL, queryPrefix: E5_QUERY_PREFIX, ...semantic });
      await indexVault(config);
      await plant(config, {
        "Brain/preferences/pref-a.md": { vector: [1, 0, 0, 0], model: E5_MODEL },
      });
      return config;
    }

    test.skipIf(!VEC_LOADABLE)(
      "discloses the query tokens of the text sent, instruction prefix included",
      async () => {
        const config = await seed({});
        const { provider, calls } = countingProvider(unit([1, 0, 0, 0]));

        const loaded = await loadBeliefSemanticRelevance(config, QUERY, { provider });

        // The provider adds the prefix itself, so the query goes in bare.
        expect(calls).toEqual([{ texts: [QUERY], kind: "query" }]);
        expect(loaded.report.queryTokens).toBe(estimateTokens([E5_QUERY_PREFIX + QUERY]));
        expect(loaded.report.queryTokens).toBeGreaterThan(estimateTokens([QUERY]));
        expect(loaded.warnings).toEqual([]);
      },
    );

    test.skipIf(!VEC_LOADABLE)(
      "embeds an over-window query cut, with one warning naming the window",
      async () => {
        const config = await seed({ inputWindowTokens: 8 });
        const { provider, calls } = countingProvider(unit([1, 0, 0, 0]));
        const long = `${QUERY} ${"and keep every answer brief ".repeat(20)}`;

        const loaded = await loadBeliefSemanticRelevance(config, long, { provider });

        expect(calls).toHaveLength(1);
        const sent = calls[0]!.texts[0]!;
        expect(sent.length).toBeGreaterThan(0);
        expect(sent.length).toBeLessThan(long.length);
        expect(long.startsWith(sent)).toBe(true);
        expect(loaded.report.queryTokens).toBe(estimateTokens([E5_QUERY_PREFIX + sent]));
        expect(loaded.warnings).toHaveLength(1);
        expect(loaded.warnings[0]).toContain("8-token");
        expect(loaded.warnings[0]).toContain(INPUT_WINDOW_TOKENS_KEY);
        expect(loaded.scored).toBe(1);
      },
    );

    test.skipIf(!VEC_LOADABLE)(
      "refuses with INVALID_INPUT before any embed when the prefix alone fills the window",
      async () => {
        const config = await seed({ inputWindowTokens: 1 });

        const refusal = await loadBeliefSemanticRelevance(config, QUERY, {
          provider: throwingProvider,
        }).catch((e: unknown) => e);

        expect(refusal).toBeInstanceOf(SearchError);
        expect((refusal as SearchError).code).toBe("INVALID_INPUT");
        expect((refusal as SearchError).message).toContain("1-token");
        expect((refusal as SearchError).message).toContain(INPUT_WINDOW_TOKENS_KEY);
      },
    );
  });

  test.skipIf(!VEC_LOADABLE)("a contradicted embedding identity reaches the warnings", async () => {
    writeBelief("Brain/preferences/pref-a.md", "pref-a", "Keep answers short");
    const config = vecConfig();
    await indexVault(config);
    await plant(config, { "Brain/preferences/pref-a.md": { vector: [1, 0, 0, 0] } });
    const store = await Store.open(config, { mode: "write" });
    store.setState(EMBEDDING_DIMENSION_STATE_KEY, "8");
    await store.close();
    const { provider } = countingProvider(unit([1, 0, 0, 0]));

    const loaded = await loadBeliefSemanticRelevance(config, QUERY, { provider });

    expect(loaded.warnings).toHaveLength(1);
    expect(loaded.warnings[0]).toContain(EMBEDDING_DIMENSION_STATE_KEY);
  });
});
