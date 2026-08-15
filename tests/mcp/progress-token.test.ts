/**
 * `_meta.progressToken` at the MCP boundary (nothing-runs-unwatched, U2).
 *
 * Before this unit `handleToolsCall` read exactly two keys from `params`
 * - `name` and `arguments` - so a client's progress token was accepted by
 * the wire and then discarded without a word. These tests pin the three
 * facts that replace that silence:
 *
 *   - stdio, which can write an unsolicited frame, carries the token as
 *     `notifications/progress` frames emitted BEFORE the response frame;
 *   - HTTP, which writes one response and closes, refuses the token by
 *     name rather than accepting it and dropping the events;
 *   - a call with no token is byte-identical to the call the previous
 *     release made, which is what makes the feature additive.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import {
  JSONRPC_VERSION,
  MCPServer,
  PROTOCOL_VERSION,
  serveStdio,
  serveStdioFromString,
  startHttp,
} from "../../src/mcp/index.ts";
import { PROGRESS_META_KEY, PROGRESS_NOTIFICATION_METHOD } from "../../src/mcp/progress.ts";
import { PROGRESS_KIND, PROGRESS_REASON, PROGRESS_SCHEMA } from "../../src/core/brain/progress.ts";
import { bootstrapBrain } from "../../src/core/brain/init.ts";

interface JsonObject {
  readonly [key: string]: any;
}

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-mcp-progress-"));
  bootstrapBrain(vault);
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

const INITIALIZE = {
  jsonrpc: JSONRPC_VERSION,
  id: 1,
  method: "initialize",
  params: { protocolVersion: PROTOCOL_VERSION },
};

/** A `tools/call` for the one tool wired to the progress spine today. */
function dreamCall(id: number, token?: string | number): JsonObject {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    method: "tools/call",
    params: {
      name: "brain_dream",
      arguments: { dry_run: true },
      ...(token === undefined ? {} : { _meta: { progressToken: token } }),
    },
  };
}

/**
 * One response frame with the two members a rerun cannot reproduce
 * removed: `run_id` is derived from the wall clock, and `content` is that
 * same structured payload rendered, so it carries the id a second time.
 */
function stripRunId(frame: JsonObject | undefined): string {
  const clone = JSON.parse(JSON.stringify(frame)) as Record<string, any>;
  delete clone["result"]["content"];
  delete clone["result"]["structuredContent"]["run_id"];
  return JSON.stringify(clone);
}

function lines(out: string): JsonObject[] {
  return out
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as JsonObject);
}

describe("stdio carries a progress token", () => {
  test("a valid token yields progress frames before the response frame", async () => {
    const input = JSON.stringify(INITIALIZE) + "\n" + JSON.stringify(dreamCall(2, "tok-42")) + "\n";
    const frames = lines(await serveStdioFromString({ vault }, input));

    const responseIndex = frames.findIndex((f) => f["id"] === 2);
    expect(responseIndex).toBeGreaterThan(-1);
    const notifications = frames.filter((f) => f["method"] === PROGRESS_NOTIFICATION_METHOD);
    expect(notifications.length).toBeGreaterThan(0);

    // Every notification precedes the response it belongs to.
    for (const n of notifications) expect(frames.indexOf(n)).toBeLessThan(responseIndex);

    const first = notifications[0]!;
    expect(first["jsonrpc"]).toBe(JSONRPC_VERSION);
    expect(first["id"]).toBeUndefined();
    const params = first["params"] as JsonObject;
    expect(params["progressToken"]).toBe("tok-42");
    expect(typeof params["progress"]).toBe("number");
    const event = (params["_meta"] as JsonObject)[PROGRESS_META_KEY] as JsonObject;
    expect(event["schema"]).toBe(PROGRESS_SCHEMA);
    expect(event["operation"]).toBe("dream");
    expect(event["kind"]).toBe(PROGRESS_KIND.started);
    expect(typeof event["stage"]).toBe("string");
  });

  test("an integer token is accepted and echoed back unchanged", async () => {
    const input = JSON.stringify(INITIALIZE) + "\n" + JSON.stringify(dreamCall(2, 7)) + "\n";
    const frames = lines(await serveStdioFromString({ vault }, input));
    const notifications = frames.filter((f) => f["method"] === PROGRESS_NOTIFICATION_METHOD);
    expect(notifications.length).toBeGreaterThan(0);
    expect((notifications[0]!["params"] as JsonObject)["progressToken"]).toBe(7);
  });

  test("the response frame is identical with and without a token", async () => {
    const withToken = lines(
      await serveStdioFromString(
        { vault },
        JSON.stringify(INITIALIZE) + "\n" + JSON.stringify(dreamCall(2, "tok")) + "\n",
      ),
    ).find((f) => f["id"] === 2);
    const without = lines(
      await serveStdioFromString(
        { vault },
        JSON.stringify(INITIALIZE) + "\n" + JSON.stringify(dreamCall(2)) + "\n",
      ),
    ).find((f) => f["id"] === 2);

    expect(stripRunId(withToken)).toBe(stripRunId(without));
  });

  test("no token produces no notification frames at all", async () => {
    const frames = lines(
      await serveStdioFromString(
        { vault },
        JSON.stringify(INITIALIZE) + "\n" + JSON.stringify(dreamCall(2)) + "\n",
      ),
    );
    expect(frames.filter((f) => f["method"] !== undefined)).toEqual([]);
    expect(frames.every((f) => f["id"] !== undefined)).toBe(true);
  });

  test("a progress frame never interleaves inside a response frame on a real stream", async () => {
    const stdin = new PassThrough();
    const chunks: string[] = [];
    const stdout = new PassThrough();
    stdout.on("data", (c: Buffer) => chunks.push(c.toString("utf8")));

    const done = serveStdio({ vault }, { stdin, stdout });
    stdin.write(JSON.stringify(INITIALIZE) + "\n");
    stdin.write(JSON.stringify(dreamCall(2, "tok")) + "\n");
    stdin.end();
    await done;

    // Every write is exactly one newline-terminated frame: joining the
    // chunks and splitting on "\n" must parse cleanly, and the last
    // progress frame must precede the response.
    const frames = lines(chunks.join(""));
    const responseIndex = frames.findIndex((f) => f["id"] === 2);
    const progressIndexes = frames
      .map((f, i) => (f["method"] === PROGRESS_NOTIFICATION_METHOD ? i : -1))
      .filter((i) => i !== -1);
    expect(progressIndexes.length).toBeGreaterThan(0);
    expect(Math.max(...progressIndexes)).toBeLessThan(responseIndex);
    for (const chunk of chunks) expect(chunk.endsWith("\n")).toBe(true);
  });
});

describe("a malformed progress token is refused by name", () => {
  const server = (): MCPServer => new MCPServer({ vault });

  test.each([
    [true, "boolean"],
    [null, "null"],
    [{}, "object"],
    [[], "array"],
    [1.5, "fractional"],
  ] as ReadonlyArray<readonly [unknown, string]>)(
    "%p is refused naming what was wrong",
    async (token, expected) => {
      const res = await server().handleRequest({
        jsonrpc: JSONRPC_VERSION,
        id: 3,
        method: "tools/call",
        params: { name: "brain_dream", arguments: {}, _meta: { progressToken: token } },
      });
      expect(res?.error?.code).toBe(-32602);
      expect(res?.error?.message).toContain("_meta.progressToken");
      expect(res?.error?.message).toContain(expected);
    },
  );

  test("a non-object _meta is refused naming _meta", async () => {
    const res = await server().handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 4,
      method: "tools/call",
      params: { name: "brain_dream", arguments: {}, _meta: "nope" },
    });
    expect(res?.error?.code).toBe(-32602);
    expect(res?.error?.message).toContain("_meta");
  });

  test("a _meta without a progressToken is not a token and not an error", async () => {
    const res = await server().handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 5,
      method: "tools/call",
      params: { name: "brain_dream", arguments: { dry_run: true }, _meta: { other: 1 } },
    });
    expect(res?.error).toBeUndefined();
    const result = res?.result as JsonObject | undefined;
    expect(result?.["_meta"]).toBeUndefined();
  });
});

describe("HTTP refuses a progress token by name", () => {
  test("the refusal rides on result._meta and no progress frames are sent", async () => {
    const handle = await startHttp({ vault }, { host: "127.0.0.1", port: 0 });
    try {
      const res = await fetch(handle.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(dreamCall(2, "tok-http")),
      });
      const body = (await res.json()) as JsonObject;
      const refusal = (body["result"]["_meta"] as JsonObject)[PROGRESS_META_KEY] as JsonObject;
      expect(refusal["schema"]).toBe(PROGRESS_SCHEMA);
      expect(refusal["kind"]).toBe(PROGRESS_KIND.refused);
      expect(refusal["reason"]).toBe(PROGRESS_REASON.transportSingleResponse);
      expect(refusal["progressToken"]).toBe("tok-http");
      // One response, no notification frames anywhere in the body.
      expect(JSON.stringify(body)).not.toContain(PROGRESS_NOTIFICATION_METHOD);
    } finally {
      await handle.close();
    }
  });

  test("a call with no token carries no _meta at all", async () => {
    const handle = await startHttp({ vault }, { host: "127.0.0.1", port: 0 });
    try {
      const res = await fetch(handle.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(dreamCall(2)),
      });
      const body = (await res.json()) as JsonObject;
      expect(body["result"]["_meta"]).toBeUndefined();
    } finally {
      await handle.close();
    }
  });
});
