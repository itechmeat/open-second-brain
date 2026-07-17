import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildToolTable, findTool } from "../../src/mcp/tools.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";
import { MCPServer } from "../../src/mcp/server.ts";

function ctx(): ServerContext {
  return {
    vault: mkdtempSync(join(tmpdir(), "osb-catalog-")),
    configPath: null,
    repoRoot: null,
  };
}

const ADVERTISED = [
  "second_brain_capabilities",
  "brain_apply_evidence",
  "brain_context",
  "brain_feedback",
  "brain_note",
  "brain_pinned_context",
  "tool_hydrate",
];

test("catalog scope advertises only the compact first-pass surface", () => {
  const tools = buildToolTable("catalog");
  const advertised = tools.filter((t) => t.hidden !== true).map((t) => t.name);
  expect(advertised.toSorted()).toEqual([...ADVERTISED].toSorted());
});

test("catalog scope keeps every tool callable (hidden, not removed)", () => {
  const full = buildToolTable("full");
  const catalog = buildToolTable("catalog");
  expect(catalog.length).toBe(full.length);
  // A deep Brain tool stays resolvable for tools/call.
  expect(() => findTool(catalog, "brain_search")).not.toThrow();
});

test("full and writer scopes do not advertise tool_hydrate semantics changes", () => {
  const full = buildToolTable("full");
  const hydrateInFull = full.find((t) => t.name === "tool_hydrate");
  expect(hydrateInFull).toBeDefined();
  const writer = buildToolTable("writer");
  expect(writer.find((t) => t.name === "tool_hydrate")).toBeUndefined();
});

test("tool_hydrate with no args returns the sorted compact catalog", async () => {
  const tools = buildToolTable("catalog");
  const hydrate = findTool(tools, "tool_hydrate");
  const result = (await hydrate.handler(ctx(), {})) as {
    catalog: Array<{ name: string; description: string; group: string }>;
    count: number;
  };
  expect(result.count).toBeGreaterThan(20);
  const names = result.catalog.map((c) => c.name);
  expect(names).toEqual([...names].toSorted());
  expect(names).toContain("brain_search");
  const search = result.catalog.find((c) => c.name === "brain_search")!;
  expect(search.description.length).toBeGreaterThan(0);
  expect(search.description).not.toContain("\n");
});

test("tool_hydrate with names returns full schemas and reports unknowns", async () => {
  const tools = buildToolTable("catalog");
  const hydrate = findTool(tools, "tool_hydrate");
  const result = (await hydrate.handler(ctx(), {
    names: ["brain_search", "no_such_tool"],
  })) as {
    tools: Array<{ name: string; description: string; inputSchema: unknown }>;
    unknown: string[];
  };
  expect(result.tools).toHaveLength(1);
  expect(result.tools[0]!.name).toBe("brain_search");
  expect(result.tools[0]!.inputSchema).toBeDefined();
  expect(result.unknown).toEqual(["no_such_tool"]);
});

test("catalog-scope server lists the compact surface but calls hidden tools", async () => {
  const vault = mkdtempSync(join(tmpdir(), "osb-catalog-srv-"));
  const server = new MCPServer({ vault }, { scope: "catalog" });
  const listResponse = (await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  }))! as { result: { tools: Array<{ name: string }> } };
  const advertised = listResponse.result.tools.map((t) => t.name);
  expect(advertised.toSorted()).toEqual([...ADVERTISED].toSorted());

  // A hidden tool still executes through tools/call.
  const callResponse = (await server.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "second_brain_status", arguments: {} },
  }))! as { result?: unknown; error?: unknown };
  expect(callResponse.error).toBeUndefined();
  expect(callResponse.result).toBeDefined();
});

test("initialize instructions for catalog scope explain the hydration contract", async () => {
  const vault = mkdtempSync(join(tmpdir(), "osb-catalog-ins-"));
  const server = new MCPServer({ vault }, { scope: "catalog" });
  const response = (await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05" },
  }))! as { result: { instructions: string } };
  expect(response.result.instructions).toContain("tool_hydrate");
});
