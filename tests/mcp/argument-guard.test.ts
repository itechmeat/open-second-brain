/**
 * Unknown-argument gate (evidence-at-the-boundary, task C3).
 *
 * All 108 tools declare `additionalProperties: false` and, before this
 * unit, the server enforced it on none: `{"quiery": "x"}` on
 * `brain_search` came back as a normal success envelope computed from
 * defaults. The only place the unknown key was observed was a telemetry
 * field the caller never sees.
 *
 * These tests pin the two halves of the fix: the pure finder over one
 * schema, and the wiring at the single handler-invocation seam that both
 * `tools/call` and the CLI bridge pass through.
 */

import { describe, expect, test } from "bun:test";

import {
  assertKnownArguments,
  findUnknownArguments,
  type UnknownArgumentData,
} from "../../src/mcp/argument-guard.ts";
import { INVALID_PARAMS, MCPError } from "../../src/mcp/protocol.ts";
import { MCPServer } from "../../src/mcp/server.ts";
import type { ToolDefinition } from "../../src/mcp/tool-contract.ts";

const CLOSED_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string", description: "The search text." },
    limit: { type: "integer", description: "Row cap." },
    session_id: { type: "string", description: "Correlation id." },
  },
  required: ["query"],
  additionalProperties: false,
};

function closedTool(name = "demo_tool"): ToolDefinition {
  return {
    name,
    description: "A closed demo tool.",
    inputSchema: CLOSED_SCHEMA,
    handler: async () => ({ ok: true }),
  } as unknown as ToolDefinition;
}

describe("findUnknownArguments", () => {
  test("a declared argument set reports nothing", () => {
    expect(findUnknownArguments(CLOSED_SCHEMA, { query: "x", limit: 3 })).toEqual([]);
    expect(findUnknownArguments(CLOSED_SCHEMA, {})).toEqual([]);
  });

  test("an undeclared argument is reported with its nearest declared name", () => {
    expect(findUnknownArguments(CLOSED_SCHEMA, { quiery: "x" })).toEqual([
      { name: "quiery", suggestion: "query" },
    ]);
  });

  test("an undeclared argument with no near match carries no suggestion", () => {
    expect(findUnknownArguments(CLOSED_SCHEMA, { wombat: 1 })).toEqual([{ name: "wombat" }]);
  });

  test("every undeclared argument is reported, in the caller's key order", () => {
    const found = findUnknownArguments(CLOSED_SCHEMA, { quiery: "x", wombat: 1, limit: 2 });
    expect(found.map((u) => u.name)).toEqual(["quiery", "wombat"]);
  });

  test("an open schema is not gated - the closure is read, never assumed", () => {
    const open = { type: "object", properties: { query: { type: "string" } } };
    expect(findUnknownArguments(open, { anything: 1 })).toEqual([]);
    const explicitlyOpen = { ...open, additionalProperties: true };
    expect(findUnknownArguments(explicitlyOpen, { anything: 1 })).toEqual([]);
  });

  test("a closed schema with no properties rejects every argument", () => {
    const noArgs = { type: "object", properties: {}, additionalProperties: false };
    expect(findUnknownArguments(noArgs, { agent: "x" })).toEqual([{ name: "agent" }]);
  });

  test("an inherited Object.prototype name is not mistaken for a declared one", () => {
    const found = findUnknownArguments(CLOSED_SCHEMA, { constructor: 1, toString: 2 });
    expect(found.map((u) => u.name).toSorted()).toEqual(["constructor", "toString"]);
  });

  test("nested closure is out of scope: only the top level is gated", () => {
    const nested = {
      type: "object",
      properties: {
        usage: { type: "object", properties: {}, additionalProperties: false },
      },
      additionalProperties: false,
    };
    expect(findUnknownArguments(nested, { usage: { input_tokens: 1 } })).toEqual([]);
  });
});

describe("assertKnownArguments", () => {
  test("a declared argument set passes silently", () => {
    expect(() => assertKnownArguments(closedTool(), { query: "x" })).not.toThrow();
  });

  test("an unknown argument raises INVALID_PARAMS naming it and the suggestion", () => {
    let raised: MCPError | undefined;
    try {
      assertKnownArguments(closedTool("brain_search"), { quiery: "x" });
    } catch (exc) {
      raised = exc as MCPError;
    }
    expect(raised).toBeInstanceOf(MCPError);
    expect(raised!.code).toBe(INVALID_PARAMS);
    expect(raised!.message).toContain("brain_search");
    expect(raised!.message).toContain("quiery");
    expect(raised!.message).toContain("query");
    const data = raised!.data as UnknownArgumentData;
    expect(data.tool).toBe("brain_search");
    expect(data.unknown_arguments).toEqual([{ name: "quiery", suggestion: "query" }]);
    expect(data.declared_arguments).toEqual(["limit", "query", "session_id"]);
  });

  test("an unknown argument with no near match says so and points at the schema", () => {
    let raised: MCPError | undefined;
    try {
      assertKnownArguments(closedTool(), { wombat: 1 });
    } catch (exc) {
      raised = exc as MCPError;
    }
    expect(raised).toBeInstanceOf(MCPError);
    expect(raised!.message).toContain("wombat");
    expect(raised!.message).toContain("no close match");
    expect(raised!.message).toContain("inputSchema");
    const data = raised!.data as UnknownArgumentData;
    expect(data.unknown_arguments).toEqual([{ name: "wombat" }]);
  });

  test("every unknown argument appears in one message, never just the first", () => {
    let raised: MCPError | undefined;
    try {
      assertKnownArguments(closedTool(), { quiery: "x", wombat: 1 });
    } catch (exc) {
      raised = exc as MCPError;
    }
    expect(raised!.message).toContain("quiery");
    expect(raised!.message).toContain("wombat");
    expect((raised!.data as UnknownArgumentData).unknown_arguments).toHaveLength(2);
  });
});

describe("the seam every caller passes through", () => {
  const server = new MCPServer({ vault: "/nonexistent-vault" });

  async function call(name: string, args: Record<string, unknown>) {
    return server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    });
  }

  test("tools/call answers a mistyped argument with invalid-params, not a default-computed success", async () => {
    const response = await call("brain_search", { quiery: "anything" });
    expect(response?.error?.code).toBe(INVALID_PARAMS);
    expect(response?.error?.message).toContain("quiery");
    expect(response?.error?.message).toContain("query");
    expect(response?.result).toBeUndefined();
  });

  test("the structured data rides along on the JSON-RPC error", async () => {
    const response = await call("brain_search", { quiery: "anything" });
    const data = response?.error?.data as UnknownArgumentData;
    expect(data.tool).toBe("brain_search");
    expect(data.unknown_arguments[0]?.name).toBe("quiery");
  });

  test("the CLI bridge passes through the same seam", async () => {
    await expect(server.callTool("brain_search", { quiery: "anything" })).rejects.toThrow(/quiery/);
  });

  test("a well-formed call is not refused by the gate", async () => {
    // It may still fail for vault reasons; what it must not do is fail
    // with an unknown-argument refusal.
    const response = await call("brain_health", {});
    expect(response?.error?.message ?? "").not.toContain("unknown argument");
  });

  test("the recorded nested limit is a checked one: an unknown key inside an operation still reaches the handler", async () => {
    // `brain_write_batch.operations[]` declares `additionalProperties:
    // false` of its own and this gate does not enforce it. That is a
    // STATED boundary, not a fallback pretending to work - widening it
    // means walking the argument tree against the schema tree, which is
    // a validator, and this is not one. Pinned here so a future reader
    // who assumes the gate is recursive is contradicted by a test rather
    // than by a comment.
    const args = {
      operations: [{ op: "append_log_line", text: "a line", quiery: "an unknown nested key" }],
    };
    const declared = server.tools.find((tool) => tool.name === "brain_write_batch");
    expect(declared).toBeDefined();
    expect(findUnknownArguments(declared!.inputSchema, args)).toEqual([]);

    const response = await call("brain_write_batch", args);
    // Whatever the handler makes of the nonexistent vault, the one answer
    // it must not give is the boundary's: an invalid-params refusal
    // naming the nested key.
    expect(response?.error?.code ?? 0).not.toBe(INVALID_PARAMS);
    expect(response?.error?.message ?? "").not.toContain("unknown argument");
    expect(response?.error?.message ?? "").not.toContain("quiery");
  });
});
