/**
 * Write-Time Integrity & Governance Suite MCP tools: brain_labels
 * (fail-closed vocabulary classification), brain_tiers (staged
 * identity-drift repair), brain_secrets (list metadata / allowlisted
 * run, never values), brain_maintenance (gated lane run/status).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { setSecret } from "../../src/core/brain/secrets/store.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";

let tmp: string;
let vault: string;
let configHome: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-gov-"));
  vault = join(tmp, "vault");
  configHome = mkdtempSync(join(tmpdir(), "o2b-mcp-gov-cfg-"));
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
      clientInfo: { name: "gov-test", version: "0" },
    },
  });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    method: "notifications/initialized",
  });
}

async function call(
  server: MCPServer,
  tool: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 99,
    method: "tools/call",
    params: { name: tool, arguments: args },
  })) as { result?: { content?: Array<{ text?: string }> }; error?: { message: string } };
  if (res.error !== undefined) throw new Error(res.error.message);
  return JSON.parse(res.result!.content![0]!.text!) as Record<string, unknown>;
}

test("brain_labels assigns within the vocabulary and fails closed outside it", async () => {
  writeFileSync(
    join(vault, "Brain", "_brain.yaml"),
    ["schema_version: 1", "schema:", "  labels:", "    - priority=low", "    - priority=high"].join(
      "\n",
    ) + "\n",
  );
  mkdirSync(join(vault, "notes"), { recursive: true });
  writeFileSync(join(vault, "notes", "rollout.md"), "# Rollout\n\nCanary first.\n");

  const server = new MCPServer({ vault, configPath });
  await initialize(server);

  const assigned = await call(server, "brain_labels", {
    operation: "assign",
    path: "notes/rollout.md",
    dimension: "priority",
    value: "high",
  });
  expect(assigned["labels"]).toEqual(["priority/high"]);

  const shown = await call(server, "brain_labels", {
    operation: "show",
    path: "notes/rollout.md",
  });
  expect(shown["labels"]).toEqual(["priority/high"]);

  await expect(
    call(server, "brain_labels", {
      operation: "assign",
      path: "notes/rollout.md",
      dimension: "priority",
      value: "urgent",
    }),
  ).rejects.toThrow(/allowed values: low, high/);
});

test("brain_tiers check is empty on a fresh vault; restore demands apply", async () => {
  const server = new MCPServer({ vault, configPath });
  await initialize(server);
  const checked = await call(server, "brain_tiers", { operation: "check" });
  expect(checked["findings"]).toEqual([]);
  await expect(
    call(server, "brain_tiers", { operation: "restore", path: "Brain/x.md" }),
  ).rejects.toThrow(/apply=true/);
});

test("brain_secrets lists metadata only and refuses a non-allowlisted run", async () => {
  setSecret(vault, {
    name: "api-key",
    value: "sk-mcp-secret-777",
    allow: ["bun -e *"],
    agent: "tester",
    now: new Date("2026-06-05T10:00:00Z"),
  });
  const server = new MCPServer({ vault, configPath });
  await initialize(server);

  const listed = await call(server, "brain_secrets", { operation: "list" });
  expect(JSON.stringify(listed)).not.toContain("sk-mcp-secret-777");
  expect((listed["secrets"] as Array<{ name: string }>)[0]!.name).toBe("api-key");

  await expect(
    call(server, "brain_secrets", {
      operation: "run",
      name: "api-key",
      command: ["bash", "-c", "env"],
    }),
  ).rejects.toThrow(/allowlist/);

  const ran = await call(server, "brain_secrets", {
    operation: "run",
    name: "api-key",
    command: ["bun", "-e", "console.log('v=' + process.env.API_KEY)"],
  });
  expect(ran["exit_code"]).toBe(0);
  expect(String(ran["stdout"])).not.toContain("sk-mcp-secret-777");
});

test("brain_maintenance run executes the lane; status reads the journal", async () => {
  const server = new MCPServer({ vault, configPath });
  await initialize(server);
  const ran = await call(server, "brain_maintenance", { operation: "run" });
  expect(ran["verdict"]).toBe("run");
  const tasks = ran["tasks"] as Array<{ name: string; ok: boolean }>;
  // Same lane contract as the CLI verb (link-recall-intelligence).
  expect(tasks.map((t) => t.name)).toEqual(["dream", "reindex", "bridges", "clusters"]);
  expect(tasks.every((t) => t.ok)).toBe(true);

  const status = await call(server, "brain_maintenance", { operation: "status" });
  expect(status["lease"]).toBeNull();
  expect((status["journal"] as unknown[]).length).toBeGreaterThanOrEqual(2);
});
