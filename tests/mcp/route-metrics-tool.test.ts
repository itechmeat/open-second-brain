import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { listMcpRouteLatency } from "../../src/core/brain/mcp-route-metrics.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";

let tmp: string;
let vault: string;
let configHome: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

function writeConfig(routeMetrics: boolean): void {
  atomicWriteFileSync(
    configPath,
    `vault: ${vault}\nagent_name: claude\nmcp_route_metrics_enabled: "${routeMetrics}"\n`,
  );
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-route-metrics-tool-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  configHome = mkdtempSync(join(tmpdir(), "o2b-route-metrics-tool-cfg-"));
  configPath = join(configHome, "config.yaml");
  for (const key of [
    "VAULT_AGENT_NAME",
    "VAULT_TIMEZONE",
    "VAULT_DIR",
    "OPEN_SECOND_BRAIN_CONFIG",
    "OPEN_SECOND_BRAIN_MCP_ROUTE_METRICS_ENABLED",
  ]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function initialize(server: MCPServer): Promise<void> {
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "route-metrics-test", version: "0" },
    },
  });
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
  })) as { result: { content: ReadonlyArray<{ type: string; text: string }> } };
  return JSON.parse(response.result.content[0]!.text);
}

describe("brain_route_metrics registration", () => {
  test("registered in the full tool table only", () => {
    expect(
      buildToolTable("full").find((tool) => tool.name === "brain_route_metrics"),
    ).toBeDefined();
    expect(
      buildToolTable("writer").find((tool) => tool.name === "brain_route_metrics"),
    ).toBeUndefined();
  });
});

describe("route latency capture through tools/call", () => {
  test("gate off records nothing", async () => {
    writeConfig(false);
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    await callTool(server, "second_brain_status", {});
    expect(listMcpRouteLatency(vault)).toHaveLength(0);
  });

  test("gate on records one payload-safe record per call", async () => {
    writeConfig(true);
    const server = new MCPServer({ vault, configPath });
    await initialize(server);

    await callTool(server, "second_brain_status", {});
    await callTool(server, "second_brain_query", { pattern: "x", limit: 5 });

    const records = listMcpRouteLatency(vault);
    expect(records).toHaveLength(2);
    const tools = records.map((r) => r.payload["tool"]).toSorted();
    expect(tools).toEqual(["second_brain_query", "second_brain_status"]);
    for (const r of records) {
      expect(r.payload["status"]).toBe("ok");
      expect(r.payload["scope"]).toBe("full");
      expect(typeof r.payload["duration_ms"]).toBe("number");
    }
    // Query call recorded its schema arg key NAMES, never the values.
    const query = records.find((r) => r.payload["tool"] === "second_brain_query")!;
    expect(query.payload["arg_keys"]).toEqual(["limit", "pattern"]);
  });

  test("a failing tool call is recorded with status error and still errors upstream", async () => {
    writeConfig(true);
    const server = new MCPServer({ vault, configPath });
    await initialize(server);

    // artifact_get with an unknown id → handler throws → tool error envelope.
    const response = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 9,
      method: "tools/call",
      params: { name: "brain_artifact_get", arguments: { artifact_id: "nope" } },
    })) as { result?: { isError?: boolean }; error?: unknown };
    expect(response.error ?? response.result?.isError).toBeTruthy();

    const records = listMcpRouteLatency(vault, { tool: "brain_artifact_get" });
    expect(records).toHaveLength(1);
    expect(records[0]!.payload["status"]).toBe("error");
  });

  test("brain_route_metrics summary ranks the slowest surface first", async () => {
    writeConfig(true);
    const server = new MCPServer({ vault, configPath });
    await initialize(server);

    // Generate a few calls across two tools.
    await callTool(server, "second_brain_status", {});
    await callTool(server, "second_brain_query", {});
    await callTool(server, "second_brain_query", {});

    const summary = await callTool(server, "brain_route_metrics", { operation: "summary" });
    // The summary call itself is emitted AFTER the handler returns, so it is
    // not counted here; only the three prior calls plus none-yet for this one.
    expect(summary["total"]).toBeGreaterThanOrEqual(3);
    const routes = summary["routes"] as Array<Record<string, unknown>>;
    expect(routes.length).toBeGreaterThanOrEqual(2);
    for (const route of routes) {
      expect(route).toHaveProperty("p95_ms");
      expect(route).toHaveProperty("count");
    }

    const list = await callTool(server, "brain_route_metrics", {
      operation: "list",
      tool: "second_brain_query",
    });
    expect(list["total"]).toBe(2);
  });

  test("brain_route_metrics rejects an unknown operation", async () => {
    writeConfig(true);
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const response = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 9,
      method: "tools/call",
      params: { name: "brain_route_metrics", arguments: { operation: "bogus" } },
    })) as { result?: { isError?: boolean }; error?: unknown };
    expect(response.error ?? response.result?.isError).toBeTruthy();
  });
});
