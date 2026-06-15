/**
 * brain_codegraph_report MCP tool (t_a1e76788).
 *
 * Read-only partner report. Registered in the full (read) tool table, never
 * the writer table, and returns a schema-versioned envelope without mutating
 * the project or vault. codegraph presence and the resolved code project are
 * environment-dependent, so assertions target the stable report envelope.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-codegraph-report-tool-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

async function initialize(server: MCPServer): Promise<void> {
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "codegraph-report-test", version: "0" },
    },
  });
  await server.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
}

async function call(): Promise<{ result?: unknown; error?: unknown }> {
  const server = new MCPServer({ vault, configPath: null });
  await initialize(server);
  return (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 9,
    method: "tools/call",
    params: { name: "brain_codegraph_report", arguments: {} },
  })) as { result?: unknown; error?: unknown };
}

function payload(response: { result?: unknown }): Record<string, unknown> {
  const result = response.result as { content: ReadonlyArray<{ type: string; text: string }> };
  return JSON.parse(result.content[0]!.text);
}

describe("brain_codegraph_report tool", () => {
  test("registered in the full table only", () => {
    expect(buildToolTable("full").find((t) => t.name === "brain_codegraph_report")).toBeDefined();
    expect(
      buildToolTable("writer").find((t) => t.name === "brain_codegraph_report"),
    ).toBeUndefined();
  });

  test("returns a schema-versioned read-only report envelope", async () => {
    const response = await call();
    expect(response.error).toBeUndefined();
    const report = payload(response as { result?: unknown });
    expect(report["schema_version"]).toBe(1);
    expect(report).toHaveProperty("cli");
    expect(report).toHaveProperty("index");
    expect(report).toHaveProperty("cargo_workspace");
    expect(report).toHaveProperty("cargo_workspace_reason");
  });
});
