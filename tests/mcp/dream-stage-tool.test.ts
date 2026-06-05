/**
 * `brain_dream` staged-lifecycle actions over MCP (t_ae8a8ec0): the
 * one dream tool gains an `action` parameter instead of new tools -
 * the 1.0.0 surface stays at 77. INVALID_PARAMS fire before any
 * environment work; the full stage -> validate -> apply cycle runs
 * through tools/call.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";

let tmp: string;
let vault: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-dream-stage-"));
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
  writeFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function makeServer(): Promise<MCPServer> {
  const server = new MCPServer({ vault, configPath });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "dream-stage-test", version: "0" },
    },
  });
  await server.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
  return server;
}

let callId = 10;
async function call(
  server: MCPServer,
  args: Record<string, unknown>,
): Promise<{ structured?: Record<string, unknown>; errorCode?: number }> {
  callId += 1;
  const r = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: callId,
    method: "tools/call",
    params: { name: "brain_dream", arguments: args },
  })) as {
    result?: { structuredContent?: Record<string, unknown> };
    error?: { code: number };
  };
  if (r.error) return { errorCode: r.error.code };
  return { structured: r.result?.structuredContent };
}

function seedCluster(topic: string): void {
  for (const i of [1, 2, 3]) {
    writeSignal(vault, {
      topic,
      signal: "positive",
      agent: "claude",
      principle: `Rule for ${topic}.`,
      created_at: "2026-06-01T10:00:00Z",
      date: "2026-06-01",
      slug: `${topic}-${i}`,
      scope: "writing",
    });
  }
}

test("full staged cycle through tools/call", async () => {
  seedCluster("mcp-cycle");
  const server = await makeServer();

  const staged = await call(server, { action: "stage", now: "2026-06-05T12:00:00Z" });
  const runId = staged.structured!["run_id"] as string;
  expect(runId).toMatch(/^stage-/);

  const validated = await call(server, { action: "validate", run_id: runId });
  expect(validated.structured!["valid"]).toBe(true);

  const applied = await call(server, { action: "apply", run_id: runId });
  expect(applied.structured!["applied"]).toBe(true);
  expect(applied.structured!["new_unconfirmed"]).toEqual(["pref-mcp-cycle"]);

  const listed = await call(server, { action: "list" });
  const bundles = listed.structured!["bundles"] as Array<{ status: string }>;
  expect(bundles[0]!.status).toBe("applied");
});

test("INVALID_PARAMS before environment work", async () => {
  const server = await makeServer();
  expect((await call(server, { action: "hibernate" })).errorCode).toBe(-32602);
  expect((await call(server, { action: "apply" })).errorCode).toBe(-32602);
  expect((await call(server, { action: "validate" })).errorCode).toBe(-32602);
});

test("discard over MCP removes a staged bundle", async () => {
  seedCluster("mcp-discard");
  const server = await makeServer();
  const staged = await call(server, { action: "stage", now: "2026-06-05T12:00:00Z" });
  const runId = staged.structured!["run_id"] as string;
  const discarded = await call(server, { action: "discard", run_id: runId });
  expect(discarded.structured!["removed"]).toBe(true);
});

test("plain action=run keeps the legacy summary shape", async () => {
  seedCluster("mcp-legacy");
  const server = await makeServer();
  const r = await call(server, { now: "2026-06-05T12:00:00Z" });
  expect(r.structured!["new_unconfirmed"]).toEqual(["pref-mcp-legacy"]);
  expect(typeof r.structured!["run_id"]).toBe("string");
});
