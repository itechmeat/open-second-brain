/**
 * Optional pluggable cross-encoder rerank stage
 * (retrieval-precision-quality-loop, card A / t_110867f5).
 *
 * Covers the four acceptance cases from the plan:
 *   1. Disabled (default): input returned unchanged (byte-identical).
 *   2. Enabled + unconfigured: fail closed with a clear typed error.
 *   3. Enabled + endpoint returns scores: top-K re-ordered; a doc the
 *      heuristic ranker placed 3rd but scored highest lands 1st.
 *   4. Enabled + endpoint errors: degrades to the heuristic input (no
 *      throw) and emits exactly one fail-open telemetry event.
 */

import { describe, expect, test } from "bun:test";

import {
  applyCrossEncoderRerank,
  type RerankTelemetryEvent,
} from "../../../src/core/search/rerank/index.ts";
import type { RerankProvider } from "../../../src/core/search/rerank/contract.ts";
import { SearchError } from "../../../src/core/search/types.ts";
import type { BrainSearchResult, ResolvedRerankConfig } from "../../../src/core/search/types.ts";

function result(id: number, content: string): BrainSearchResult {
  return Object.freeze({
    documentId: id,
    chunkId: id,
    path: `note-${id}.md`,
    title: `Note ${id}`,
    content,
    startLine: 1,
    endLine: 2,
    score: 1 - id * 0.1,
    keywordScore: 0.5,
    semanticScore: 0.5,
    linkBoost: 0,
    recencyBoost: 0,
    searchType: "hybrid" as const,
    reasons: Object.freeze([`fts5_bm25: 0.500`]),
  });
}

const BASE: ResolvedRerankConfig = Object.freeze({
  enabled: false,
  kind: "openai-compat",
  baseUrl: null,
  model: null,
  envKey: null,
  apiKey: null,
  topK: 20,
  minScore: 0,
});

/** A deterministic stub returning caller-supplied scores by document index. */
function stubProvider(scoresByContent: (content: string, i: number) => number): RerankProvider {
  return {
    name: "stub",
    model: "stub-1",
    async rerank(_query, documents) {
      return documents.map((d, i) => scoresByContent(d, i));
    },
  };
}

describe("applyCrossEncoderRerank", () => {
  test("disabled (default) returns the exact input reference unchanged", async () => {
    const input = Object.freeze([result(1, "a"), result(2, "b"), result(3, "c")]);
    const out = await applyCrossEncoderRerank(input, "q", BASE);
    // Same reference: no allocation, byte-identical ordering.
    expect(out).toBe(input);
  });

  test("enabled but unconfigured fails closed with a clear typed error", async () => {
    const cfg = Object.freeze({ ...BASE, enabled: true });
    let thrown: unknown;
    try {
      await applyCrossEncoderRerank([result(1, "a")], "q", cfg, { env: {} });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SearchError);
    expect((thrown as SearchError).message).toMatch(/search_rerank_base_url is required/);
  });

  test("enabled + scores: the highest-scored doc lands first", async () => {
    const cfg = Object.freeze({
      ...BASE,
      enabled: true,
      baseUrl: "https://x/v1",
      model: "rerank-1",
      apiKey: "k",
    });
    const input = [result(1, "first"), result(2, "second"), result(3, "third")];
    // The heuristic order is [1, 2, 3]; the cross-encoder scores doc #3
    // (originally 3rd) highest, so it must land 1st.
    const provider = stubProvider((content) =>
      content === "third" ? 0.99 : content === "first" ? 0.5 : 0.1,
    );
    const out = await applyCrossEncoderRerank(input, "q", cfg, { provider });
    expect(out.map((r) => r.documentId)).toEqual([3, 1, 2]);
    // Every reranked hit gains the explainability reason.
    expect(out[0]!.reasons.some((r) => r.startsWith("cross_encoder: "))).toBe(true);
  });

  test("enabled + endpoint error: degrades to input and emits one telemetry event", async () => {
    const cfg = Object.freeze({
      ...BASE,
      enabled: true,
      baseUrl: "https://x/v1",
      model: "rerank-1",
      apiKey: "k",
    });
    const input = [result(1, "a"), result(2, "b")];
    const provider: RerankProvider = {
      name: "boom",
      model: "boom-1",
      async rerank() {
        throw new SearchError("RERANK_PROVIDER_HTTP", "rerank HTTP 503: unavailable");
      },
    };
    const events: RerankTelemetryEvent[] = [];
    const out = await applyCrossEncoderRerank(input, "q", cfg, {
      provider,
      onTelemetry: (e) => events.push(e),
    });
    expect(out.map((r) => r.documentId)).toEqual([1, 2]); // unchanged order
    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe("error");
    expect(events[0]!.reason).toMatch(/503/);
  });

  test("minScore floor: a below-floor doc sinks below qualifying ones but is kept", async () => {
    const cfg = Object.freeze({
      ...BASE,
      enabled: true,
      baseUrl: "https://x/v1",
      model: "rerank-1",
      apiKey: "k",
      minScore: 0.3,
    });
    const input = [result(1, "a"), result(2, "b"), result(3, "c")];
    // doc #1 below floor, #2 and #3 above; #3 highest.
    const provider = stubProvider((content) =>
      content === "a" ? 0.1 : content === "b" ? 0.4 : 0.9,
    );
    const out = await applyCrossEncoderRerank(input, "q", cfg, { provider });
    // qualifying sorted desc: [3, 2], then below-floor in original order: [1].
    expect(out.map((r) => r.documentId)).toEqual([3, 2, 1]);
  });

  test("only the top-K are re-scored; the tail keeps its order and text", async () => {
    const cfg = Object.freeze({
      ...BASE,
      enabled: true,
      baseUrl: "https://x/v1",
      model: "rerank-1",
      apiKey: "k",
      topK: 2,
    });
    const input = [result(1, "a"), result(2, "b"), result(3, "c"), result(4, "d")];
    // Reverse the top-2 by score; docs 3,4 are the untouched tail.
    const seenDocs: string[][] = [];
    const provider: RerankProvider = {
      name: "stub",
      model: "stub-1",
      async rerank(_q, documents) {
        seenDocs.push([...documents]);
        return documents.map((_d, i) => (i === 0 ? 0.1 : 0.9));
      },
    };
    const out = await applyCrossEncoderRerank(input, "q", cfg, { provider });
    expect(seenDocs[0]).toEqual(["a", "b"]); // only top-K handed to the model
    expect(out.map((r) => r.documentId)).toEqual([2, 1, 3, 4]);
    // Tail entries are untouched (no cross_encoder reason).
    expect(out[2]!.reasons.some((r) => r.startsWith("cross_encoder: "))).toBe(false);
  });

  test("empty input is a no-op even when enabled+configured", async () => {
    const cfg = Object.freeze({
      ...BASE,
      enabled: true,
      baseUrl: "https://x/v1",
      model: "rerank-1",
      apiKey: "k",
    });
    const out = await applyCrossEncoderRerank([], "q", cfg, { provider: stubProvider(() => 1) });
    expect(out).toEqual([]);
  });
});
