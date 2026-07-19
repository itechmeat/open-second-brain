/**
 * MCP integration tests for `brain_retrieval_plan` (R3, t_3ffb021c): the
 * shadow-only retrieval advisor. Drives the full server path so registration,
 * the read-only contract (no mutating params, no store/config writes), and
 * the output shape are all covered here.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-mcp-retplan-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

async function initialize(server: MCPServer): Promise<void> {
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "retplan-test", version: "0" },
    },
  });
  await server.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
}

async function listToolNames(server: MCPServer): Promise<string[]> {
  const r = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 2,
    method: "tools/list",
    params: {},
  })) as {
    result?: { tools: ReadonlyArray<{ name: string; inputSchema: Record<string, unknown> }> };
  };
  return (r.result?.tools ?? []).map((t) => t.name);
}

async function call(
  server: MCPServer,
  args: Record<string, unknown>,
): Promise<{ result?: Record<string, unknown>; error?: { message: string } }> {
  const r = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 9,
    method: "tools/call",
    params: { name: "brain_retrieval_plan", arguments: args },
  })) as {
    result?: { content: ReadonlyArray<{ type: string; text: string }>; isError?: boolean };
    error?: { message: string };
  };
  if (r.error) return { error: r.error };
  const text = r.result!.content[0]!.text;
  if (r.result!.isError) return { error: { message: text } };
  return { result: JSON.parse(text) };
}

function listing(root: string): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out.push([relative(root, abs), statSync(abs).size]);
    }
  };
  walk(root);
  return out.toSorted((a, b) => a[0].localeCompare(b[0]));
}

describe("brain_retrieval_plan", () => {
  test("is advertised (not hidden) and callable, returning the full plan shape", async () => {
    const server = new MCPServer({ vault });
    await initialize(server);
    expect(await listToolNames(server)).toContain("brain_retrieval_plan");

    const { result, error } = await call(server, {
      question: "how do i configure staging deploys",
      token_budget: 1500,
    });
    expect(error).toBeUndefined();
    const plan = result!;
    expect(plan["strategy"]).toBeDefined();
    expect((plan["allocation"] as Record<string, unknown>)["token_budget"]).toBe(1500);
    expect(plan["graph_expansion"]).toBeDefined();
    expect(plan["reliability"]).toBeDefined();
    expect(plan["marginal_stop"]).toBeDefined();
  });

  test("exposes no mutating parameters (only question + token_budget)", async () => {
    const server = new MCPServer({ vault });
    await initialize(server);
    const r = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 3,
      method: "tools/list",
      params: {},
    })) as {
      result: { tools: ReadonlyArray<{ name: string; inputSchema: Record<string, unknown> }> };
    };
    const tool = r.result.tools.find((t) => t.name === "brain_retrieval_plan")!;
    const props = (tool.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props).toSorted()).toEqual(["question", "token_budget"]);
    expect((tool.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(
      false,
    );
  });

  test("is read-only: a call writes no config or store files", async () => {
    const server = new MCPServer({ vault });
    await initialize(server);
    const before = listing(vault);
    const { error } = await call(server, { question: "backup schedule" });
    expect(error).toBeUndefined();
    expect(listing(vault)).toEqual(before);
  });

  test("a missing question is a usage error, not a silent empty plan", async () => {
    const server = new MCPServer({ vault });
    await initialize(server);
    const { error } = await call(server, {});
    expect(error).toBeDefined();
  });
});
