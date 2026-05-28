import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import {
  JSONRPC_VERSION,
  MCPServer,
  PROTOCOL_VERSION,
} from "../../src/mcp/index.ts";

let tmp: string;
let vault: string;
let configHome: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-agent-query-"));
  vault = join(tmp, "vault");
  configHome = mkdtempSync(join(tmpdir(), "o2b-mcp-agent-query-cfg-"));
  configPath = join(configHome, "config.yaml");
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
      clientInfo: { name: "agent-query-test", version: "0" },
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
  args: Record<string, unknown>,
): Promise<any> {
  return server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 99,
    method: "tools/call",
    params: { name, arguments: args },
  });
}

function seedVault(): void {
  const sig = writeSignal(vault, {
    topic: "agent-query",
    signal: "positive",
    agent: "claude",
    principle: "Keep agent provenance queryable.",
    created_at: "2026-05-20T10:00:00Z",
    date: "2026-05-20",
    slug: "agent-query",
  });
  writePreference(vault, {
    slug: "agent-query",
    topic: "agent-query",
    principle: "Keep agent provenance queryable.",
    created_at: "2026-05-22T10:00:00Z",
    unconfirmed_until: "2026-06-05T10:00:00Z",
    status: "unconfirmed",
    evidenced_by: [`[[${sig.id}]]`],
    confirmed_at: null,
  });
}

describe("brain_agent_query", () => {
  test("returns structured agent-source query results", async () => {
    seedVault();
    const server = new MCPServer({ vault, configPath });
    await initialize(server);

    const response = await call(server, "brain_agent_query", {
      agents: ["claude"],
    });

    expect(response.result.isError).toBe(false);
    const content = response.result.structuredContent;
    expect(content.mode).toBe("agent-query");
    expect(content.filters.agents).toEqual(["claude"]);
    expect(content.total_matched).toBe(2);
    expect(content.contributions.map((c: any) => c.id)).toEqual([
      "sig-2026-05-20-agent-query",
      "pref-agent-query",
    ]);
    expect(content.summary).toBe(
      "claude: 2 contributions across 1 topic (preference, signal).",
    );
  });
});
