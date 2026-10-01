/**
 * The typed rerank failure category: why a cross-encoder request failed,
 * as a closed vocabulary computed from typed errors and HTTP statuses,
 * never from the provider's message text.
 *
 * The provider's thrown errors keep their `RERANK_PROVIDER_HTTP` code and
 * their exact messages, so the `rerank_degraded:` warning stays the same
 * text; the category travels beside it on the telemetry event.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  RERANK_FAILURE_CATEGORIES,
  RERANK_FAILURE_CATEGORY,
  RerankEndpointError,
  rerankCategoryForStatus,
} from "../../../src/core/search/rerank/failure.ts";
import { CrossEncoderRerankProvider } from "../../../src/core/search/rerank/cross-encoder.ts";
import {
  applyCrossEncoderRerank,
  type RerankTelemetryEvent,
} from "../../../src/core/search/rerank/index.ts";
import type { RerankProvider } from "../../../src/core/search/rerank/contract.ts";
import { SearchError } from "../../../src/core/search/types.ts";
import type { BrainSearchResult, ResolvedRerankConfig } from "../../../src/core/search/types.ts";
import { FAKE_PROVIDER_KEY } from "../../helpers/fake-credentials.ts";
import { startFakeHttp, type FakeHttp } from "../../helpers/fake-http.ts";

const SHORT_TIMEOUT_MS = 50;
const SLOW_ANSWER_MS = 400;
const API_KEY = FAKE_PROVIDER_KEY;

function result(id: number): BrainSearchResult {
  return Object.freeze({
    documentId: id,
    chunkId: id,
    path: `note-${id}.md`,
    title: `Note ${id}`,
    content: `content ${id}`,
    startLine: 1,
    endLine: 2,
    score: 1 - id * 0.1,
    keywordScore: 0.5,
    semanticScore: 0.5,
    linkBoost: 0,
    recencyBoost: 0,
    searchType: "hybrid" as const,
    reasons: Object.freeze(["fts5_bm25: 0.500"]),
  });
}

const RESULTS = Object.freeze([result(1), result(2)]);

function enabledConfig(baseUrl: string): ResolvedRerankConfig {
  return Object.freeze({
    enabled: true,
    kind: "openai-compat",
    baseUrl,
    model: "rerank-test",
    envKey: null,
    apiKey: API_KEY,
    topK: 20,
    minScore: 0,
  });
}

async function runAgainst(
  baseUrl: string,
  timeoutMs?: number,
): Promise<ReadonlyArray<RerankTelemetryEvent>> {
  const events: RerankTelemetryEvent[] = [];
  const out = await applyCrossEncoderRerank(RESULTS, "q", enabledConfig(baseUrl), {
    onTelemetry: (e) => events.push(e),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
  // Every failure degrades to the heuristic order.
  expect(out).toBe(RESULTS);
  return events;
}

async function thrownBy(baseUrl: string, timeoutMs?: number): Promise<unknown> {
  const provider = new CrossEncoderRerankProvider(
    { baseUrl, model: "rerank-test", apiKey: API_KEY },
    timeoutMs !== undefined ? { timeoutMs } : undefined,
  );
  try {
    await provider.rerank("q", ["a", "b"]);
  } catch (e) {
    return e;
  }
  throw new Error("expected the provider to throw");
}

function expectEndpointError(err: unknown, category: string, message: RegExp | string): void {
  expect(err).toBeInstanceOf(RerankEndpointError);
  const typed = err as RerankEndpointError;
  expect(typed.code).toBe("RERANK_PROVIDER_HTTP");
  expect(typed.category).toBe(category as RerankEndpointError["category"]);
  if (typeof message === "string") expect(typed.message).toBe(message);
  else expect(typed.message).toMatch(message);
}

describe("RERANK_FAILURE_CATEGORY vocabulary", () => {
  // Frozen object, membership list and guard are the census's to check;
  // this pins the members, which ride `detail.category` on the wire.
  test("names exactly the nine wire categories", () => {
    expect(RERANK_FAILURE_CATEGORIES.toSorted()).toEqual([
      "auth",
      "gone",
      "malformed",
      "network",
      "quota",
      "rejected",
      "timeout",
      "transient",
      "unclassified",
    ]);
  });
});

describe("rerankCategoryForStatus", () => {
  test.each([
    [401, "auth"],
    [403, "auth"],
    [402, "quota"],
    [404, "gone"],
    [410, "gone"],
    [408, "transient"],
    [429, "transient"],
    [500, "transient"],
    [502, "transient"],
    [503, "transient"],
    [599, "transient"],
    [400, "rejected"],
    [413, "rejected"],
    [422, "rejected"],
  ] as const)("HTTP %d is %s", (status, category) => {
    expect(rerankCategoryForStatus(status)).toBe(category);
  });
});

describe("RerankEndpointError", () => {
  test("is a SearchError with the unchanged RERANK_PROVIDER_HTTP code", () => {
    const err = new RerankEndpointError("rerank HTTP 503: down", {
      category: RERANK_FAILURE_CATEGORY.transient,
      status: 503,
    });
    expect(err).toBeInstanceOf(SearchError);
    expect(err.code).toBe("RERANK_PROVIDER_HTTP");
    expect(err.message).toBe("rerank HTTP 503: down");
    expect(err.category).toBe("transient");
    expect(err.status).toBe(503);
  });
});

/** A loopback endpoint that sends 200 headers, then never finishes the body. */
function stalledBodyServer(): { url: string; stop: () => Promise<void> } {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"results":['));
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });
  return { url: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) };
}

/** Settles with `p`, or with "unbounded" when `p` outlives a bounded wait. */
function bounded<T>(p: Promise<T>): Promise<T | "unbounded"> {
  return Promise.race([p, Bun.sleep(2_000).then(() => "unbounded" as const)]);
}

describe("the category reaches the telemetry event", () => {
  let fake: FakeHttp;
  beforeEach(async () => {
    fake = await startFakeHttp();
  });
  afterEach(async () => {
    await fake.close();
  });

  test("HTTP 503 is transient and keeps its v1.65.0 message", async () => {
    fake.setHandler(() => ({ status: 503, body: { error: "down" } }));
    const events = await runAgainst(fake.url);
    expect(events).toEqual([
      {
        status: "error",
        category: "transient",
        reason: 'rerank HTTP 503: {"error":"down"}',
        candidateCount: 2,
      },
    ]);
    const err = await thrownBy(fake.url);
    expectEndpointError(err, "transient", 'rerank HTTP 503: {"error":"down"}');
    expect((err as RerankEndpointError).status).toBe(503);
  });

  test("HTTP 401 is auth and HTTP 410 is gone", async () => {
    fake.setHandler(() => ({ status: 401, body: { error: "no" } }));
    expect((await runAgainst(fake.url))[0]).toMatchObject({ status: "error", category: "auth" });
    fake.setHandler(() => ({ status: 410, body: { error: "retired" } }));
    expect((await runAgainst(fake.url))[0]).toMatchObject({ status: "error", category: "gone" });
  });

  test("an endpoint that outlives the timeout is timeout", async () => {
    fake.setHandler(() => ({ status: 200, body: [], delayMs: SLOW_ANSWER_MS }));
    const events = await runAgainst(fake.url, SHORT_TIMEOUT_MS);
    expect(events[0]).toMatchObject({ status: "error", category: "timeout" });
    expectEndpointError(
      await thrownBy(fake.url, SHORT_TIMEOUT_MS),
      "timeout",
      `rerank request timed out after ${SHORT_TIMEOUT_MS}ms`,
    );
  });

  test("a timed-out fetch rejected under another error name is still timeout", async () => {
    // Runtimes differ in the name of the error an aborted fetch rejects
    // with; the category follows the request's own abort state, not it.
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("the operation timed out", "TimeoutError")),
        );
      })) as unknown as typeof fetch;
    try {
      expectEndpointError(
        await thrownBy(fake.url, SHORT_TIMEOUT_MS),
        "timeout",
        `rerank request timed out after ${SHORT_TIMEOUT_MS}ms`,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("a refused connection is network", async () => {
    const dead = await startFakeHttp();
    const deadUrl = dead.url;
    await dead.close();
    const events = await runAgainst(deadUrl);
    expect(events[0]).toMatchObject({ status: "error", category: "network" });
    expectEndpointError(await thrownBy(deadUrl), "network", /^network error: /);
  });

  test("a non-JSON body is malformed", async () => {
    // The fake server JSON-encodes every body, so this one answer is
    // stubbed at the fetch seam instead.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("<html>not json</html>", { status: 200 })) as unknown as typeof fetch;
    try {
      expect((await runAgainst(fake.url))[0]).toMatchObject({
        status: "error",
        category: "malformed",
      });
      expectEndpointError(
        await thrownBy(fake.url),
        "malformed",
        "rerank response not JSON: Failed to parse JSON",
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("a 2xx body that breaks while it is read is network, not malformed", async () => {
    // The connection dropped mid-body: nothing is wrong with the body's
    // shape, so the category points at the path, not at the endpoint.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"results":['));
          controller.error(new Error("connection reset"));
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    try {
      expectEndpointError(await thrownBy(fake.url), "network", /^network error: /);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("a 2xx body that stalls is timeout, within the per-request timeout", async () => {
    const stalled = stalledBodyServer();
    try {
      expectEndpointError(
        await bounded(thrownBy(stalled.url, SHORT_TIMEOUT_MS)),
        "timeout",
        `rerank request timed out after ${SHORT_TIMEOUT_MS}ms`,
      );
    } finally {
      await stalled.stop();
    }
  });

  test("a caller abort during a stalled body throws the caller's reason", async () => {
    const stalled = stalledBodyServer();
    const caller = new AbortController();
    const reason = new Error("caller cancelled");
    const provider = new CrossEncoderRerankProvider(
      { baseUrl: stalled.url, model: "rerank-test", apiKey: API_KEY },
      { timeoutMs: 60_000 },
    );
    try {
      setTimeout(() => caller.abort(reason), SHORT_TIMEOUT_MS);
      const outcome = await bounded(
        provider.rerank("q", ["a", "b"], { signal: caller.signal }).then(
          () => "resolved",
          (e: unknown) => e,
        ),
      );
      expect(outcome).toBe(reason);
    } finally {
      await stalled.stop();
    }
  });

  test("a wrong score count is malformed", async () => {
    fake.setHandler(() => ({ status: 200, body: { results: [{ index: 0, relevance_score: 1 }] } }));
    expect((await runAgainst(fake.url))[0]).toMatchObject({
      status: "error",
      category: "malformed",
    });
    expectEndpointError(
      await thrownBy(fake.url),
      "malformed",
      "rerank response shape: expected 2 scores, got 1",
    );
  });

  test("a duplicate index is malformed", async () => {
    fake.setHandler(() => ({
      status: 200,
      body: {
        results: [
          { index: 0, relevance_score: 1 },
          { index: 0, relevance_score: 0.5 },
        ],
      },
    }));
    expect((await runAgainst(fake.url))[0]).toMatchObject({
      status: "error",
      category: "malformed",
    });
    expectEndpointError(
      await thrownBy(fake.url),
      "malformed",
      "rerank response: duplicate index 0",
    );
  });

  test("an unwrapped object body and a missing score are malformed", async () => {
    fake.setHandler(() => ({ status: 200, body: { nope: true } }));
    expectEndpointError(
      await thrownBy(fake.url),
      "malformed",
      "rerank response shape: expected an array or a { results: [...] } object",
    );
    fake.setHandler(() => ({ status: 200, body: [{ index: 0 }, { index: 1, score: 1 }] }));
    expectEndpointError(
      await thrownBy(fake.url),
      "malformed",
      "rerank response: item at index 0 has no finite relevance score",
    );
  });
});

describe("failures outside the cross-encoder", () => {
  const cfg = enabledConfig("https://rerank.example.test/v1");

  async function eventsFor(provider: RerankProvider): Promise<RerankTelemetryEvent[]> {
    const events: RerankTelemetryEvent[] = [];
    const out = await applyCrossEncoderRerank(RESULTS, "q", cfg, {
      provider,
      onTelemetry: (e) => events.push(e),
    });
    expect(out).toBe(RESULTS);
    return events;
  }

  test("a provider throwing a plain Error is unclassified, named rather than hidden", async () => {
    const events = await eventsFor({
      name: "plain",
      model: "plain-1",
      async rerank() {
        throw new Error("something odd");
      },
    });
    expect(events).toEqual([
      { status: "error", category: "unclassified", reason: "something odd", candidateCount: 2 },
    ]);
  });

  test("a provider returning the wrong number of scores is malformed", async () => {
    const events = await eventsFor({
      name: "short",
      model: "short-1",
      async rerank() {
        return [1];
      },
    });
    expect(events).toEqual([
      {
        status: "error",
        category: "malformed",
        reason: "expected 2 scores, got 1",
        candidateCount: 2,
      },
    ]);
  });

  test("a success event carries no category", async () => {
    const events: RerankTelemetryEvent[] = [];
    await applyCrossEncoderRerank(RESULTS, "q", cfg, {
      provider: { name: "ok", model: "ok-1", rerank: async (_q, docs) => docs.map(() => 1) },
      onTelemetry: (e) => events.push(e),
    });
    expect(events).toEqual([{ status: "applied", candidateCount: 2 }]);
  });
});
