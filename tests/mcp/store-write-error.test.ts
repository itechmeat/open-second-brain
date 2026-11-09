/**
 * A store-only write that did not land (`StoreWriteError`, design D14
 * item 1) reaches the MCP boundary under its own code,
 * `store_write_failed`, with its reason and remedy beside the code, on
 * the tool-result channel and on the JSON-RPC channel alike, never as the
 * unclassified `internal_error`.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StoreWriteError } from "../../src/core/store/store-write.ts";
import { JSONRPC_VERSION } from "../../src/mcp/protocol.ts";
import { internalErrorResponse, MCPServer } from "../../src/mcp/server.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import {
  codeForError,
  errorDetailFor,
  isToolErrorCode,
  TOOL_ERROR_META_KEY,
  toolErrorMeta,
} from "../../src/mcp/tool-error-codes.ts";
import { readRpcErrorCode, readToolErrorCode } from "../helpers/tool-error-envelope.ts";

type JsonObject = Record<string, any>;

let tmp: string;
let stderr: Mock<typeof process.stderr.write>;
let lines: string[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-store-write-"));
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

const noStore = (): StoreWriteError =>
  new StoreWriteError("no-store", "no brain store at /somewhere/store");

/**
 * A real store-only write that cannot land: `brain_feedback` on a server
 * with no vault (store-only by definition) whose store root holds no store
 * (the preload points the root at a directory that does not exist).
 */
async function feedbackWithNoStore(): Promise<JsonObject> {
  const server = new MCPServer({ vault: null }, { reach: TRANSPORT_REACH.local });
  return (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 3,
    method: "tools/call",
    params: {
      name: "brain_feedback",
      arguments: { topic: "no-store", signal: "positive", principle: "Lands nowhere." },
    },
  })) as JsonObject;
}

describe("StoreWriteError at the MCP boundary", () => {
  test("classifies as store_write_failed, also through a cause chain", () => {
    expect(isToolErrorCode("store_write_failed")).toBe(true);
    expect(codeForError(noStore())).toBe("store_write_failed");
    expect(codeForError(new Error("feedback failed", { cause: noStore() }))).toBe(
      "store_write_failed",
    );
    // The reason and the remedy are found through the same cause chain.
    const err = noStore();
    expect(errorDetailFor(new Error("feedback failed", { cause: err }))).toEqual({
      reason: "no-store",
      remedy: err.remedy,
    });
    expect(lines).toEqual([]);
  });

  test("a store-only write with no store returns an isError result with the code, the reason and the remedy", async () => {
    const res = await feedbackWithNoStore();
    const result = res["result"] as JsonObject;
    expect(result["isError"]).toBe(true);
    expect(readToolErrorCode(result)).toBe("store_write_failed");
    const meta = result["_meta"][TOOL_ERROR_META_KEY] as JsonObject;
    expect(meta).toMatchObject({
      schema: "o2b.error.v1",
      code: "store_write_failed",
      reason: "no-store",
    });
    expect(meta["remedy"]).toContain("o2b store init");
    // Nothing was written: there is no store, and no vault to fall back to.
    expect(existsSync(process.env["OPEN_SECOND_BRAIN_STORE_ROOT"]!)).toBe(false);
    // A classified failure: no unclassified-error warning on stderr.
    expect(lines).toEqual([]);
  });

  test("the JSON-RPC channel carries the reason and the remedy beside the code", () => {
    const err = new StoreWriteError("partition-unavailable", "private is not held");
    const res = internalErrorResponse(9, err, tmp, TRANSPORT_REACH.local) as JsonObject;
    expect(readRpcErrorCode(res)).toBe("store_write_failed");
    expect(res["error"]["data"]).toEqual({
      code: "store_write_failed",
      reason: "partition-unavailable",
      remedy: err.remedy,
    });
  });

  test("any other failure carries no reason or remedy", () => {
    const boom = new Error("boom");
    const res = internalErrorResponse(9, boom, tmp, TRANSPORT_REACH.local) as JsonObject;
    expect(res["error"]["data"]).not.toHaveProperty("reason");
    expect(res["error"]["data"]).not.toHaveProperty("remedy");
    // The tool-result channel's meta, built from the same two lookups the
    // server's tool-call catch makes, holds the schema and the code only.
    expect(Object.keys(toolErrorMeta(codeForError(boom), errorDetailFor(boom)))).toEqual([
      "schema",
      "code",
    ]);
  });
});
