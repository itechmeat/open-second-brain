/**
 * The fake HTTP server's own contract: a handler that throws or rejects
 * answers 500 with its message, so a test fails on the real error rather
 * than timing out on a request nobody answers. The default handler's
 * `/rerank` route contract is pinned here too: deterministic scores, one
 * per document, answered in score order like the real providers, with
 * malformed bodies failing visibly.
 */

import { afterEach, expect, test } from "bun:test";

import { startFakeHttp, type FakeHttp } from "./fake-http.ts";

let server: FakeHttp | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

function postJson(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const RERANK_REQUEST = Object.freeze({
  model: "rerank-1",
  query: "fox runs",
  documents: Object.freeze(["a fox here", "nothing relevant", "fox runs far"]),
});

test("a rejecting handler answers 500 with the error message", async () => {
  server = await startFakeHttp();
  server.setHandler(async () => {
    throw new Error("handler exploded");
  });
  const res = await fetch(`${server.url}/embeddings`, { method: "POST" });
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ error: "handler exploded" });
});

test("a synchronously throwing handler answers the same way", async () => {
  server = await startFakeHttp();
  server.setHandler(() => {
    throw new Error("sync failure");
  });
  const res = await fetch(`${server.url}/embeddings`, { method: "POST" });
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ error: "sync failure" });
});

test("the default handler answers POST /rerank with one deterministic score per document", async () => {
  server = await startFakeHttp();
  const base = server.url;
  const res = await postJson(base, "/rerank", RERANK_REQUEST);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    model: string;
    results: { index: number; relevance_score: number }[];
  };
  expect(body.model).toBe("rerank-1");
  // One item per document, in SCORE order: the default route sorts by
  // relevance_score descending, stable on index, the way real providers
  // answer, and the rerank client realigns the items through their own
  // `index`. "fox runs far" shares two query tokens (2/3), "a fox here"
  // one (1/2), "nothing relevant" none (0).
  expect(body.results.map((r) => r.index)).toEqual([2, 0, 1]);
  expect(body.results.map((r) => r.relevance_score)).toEqual([2 / 3, 0.5, 0]);
  // The same request answers byte-identically: no randomness, no clock.
  const replay = await postJson(base, "/rerank", RERANK_REQUEST);
  expect(replay.status).toBe(200);
  expect(await replay.text()).toBe(JSON.stringify(body));
});

test("malformed /rerank bodies fail visibly instead of scoring", async () => {
  server = await startFakeHttp();
  const base = server.url;
  // No documents key.
  expect((await postJson(base, "/rerank", { model: "m", query: "q" })).status).toBe(400);
  // documents is not an array.
  expect((await postJson(base, "/rerank", { query: "q", documents: "a fox" })).status).toBe(400);
  // A document entry that is not a string.
  expect((await postJson(base, "/rerank", { query: "q", documents: ["a", 3] })).status).toBe(400);
  // No query key.
  expect((await postJson(base, "/rerank", { model: "m", documents: ["a"] })).status).toBe(400);
  // An empty document list is well-formed and scores nothing (the client
  // short-circuits before sending; this is defensive).
  const empty = await postJson(base, "/rerank", { model: "m", query: "q", documents: [] });
  expect(empty.status).toBe(200);
  expect(await empty.json()).toEqual({ results: [], model: "m" });
});

test("GET /rerank is not routed by the default handler", async () => {
  server = await startFakeHttp();
  const res = await fetch(`${server.url}/rerank`);
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "not_found" });
});

test("the /embeddings default route is unchanged by the /rerank route", async () => {
  server = await startFakeHttp();
  const res = await postJson(server.url, "/embeddings", { input: ["a b c"], model: "emb-1" });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    model: string;
    data: { index: number; embedding: number[] }[];
  };
  expect(body.model).toBe("emb-1");
  expect(body.data[0]?.index).toBe(0);
  expect(body.data[0]?.embedding).toEqual([3, 0, 5, 1]);
});
