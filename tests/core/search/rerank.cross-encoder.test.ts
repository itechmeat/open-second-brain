/**
 * OpenAI-compatible cross-encoder rerank provider HTTP shape
 * (retrieval-precision-quality-loop, card A / t_110867f5).
 *
 * Exercises the `/rerank` request/response contract against the shared
 * fake HTTP fixture, covering both the wrapped `{ results: [...] }` and
 * the bare array response shapes, index realignment, and provider-shaped
 * errors. Error shapes beyond the fixture's reach (raw-text bodies,
 * stream-level faults) live in rerank-failure.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { CrossEncoderRerankProvider } from "../../../src/core/search/rerank/cross-encoder.ts";
import { SearchError } from "../../../src/core/search/types.ts";
import { FAKE_PROVIDER_KEY } from "../../helpers/fake-credentials.ts";
import { startFakeHttp, type FakeHttp, type FakeRequest } from "../../helpers/fake-http.ts";

const MODEL = "rerank-1";

describe("CrossEncoderRerankProvider", () => {
  let server: FakeHttp;

  /** The endpoint under test, pointed at the per-test fixture. */
  function endpoint(): { baseUrl: string; model: string; apiKey: string } {
    return { baseUrl: server.url, model: MODEL, apiKey: FAKE_PROVIDER_KEY };
  }

  beforeEach(async () => {
    server = await startFakeHttp();
  });

  afterEach(async () => {
    await server.close();
  });

  test("posts to {base}/rerank with model, query, documents and bearer auth", async () => {
    let seen: FakeRequest | undefined;
    server.setHandler((req) => {
      seen = req;
      return {
        status: 200,
        body: {
          results: [
            { index: 0, relevance_score: 0.2 },
            { index: 1, relevance_score: 0.9 },
          ],
        },
      };
    });
    const provider = new CrossEncoderRerankProvider(endpoint());
    const scores = await provider.rerank("hello", ["doc a", "doc b"]);
    const req = seen!;
    expect(req.method).toBe("POST");
    expect(req.path).toBe(`${new URL(server.url).pathname}/rerank`);
    expect(req.headers["authorization"]).toBe(`Bearer ${FAKE_PROVIDER_KEY}`);
    expect(req.body).toEqual({ model: MODEL, query: "hello", documents: ["doc a", "doc b"] });
    expect(scores).toEqual([0.2, 0.9]);
  });

  test("realigns out-of-order results back to input index order", async () => {
    server.setHandler(() => ({
      status: 200,
      body: {
        results: [
          { index: 2, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.1 },
          { index: 1, relevance_score: 0.5 },
        ],
      },
    }));
    const provider = new CrossEncoderRerankProvider(endpoint());
    const scores = await provider.rerank("q", ["a", "b", "c"]);
    expect(scores).toEqual([0.1, 0.5, 0.9]);
  });

  test("rides the default /rerank route without a per-test handler", async () => {
    // No setHandler: the fixture's default overlap scores flow through the
    // provider's wrapped-shape parser and come back realigned to one
    // score per input document, whatever order the route answered in.
    const provider = new CrossEncoderRerankProvider(endpoint());
    expect(await provider.rerank("fox", ["a fox here", "nothing relevant"])).toEqual([0.5, 0]);
  });

  test("accepts the bare array response shape with `score`", async () => {
    server.setHandler(() => ({
      status: 200,
      body: [
        { index: 0, score: 0.7 },
        { index: 1, score: 0.3 },
      ],
    }));
    const provider = new CrossEncoderRerankProvider(endpoint());
    expect(await provider.rerank("q", ["a", "b"])).toEqual([0.7, 0.3]);
  });

  test("empty documents short-circuits without a request", async () => {
    const provider = new CrossEncoderRerankProvider(endpoint());
    expect(await provider.rerank("q", [])).toEqual([]);
    expect(server.callCount()).toBe(0);
  });

  test("non-2xx surfaces a RERANK_PROVIDER_HTTP error", async () => {
    server.setHandler(() => ({ status: 503, body: { error: "upstream boom" } }));
    const provider = new CrossEncoderRerankProvider(endpoint());
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
    server.setHandler(() => ({
      status: 200,
      body: { results: [{ index: 0, relevance_score: 0.5 }] },
    }));
    const provider = new CrossEncoderRerankProvider(endpoint());
    let thrown: unknown;
    try {
      await provider.rerank("q", ["a", "b"]);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SearchError);
  });
});
