import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
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
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-agent-diff-"));
  vault = join(tmp, "vault");
  configHome = mkdtempSync(join(tmpdir(), "o2b-mcp-agent-diff-cfg-"));
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
      clientInfo: { name: "agent-diff-test", version: "0" },
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
  writeSignal(vault, {
    topic: "shared-topic",
    signal: "positive",
    agent: "claude",
    principle: "Both agents know this topic.",
    created_at: "2026-05-20T10:00:00Z",
    date: "2026-05-20",
    slug: "shared-claude",
  });
  writeSignal(vault, {
    topic: "shared-topic",
    signal: "positive",
    agent: "codex",
    principle: "Codex also knows this topic.",
    created_at: "2026-05-21T10:00:00Z",
    date: "2026-05-21",
    slug: "shared-codex",
  });
  writeSignal(vault, {
    topic: "codex-only",
    signal: "negative",
    agent: "codex",
    principle: "Do not hardcode agent pairs.",
    created_at: "2026-05-22T10:00:00Z",
    date: "2026-05-22",
    slug: "codex-only",
  });
}

describe("brain_agent_diff", () => {
  test("returns structured comparison results", async () => {
    seedVault();
    const server = new MCPServer({ vault, configPath });
    await initialize(server);

    const response = await call(server, "brain_agent_diff", {
      mode: "diff",
      agents: ["claude", "codex"],
    });

    expect(response.result.isError).toBe(false);
    const content = response.result.structuredContent;
    expect(content.mode).toBe("agent-diff");
    expect(content.diff_mode).toBe("diff");
    expect(content.shared_topics).toEqual(["shared-topic"]);
    expect(content.unique_topics).toEqual({
      claude: [],
      codex: ["codex-only"],
    });
  });
});
