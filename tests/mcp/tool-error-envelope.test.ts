/**
 * Every MCP error answer carries a stable code, on both channels.
 *
 * Channel A is the JSON-RPC error: `error.data.code`, defaulted inside the
 * single builder `errorResponse` from the numeric JSON-RPC code, a
 * thrower-supplied code always winning. Channel B is the `isError` tool
 * result: `_meta["open-second-brain/error"] = { schema, code }`, with the
 * text body byte-identical to the previous release and no
 * `structuredContent`, because strict clients validate that against the
 * tool's output schema even on an error.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SafeguardTimeoutError } from "../../src/core/brain/safeguard.ts";
import { PROGRESS_META_KEY } from "../../src/mcp/progress.ts";
import {
  INVALID_PARAMS,
  JSONRPC_VERSION,
  MCPError,
  MCPErrorDataArrayError,
} from "../../src/mcp/protocol.ts";
import { MCPServer } from "../../src/mcp/server.ts";
import { serveStdioFromString } from "../../src/mcp/stdio.ts";
import { TOOL_ERROR_META_KEY, TOOL_ERROR_SCHEMA } from "../../src/mcp/tool-error-codes.ts";
import { readRpcErrorCode, readToolErrorCode } from "../helpers/tool-error-envelope.ts";

type JsonObject = Record<string, any>;

const UNCLASSIFIED_LINE = "warning: unclassified tool error mapped to internal_error: Error\n";
const TOOL = "envelope_probe";
/** The prefix, a code capped at 120 characters, and the newline. */
const UNREGISTERED_LINE_MAX = "warning: unregistered error code on the wire: ".length + 120 + 1;

let tmp: string;
let stderr: Mock<typeof process.stderr.write>;
let lines: string[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-envelope-"));
  lines = [];
  stderr = spyOn(process.stderr, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  stderr.mockRestore();
  rmSync(tmp, { recursive: true, force: true });
});

/** A server whose whole tool table is one probe running `handler`. */
function serverWith(handler: () => unknown): MCPServer {
  const server = new MCPServer({ vault: tmp });
  (server as any).tools = [
    {
      name: TOOL,
      description: "test tool",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler,
    },
  ];
  return server;
}

async function call(server: MCPServer, meta?: JsonObject): Promise<JsonObject> {
  const res = await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 7,
    method: "tools/call",
    params: { name: TOOL, arguments: {}, ...(meta === undefined ? {} : { _meta: meta }) },
  });
  return res as JsonObject;
}

describe("channel A: error.data.code on every JSON-RPC error", () => {
  test("an unknown method answers method_not_found", async () => {
    const res = (await new MCPServer({ vault: tmp }).handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      method: "no/such/method",
    })) as JsonObject;
    expect(res["error"]["code"]).toBe(-32601);
    expect(res["error"]["message"]).toBe("unknown method: no/such/method");
    expect(res["error"]["data"]).toEqual({ code: "method_not_found" });
  });

  test("an MCPError with no data gains the default code, message unchanged", async () => {
    const res = await call(
      serverWith(() => {
        throw new MCPError(INVALID_PARAMS, "limit must be positive");
      }),
    );
    expect(res["error"]["code"]).toBe(INVALID_PARAMS);
    expect(readRpcErrorCode(res)).toBe("invalid_params");
    expect(res["error"]["message"]).toBe("limit must be positive");
    expect(res["error"]["data"]).toEqual({ code: "invalid_params" });
  });

  test("a thrower-supplied code is untouched", async () => {
    const data = { code: "budget_exceeded", limit: 10, size: 12 };
    const res = await call(
      serverWith(() => {
        throw new MCPError(INVALID_PARAMS, "over budget", data);
      }),
    );
    expect(res["error"]["data"]).toEqual(data);
    expect(Object.keys(res["error"]["data"])).toEqual(["code", "limit", "size"]);
    expect(lines).toEqual([]);
  });

  test("a thrower-supplied code outside the registry is kept and named on stderr", async () => {
    // Kept, not replaced: a replaced code would hide which producer sent
    // it, and the stderr line is what points a maintainer at that site.
    const res = await call(
      serverWith(() => {
        throw new MCPError(INVALID_PARAMS, "refused", { code: "not_a_registered_code" });
      }),
    );
    expect(res["error"]["data"]).toEqual({ code: "not_a_registered_code" });
    expect(lines).toEqual([
      'warning: unregistered error code on the wire: "not_a_registered_code"\n',
    ]);
  });

  test("an unregistered code is quoted and capped, so it cannot forge stderr lines", async () => {
    const forged = `x\nwarning: forged line${"y".repeat(200)}`;
    const res = await call(
      serverWith(() => {
        throw new MCPError(INVALID_PARAMS, "refused", { code: forged });
      }),
    );
    expect(res["error"]["data"]).toEqual({ code: forged });
    // One line, the newline escaped inside the quoted code, and a bound
    // on the length however long the code is.
    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line!.indexOf("\n")).toBe(line!.length - 1);
    expect(line).toStartWith(
      'warning: unregistered error code on the wire: "x\\nwarning: forged line',
    );
    expect(line!.length).toBeLessThanOrEqual(UNREGISTERED_LINE_MAX);
  });

  test("a record without a code keeps every member and gains code last", async () => {
    const data = { tool: TOOL, unknown_arguments: ["x"], declared_arguments: [] };
    const res = await call(
      serverWith(() => {
        throw new MCPError(INVALID_PARAMS, "unknown argument", data);
      }),
    );
    expect(res["error"]["data"]).toEqual({ ...data, code: "invalid_params" });
    expect(Object.keys(res["error"]["data"])).toEqual([
      "tool",
      "unknown_arguments",
      "declared_arguments",
      "code",
    ]);
  });

  test("a JSON-RPC refusal of a call with a refused progress token carries the refusal", async () => {
    // The refusal is not only for isError results: a call that asked for
    // progress and was refused as a protocol error never got any either.
    const res = await call(
      serverWith(() => {
        throw new MCPError(INVALID_PARAMS, "limit must be positive", { limit: -1 });
      }),
      { progressToken: "tok-2" },
    );
    expect(res["error"]["message"]).toBe("limit must be positive");
    const data = res["error"]["data"] as JsonObject;
    expect(Object.keys(data)).toEqual(["limit", PROGRESS_META_KEY, "code"]);
    expect(data[PROGRESS_META_KEY]["progressToken"]).toBe("tok-2");
    expect(data["code"]).toBe("invalid_params");
  });

  test("a non-string code member is replaced by the default", async () => {
    const res = await call(
      serverWith(() => {
        throw new MCPError(INVALID_PARAMS, "refused", { code: 42, limit: 3 });
      }),
    );
    expect(res["error"]["data"]).toEqual({ code: "invalid_params", limit: 3 });
  });

  test("an array is refused as data by name, never merged into", () => {
    // `{ ...[a, b], code }` would go out as `{"0":a,"1":b,"code":...}`.
    expect(() => new MCPError(INVALID_PARAMS, "refused", ["a", "b"])).toThrow(
      MCPErrorDataArrayError,
    );
  });

  test("a plain throw outside tools/call is internal_error and is logged", async () => {
    const server = new MCPServer({ vault: tmp });
    (server as any).handleResourcesList = () => {
      throw new Error("boom");
    };
    const res = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 2,
      method: "resources/list",
    })) as JsonObject;
    expect(res["error"]["code"]).toBe(-32603);
    expect(res["error"]["message"]).toBe("internal error: boom");
    expect(res["error"]["data"]).toEqual({ code: "internal_error" });
    expect(lines).toEqual([UNCLASSIFIED_LINE]);
  });

  test("a stdio parse error answers parse_error", async () => {
    const out = await serveStdioFromString({ vault: tmp }, "{not json}\n");
    const res = JSON.parse(out.trim()) as JsonObject;
    expect(res["error"]["code"]).toBe(-32700);
    expect(res["error"]["data"]).toEqual({ code: "parse_error" });
  });
});

describe("channel B: _meta code on every isError result", () => {
  test("a safeguard timeout carries safeguard_timeout, text unchanged", async () => {
    const thrown = new SafeguardTimeoutError("probe", 5);
    const res = await call(
      serverWith(() => {
        throw thrown;
      }),
    );
    const result = res["result"];
    expect(result["isError"]).toBe(true);
    expect(result["content"]).toEqual([{ type: "text", text: thrown.message }]);
    expect(result["structuredContent"]).toBeUndefined();
    expect(result["_meta"]).toEqual({
      [TOOL_ERROR_META_KEY]: { schema: TOOL_ERROR_SCHEMA, code: "safeguard_timeout" },
    });
    expect(lines).toEqual([]);
  });

  test("a failed call with a refused progress token carries both _meta keys", async () => {
    const res = await call(
      serverWith(() => {
        throw new SafeguardTimeoutError("probe", 5);
      }),
      { progressToken: "tok-1" },
    );
    const meta = res["result"]["_meta"] as JsonObject;
    expect(Object.keys(meta).toSorted()).toEqual(
      [PROGRESS_META_KEY, TOOL_ERROR_META_KEY].toSorted(),
    );
    expect(meta[TOOL_ERROR_META_KEY]).toEqual({
      schema: TOOL_ERROR_SCHEMA,
      code: "safeguard_timeout",
    });
    expect(meta[PROGRESS_META_KEY]["progressToken"]).toBe("tok-1");
  });

  test("a successful call with no progress token has no _meta key at all", async () => {
    const res = await call(serverWith(() => ({ ok: true })));
    expect(Object.keys(res["result"]).toSorted()).toEqual([
      "content",
      "isError",
      "structuredContent",
    ]);
  });

  test("an unclassified throw carries internal_error and is logged once", async () => {
    const res = await call(
      serverWith(() => {
        throw new Error("something private");
      }),
    );
    expect(res["result"]["content"]).toEqual([{ type: "text", text: "something private" }]);
    expect(readToolErrorCode(res["result"])).toBe("internal_error");
    expect(lines).toEqual([UNCLASSIFIED_LINE]);
  });
});
