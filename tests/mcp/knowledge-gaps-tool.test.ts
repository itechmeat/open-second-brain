import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recordQueryDemand } from "../../src/core/brain/query-demand.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";

let tmp: string;
let vault: string;
let configHome: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-knowledge-gaps-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  configHome = mkdtempSync(join(tmpdir(), "o2b-mcp-knowledge-gaps-cfg-"));
  configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

async function initialize(server: MCPServer): Promise<void> {
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "knowledge-gaps-test", version: "0" },
    },
  });
  await server.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
}

async function callTool(
  server: MCPServer,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 9,
    method: "tools/call",
    params: { name, arguments: args },
  })) as
    | { result: { content: ReadonlyArray<{ type: string; text: string }> } }
    | { error: { message: string } };
  if ("error" in response) throw new Error(response.error.message);
  return JSON.parse(response.result.content[0]!.text);
}

describe("brain_knowledge_gaps tool registration", () => {
  test("registered in the full tool table only", () => {
    expect(
      buildToolTable("full").find((tool) => tool.name === "brain_knowledge_gaps"),
    ).toBeDefined();
    expect(
      buildToolTable("writer").find((tool) => tool.name === "brain_knowledge_gaps"),
    ).toBeUndefined();
  });
});

describe("brain_knowledge_gaps tool", () => {
  test("ranks recurring poorly-answered queries and honors filters", async () => {
    for (let i = 0; i < 3; i++) {
      recordQueryDemand(vault, {
        query: "vault backup schedule",
        resultCount: 0,
        coverage: 0.05,
        at: `2026-07-0${i + 1}T00:00:00.000Z`,
      });
    }
    recordQueryDemand(vault, {
      query: "release checklist steps",
      resultCount: 5,
      coverage: 0.95,
      at: "2026-07-01T01:00:00.000Z",
    });
    recordQueryDemand(vault, {
      query: "release checklist steps",
      resultCount: 5,
      coverage: 0.95,
      at: "2026-07-02T01:00:00.000Z",
    });

    const server = new MCPServer({ vault, configPath });
    await initialize(server);

    const report = await callTool(server, "brain_knowledge_gaps", {});
    expect(report["vault_path"]).toBe(vault);
    expect(report["total_records"]).toBe(5);
    const gaps = report["gaps"] as ReadonlyArray<Record<string, unknown>>;
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!["terms"]).toEqual(["backup", "schedule", "vault"]);
    expect(gaps[0]!["occurrences"]).toBe(3);
    expect(gaps[0]!["verdict"]).toBe("sparse");
  });

  test("rejects an out-of-range max_satisfaction", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    await expect(callTool(server, "brain_knowledge_gaps", { max_satisfaction: 2 })).rejects.toThrow(
      /max_satisfaction/,
    );
  });
});
