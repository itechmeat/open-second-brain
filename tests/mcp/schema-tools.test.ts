import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";

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

    expect(names).toContain("get_active_schema_pack");
    expect(names).toContain("list_schema_packs");
    expect(names).toContain("schema_stats");
    expect(names).toContain("schema_lint");
    expect(names).toContain("schema_graph");
    expect(names).toContain("schema_explain_type");
    expect(names).toContain("schema_review_orphans");
    expect(names).toContain("schema_apply_mutations");
    expect(names).toContain("reload_schema_pack");
  });

  test("applies schema mutations through the MCP handler", async () => {
    const server = makeServer();
    await initialize(server);

    const applied = await call(server, "schema_apply_mutations", {
      mutations: [{ op: "add_type", category: "preference_types", token: "decision" }],
    });
    expect((applied as any).result.structuredContent.applied).toBe(1);

    const pack = await call(server, "get_active_schema_pack");
    expect((pack as any).result.structuredContent.pack.declarations.preference_types).toContain(
      "decision",
    );
  });
});
