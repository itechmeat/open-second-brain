/**
 * Link & Recall Intelligence Suite MCP tools: brain_bridges
 * (discover/list/accept/dismiss over the vec index), brain_clusters
 * (community detection + derived notes), brain_benchmark (fixed
 * dataset scoring), brain_tune (bounded self-tuning lifecycle).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { listMetrics } from "../../src/core/brain/metrics.ts";
import { indexVault } from "../../src/core/search/indexer.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { makeConfig } from "../helpers/search-fixtures.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";

let tmp: string;
let vault: string;
let configHome: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-lri-"));
  vault = join(tmp, "vault");
  configHome = mkdtempSync(join(tmpdir(), "o2b-mcp-lri-cfg-"));
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
      clientInfo: { name: "lri-test", version: "0" },
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

async function callError(
  server: MCPServer,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ code: number; message: string }> {
  const res = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 100,
    method: "tools/call",
    params: { name: tool, arguments: args },
  })) as { error?: { code: number; message: string } };
  expect(res.error).toBeDefined();
  return res.error!;
}

function writeGroup(): void {
  const group = ["team-a", "team-b", "team-c", "team-d"];
  for (const name of group) {
    const others = group
      .filter((g) => g !== name)
      .map((g) => `[[${g}]]`)
      .join(" ");
    writeFileSync(join(vault, `${name}.md`), `# ${name}\n\nSee ${others}.\n`);
  }
  writeFileSync(join(vault, "canary.md"), "# Canary rollout\n\nShip one instance first.\n");
}

async function indexDefaultLocation(): Promise<void> {
  await indexVault(
    makeConfig({ vault, dbPath: join(vault, ".open-second-brain", "brain.sqlite") }),
  );
}

const DATASET = {
  queries: [{ id: "canary", query: "canary rollout", expected: ["canary.md"] }],
};

test("brain_bridges validates params before touching the environment", async () => {
  const server = new MCPServer({ vault, configPath });
  await initialize(server);
  const bad = await callError(server, "brain_bridges", { operation: "accept", source: "a.md" });
  expect(bad.code).toBe(-32602);
  expect(bad.message).toMatch(/target/);
  const badOp = await callError(server, "brain_bridges", { operation: "nope" });
  expect(badOp.code).toBe(-32602);
});

test("brain_bridges discover fails soft without an index, dismiss/list round-trip", async () => {
  const server = new MCPServer({ vault, configPath });
  await initialize(server);

  const discover = await call(server, "brain_bridges", { operation: "discover" });
  expect(discover["vec_available"]).toBe(false);

  const dismissed = await call(server, "brain_bridges", {
    operation: "dismiss",
    source: "a.md",
    target: "b.md",
  });
  expect(dismissed["added"]).toBe(true);

  const list = await call(server, "brain_bridges", { operation: "list" });
  expect(list["exists"]).toBe(false);
});

test("brain_bridges accept writes the related wikilink through the vault boundary", async () => {
  writeGroup();
  const server = new MCPServer({ vault, configPath });
  await initialize(server);
  const accepted = await call(server, "brain_bridges", {
    operation: "accept",
    source: "team-a.md",
    target: "canary.md",
  });
  expect(accepted["changed"]).toBe(true);

  const escape = await callError(server, "brain_bridges", {
    operation: "accept",
    source: "../outside.md",
    target: "canary.md",
  });
  expect(escape.code).toBe(-32602);
});

test("brain_clusters run materializes derived notes and the metric", async () => {
  writeGroup();
  await indexDefaultLocation();
  const server = new MCPServer({ vault, configPath });
  await initialize(server);

  const run = await call(server, "brain_clusters", { operation: "run" });
  const communities = run["communities"] as Array<{ size: number }>;
  expect(communities).toHaveLength(1);
  expect(communities[0]!.size).toBe(4);
  expect(listMetrics(vault, { surface: "communities" })).toHaveLength(1);

  const list = await call(server, "brain_clusters", { operation: "list" });
  expect(list["clusters"]).toHaveLength(1);

  const bad = await callError(server, "brain_clusters", { operation: "run", min_size: 1 });
  expect(bad.code).toBe(-32602);
});

test("brain_benchmark run scores an inline dataset and records the metric", async () => {
  writeGroup();
  await indexDefaultLocation();
  const server = new MCPServer({ vault, configPath });
  await initialize(server);

  const report = await call(server, "brain_benchmark", { operation: "run", dataset: DATASET });
  expect(report["total"]).toBe(1);
  expect(report["hit_at_k"]).toBe(1);
  expect(listMetrics(vault, { surface: "recall_benchmark" })).toHaveLength(1);

  const bad = await callError(server, "brain_benchmark", {
    operation: "run",
    dataset: { queries: [] },
  });
  expect(bad.code).toBe(-32602);
});

test("brain_tune run/status/reset lifecycle", async () => {
  writeGroup();
  await indexDefaultLocation();
  const server = new MCPServer({ vault, configPath });
  await initialize(server);

  const before = await call(server, "brain_tune", { operation: "status" });
  expect(before["tuned"]).toBeNull();

  // The full grid report exceeds the preview budget and arrives as an
  // artifact envelope; the persisted file is the source of truth.
  const run = await call(server, "brain_tune", { operation: "run", dataset: DATASET });
  expect(run["preview_truncated"] === true || Array.isArray(run["evaluated"])).toBe(true);
  const persisted = JSON.parse(
    readFileSync(join(vault, "Brain", "search", "tuning.json"), "utf8"),
  ) as { evaluated: unknown[] };
  expect(persisted.evaluated).toHaveLength(24);
  expect(listMetrics(vault, { surface: "self_tuning" })).toHaveLength(1);

  const status = await call(server, "brain_tune", { operation: "status" });
  expect(status["tuned"]).not.toBeNull();
  expect(status["enabled"]).toBe(false);

  const reset = await call(server, "brain_tune", { operation: "reset" });
  expect(reset["removed"]).toBe(true);

  const missingDataset = await callError(server, "brain_tune", { operation: "run" });
  expect(missingDataset.code).toBe(-32602);
});
