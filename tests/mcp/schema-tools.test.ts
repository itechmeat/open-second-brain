import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { INVALID_PARAMS } from "../../src/mcp/protocol.ts";

let tmp: string;
let vault: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-schema-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
  for (const key of [
    "VAULT_AGENT_NAME",
    "VAULT_TIMEZONE",
    "VAULT_DIR",
    "OPEN_SECOND_BRAIN_CONFIG",
  ]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
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
      clientInfo: { name: "schema-test", version: "0" },
    },
  });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    method: "notifications/initialized",
  });
}

async function call(
  server: MCPServer,
  name: string,
  args: Record<string, unknown> = {},
): Promise<any> {
  return server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 99,
    method: "tools/call",
    params: { name, arguments: args },
  });
}

function makeServer(): MCPServer {
  return new MCPServer({ vault, configPath });
}

describe("schema MCP tools", () => {
  test("registers the schema administration surface", async () => {
    const server = makeServer();
    await initialize(server);

    const response = await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 50,
      method: "tools/list",
    });
    const names = ((response as any).result.tools as ReadonlyArray<{ name: string }>).map(
      (tool) => tool.name,
    );

    // token-diet consolidated the per-view readers into schema_inspect;
    // the 1.0.0 sweep removed the hidden aliases entirely.
    expect(names).toContain("schema_inspect");
    expect(names).toContain("schema_apply_mutations");
    expect(names).not.toContain("schema_stats");
  });

  test("applies schema mutations through the MCP handler", async () => {
    const server = makeServer();
    await initialize(server);

    const applied = await call(server, "schema_apply_mutations", {
      mutations: [{ op: "add_type", category: "preference_types", token: "decision" }],
    });
    expect((applied as any).result.structuredContent.applied).toBe(1);

    const pack = await call(server, "schema_inspect", { view: "active_pack" });
    expect((pack as any).result.structuredContent.pack.declarations.preference_types).toContain(
      "decision",
    );
  });

  test("schema graph namespaces link type node ids", async () => {
    const server = makeServer();
    await initialize(server);

    await call(server, "schema_apply_mutations", {
      mutations: [
        { op: "add_type", category: "preference_types", token: "decision" },
        { op: "add_link_type", token: "decision" },
      ],
    });
    const graph = await call(server, "schema_inspect", { view: "graph" });
    const nodes = (graph as any).result.structuredContent.nodes as ReadonlyArray<{ id: string }>;

    expect(nodes.map((node) => node.id)).toContain("decision");
    expect(nodes.map((node) => node.id)).toContain("link:decision");
  });

  test("schema apply reports coercion failures as invalid params", async () => {
    const server = makeServer();
    await initialize(server);

    const response = await call(server, "schema_apply_mutations", {
      mutations: "not an array",
    });

    expect((response as any).error.code).toBe(INVALID_PARAMS);
    expect((response as any).error.message).toContain("mutations must be an array");
  });
});
