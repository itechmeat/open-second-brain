/**
 * OpenAI-compatible cross-encoder rerank provider HTTP shape
 * (retrieval-precision-quality-loop, card A / t_110867f5).
 *
 * Exercises the `/rerank` request/response contract with a stubbed
 * `fetch`, covering both the wrapped `{ results: [...] }` and the bare
 * array response shapes, index realignment, and provider-shaped errors.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { CrossEncoderRerankProvider } from "../../../src/core/search/rerank/cross-encoder.ts";
import { SearchError } from "../../../src/core/search/types.ts";

const ENDPOINT = Object.freeze({
  baseUrl: "https://api.example.com/v1",
  model: "rerank-1",
  apiKey: "secret",
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(handler: (url: string, init: RequestInit) => Response): void {
  globalThis.fetch = (async (url: string, init: RequestInit) =>
    handler(String(url), init)) as unknown as typeof fetch;
}

describe("CrossEncoderRerankProvider", () => {
  test("posts to {base}/rerank with model, query, documents and bearer auth", async () => {
    let seenUrl = "";
    let seenBody: Record<string, unknown> = {};
    let seenAuth = "";
    stubFetch((url, init) => {
      seenUrl = url;
      seenAuth = (init.headers as Record<string, string>)["authorization"] ?? "";
      seenBody = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({
          results: [
            { index: 0, relevance_score: 0.2 },
            { index: 1, relevance_score: 0.9 },
          ],
        }),
        { status: 200 },
      );
    });
    const provider = new CrossEncoderRerankProvider(ENDPOINT);
    const scores = await provider.rerank("hello", ["doc a", "doc b"]);
    expect(seenUrl).toBe("https://api.example.com/v1/rerank");
    expect(seenAuth).toBe("Bearer secret");
    expect(seenBody).toEqual({ model: "rerank-1", query: "hello", documents: ["doc a", "doc b"] });
    expect(scores).toEqual([0.2, 0.9]);
  });

  test("realigns out-of-order results back to input index order", async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            results: [
              { index: 2, relevance_score: 0.9 },
              { index: 0, relevance_score: 0.1 },
              { index: 1, relevance_score: 0.5 },
            ],
          }),
          { status: 200 },
        ),
    );
    const provider = new CrossEncoderRerankProvider(ENDPOINT);
    const scores = await provider.rerank("q", ["a", "b", "c"]);
    expect(scores).toEqual([0.1, 0.5, 0.9]);
  });

  test("accepts the bare array response shape with `score`", async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify([
            { index: 0, score: 0.7 },
            { index: 1, score: 0.3 },
          ]),
          { status: 200 },
        ),
    );
    const provider = new CrossEncoderRerankProvider(ENDPOINT);
    expect(await provider.rerank("q", ["a", "b"])).toEqual([0.7, 0.3]);
  });

  test("empty documents short-circuits without a request", async () => {
    let called = false;
    stubFetch(() => {
      called = true;
      return new Response("[]", { status: 200 });
    });
    const provider = new CrossEncoderRerankProvider(ENDPOINT);
    expect(await provider.rerank("q", [])).toEqual([]);
    expect(called).toBe(false);
  });

  test("non-2xx surfaces a RERANK_PROVIDER_HTTP error", async () => {
    stubFetch(() => new Response("upstream boom", { status: 503 }));
    const provider = new CrossEncoderRerankProvider(ENDPOINT);
    try {
      await provider.rerank("q", ["a"]);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(SearchError);
      expect((e as SearchError).code).toBe("RERANK_PROVIDER_HTTP");
      expect((e as SearchError).message).toMatch(/503/);
    }
  });

  test("a wrong-length response is rejected", async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 0.5 }] }), {
          status: 200,
        }),
    );
    const provider = new CrossEncoderRerankProvider(ENDPOINT);
    let thrown: unknown;
    try {
      await provider.rerank("q", ["a", "b"]);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SearchError);
  });
});
