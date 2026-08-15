/**
 * `_meta.progressToken` at the MCP boundary (nothing-runs-unwatched, U2).
 *
 * Before this unit `handleToolsCall` read exactly two keys from `params`
 * - `name` and `arguments` - so a client's progress token was accepted by
 * the wire and then discarded without a word. These tests pin the four
 * facts that replace that silence:
 *
 *   - stdio, which can write an unsolicited frame, carries the token as
 *     `notifications/progress` frames emitted BEFORE the response frame;
 *   - HTTP, which writes one response and closes, refuses the token by
 *     name rather than accepting it and dropping the events;
 *   - a call with no token is byte-identical to the call the previous
 *     release made, which is what makes the feature additive;
 *   - a tool that dispatches on a `view` argument hands the sink to the
 *     view it dispatched to, rather than dropping it one link short of
 *     the pass that had something to report.
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
import {
  isProgressKind,
  PROGRESS_KIND,
  PROGRESS_REASON,
  PROGRESS_SCHEMA,
} from "../../src/core/brain/progress.ts";
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
 * One response frame with the only member a rerun cannot reproduce
 * NORMALISED rather than removed.
 *
 * `run_id` is derived from the wall clock, and it appears twice: once in
 * `structuredContent` and again inside `content`, which is that same
 * payload rendered. So the id is replaced wherever it occurs and every
 * other byte of both members is still compared.
 *
 * The earlier form deleted `content` outright, and deleting it excused
 * the entire rendered payload an MCP client displays: an independent
 * review replaced that array wholesale whenever a progress token was
 * present and this file stayed green. A frame with no run id to
 * normalise is a defect in the response, not a frame to compare loosely,
 * so it throws.
 */
function normalizeRunId(frame: JsonObject | undefined): string {
  const runId = (frame?.["result"] as JsonObject | undefined)?.["structuredContent"]?.["run_id"];
  if (typeof runId !== "string" || runId.length === 0) {
    throw new TypeError(`response frame carries no run_id to normalise: ${JSON.stringify(frame)}`);
  }
  return JSON.stringify(frame).split(runId).join("<run-id>");
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

    // The rendered payload is what a client displays, so the comparison
    // is worthless if both frames happen to carry nothing there.
    const content = (withToken?.["result"] as JsonObject | undefined)?.["content"] as
      | ReadonlyArray<JsonObject>
      | undefined;
    expect(content?.length).toBeGreaterThan(0);
    expect(normalizeRunId(withToken)).toBe(normalizeRunId(without));
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

/**
 * The view dispatcher, from the outside.
 *
 * `dispatchByView` routes a consolidated tool's `view` argument to its
 * per-view handler, and it used to call `handler(ctx, args)` - dropping
 * the sink on the floor. Restoring that one-line defect left the whole
 * of `tests/mcp` plus the progress suites at 882 pass / 0 fail, because
 * no test sent a progress token through a dispatched tool. This block
 * is that test: `brain_brief view=operator` is the consumer that made
 * the fix necessary, since it runs a dry-run consolidation pass and is
 * the slow half of an operator summary on a large vault.
 */
describe("a dispatched view carries the sink", () => {
  function briefCall(id: number, token?: string): JsonObject {
    return {
      jsonrpc: JSONRPC_VERSION,
      id,
      method: "tools/call",
      params: {
        name: "brain_brief",
        arguments: { view: "operator" },
        ...(token === undefined ? {} : { _meta: { progressToken: token } }),
      },
    };
  }

  test("brain_brief view=operator emits progress frames for its dream pass", async () => {
    const frames = lines(
      await serveStdioFromString(
        { vault },
        JSON.stringify(INITIALIZE) + "\n" + JSON.stringify(briefCall(2, "tok-brief")) + "\n",
      ),
    );
    const responseIndex = frames.findIndex((f) => f["id"] === 2);
    expect(responseIndex).toBeGreaterThan(-1);
    expect(frames[responseIndex]?.["error"]).toBeUndefined();

    const notifications = frames.filter((f) => f["method"] === PROGRESS_NOTIFICATION_METHOD);
    // The assertion the dropped sink fails: a dispatcher that swallows it
    // produces a response and no frames at all, which is exactly what a
    // hung run looks like.
    expect(notifications.length).toBeGreaterThan(0);
    for (const n of notifications) expect(frames.indexOf(n)).toBeLessThan(responseIndex);

    const params = notifications[0]!["params"] as JsonObject;
    expect(params["progressToken"]).toBe("tok-brief");
    const event = (params["_meta"] as JsonObject)[PROGRESS_META_KEY] as JsonObject;
    expect(event["schema"]).toBe(PROGRESS_SCHEMA);
    // The operation naming the pass the sink reached, not merely "some
    // frames arrived": the dispatcher's job is to hand the sink to the
    // handler that runs the long half.
    expect(event["operation"]).toBe("dream");
    expect(isProgressKind(event["kind"])).toBe(true);
  });

  test("the same view with no token emits nothing", async () => {
    // The negative control for the test above: the frames it counts are
    // caused by the token, not by the tool being noisy.
    const frames = lines(
      await serveStdioFromString(
        { vault },
        JSON.stringify(INITIALIZE) + "\n" + JSON.stringify(briefCall(2)) + "\n",
      ),
    );
    expect(frames.filter((f) => f["method"] !== undefined)).toEqual([]);
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
