/**
 * The fake HTTP server's own contract: a handler that throws or rejects
 * answers 500 with its message, so a test fails on the real error rather
 * than timing out on a request nobody answers.
 */

import { afterEach, expect, test } from "bun:test";

import { startFakeHttp, type FakeHttp } from "./fake-http.ts";

let server: FakeHttp | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
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
