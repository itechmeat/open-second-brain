/**
 * `brain_truth` MCP tool (Entity Truth & Self-Improving Dream Suite):
 * ingest one claim, read slots/conflicts from the fold, aggregate
 * exact-match quantities, report cross-agent collisions.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { appendClaimEvent } from "../../src/core/brain/truth/store.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";

let tmp: string;
let vault: string;
let configHome: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-truth-"));
  vault = join(tmp, "vault");
  configHome = mkdtempSync(join(tmpdir(), "o2b-mcp-truth-cfg-"));
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
      clientInfo: { name: "truth-test", version: "0" },
    },
  });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    method: "notifications/initialized",
  });
}

async function call(
  server: MCPServer,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 99,
    method: "tools/call",
    params: { name: "brain_truth", arguments: args },
  })) as { result?: { content?: Array<{ text?: string }> }; error?: { message: string } };
  if (res.error !== undefined) throw new Error(res.error.message);
  return JSON.parse(res.result!.content![0]!.text!) as Record<string, unknown>;
}

test("ingest then slots round-trips one claim through the fold", async () => {
  const server = new MCPServer({ vault, configPath });
  await initialize(server);
  const ingested = await call(server, {
    operation: "ingest",
    entity: "Alice Mason",
    aspect: "employer",
    value: "Google",
    source: "[[Brain/notes/standup.md]]",
  });
  expect(ingested["ok"]).toBe(true);
  expect(ingested["entity"]).toBe("alice mason");

  const slots = await call(server, { operation: "slots" });
  expect(slots["events"]).toBe(1);
  expect((slots["slots"] as Array<{ current: { value: string } }>)[0]!.current.value).toBe(
    "Google",
  );
});

test("conflicts and aggregate read the same ledger", async () => {
  appendClaimEvent(vault, {
    ts: "2026-06-01T10:00:00Z",
    agent: "claude",
    entity: "Alice Mason",
    aspect: "employer",
    value: "Google",
    source: "[[Brain/notes/a.md]]",
  });
  appendClaimEvent(vault, {
    ts: "2026-06-10T10:00:00Z",
    agent: "sales-agent",
    entity: "Alice Mason",
    aspect: "employer",
    value: "Meta",
    source: "[[Brain/notes/b.md]]",
  });
  appendClaimEvent(vault, {
    ts: "2026-06-02T10:00:00Z",
    agent: "claude",
    entity: "operator",
    aspect: "hosting spend",
    value: "120",
    valueKind: "quantity",
    quantity: { value: 120, unit: "usd", action: "spent" },
    source: "[[Brain/notes/c.md]]",
  });

  const server = new MCPServer({ vault, configPath });
  await initialize(server);

  const conflicts = await call(server, { operation: "conflicts" });
  expect(conflicts["conflicts"]).toHaveLength(1);

  const aggregate = await call(server, { operation: "aggregate", action: "spent", unit: "usd" });
  expect(aggregate["total"]).toBe(120);
  expect(aggregate["count"]).toBe(1);
});

test("unknown operation is an invalid-params error", async () => {
  const server = new MCPServer({ vault, configPath });
  await initialize(server);
  await expect(call(server, { operation: "bogus" })).rejects.toThrow(/operation/);
});
