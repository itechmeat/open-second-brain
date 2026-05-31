import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emitRecallTelemetry } from "../../src/core/brain/recall-telemetry.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { BRAIN_CONFIDENCE, BRAIN_PREFERENCE_STATUS } from "../../src/core/brain/types.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";

let tmp: string;
let vault: string;
let configHome: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-recall-telemetry-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  configHome = mkdtempSync(join(tmpdir(), "o2b-mcp-recall-telemetry-cfg-"));
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
      clientInfo: { name: "recall-telemetry-test", version: "0" },
    },
  });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    method: "notifications/initialized",
  });
}

async function callTelemetry(
  server: MCPServer,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return callTool(server, "brain_recall_telemetry", args);
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

describe("brain_recall_telemetry tool registration", () => {
  test("registered in the full tool table only", () => {
    expect(
      buildToolTable("full").find((tool) => tool.name === "brain_recall_telemetry"),
    ).toBeDefined();
    expect(
      buildToolTable("writer").find((tool) => tool.name === "brain_recall_telemetry"),
    ).toBeUndefined();
  });
});

describe("brain_recall_telemetry tool", () => {
  test("lists records and summarizes recall gaps", async () => {
    emitRecallTelemetry(vault, {
      createdAt: "2026-05-20T16:00:00.000Z",
      host: "mcp-test",
      mode: "context_pack",
      status: "ok",
      durationMs: 4,
      resultCount: 1,
      topArtifacts: [{ id: "pref-alpha" }],
    });
    emitRecallTelemetry(vault, {
      createdAt: "2026-05-20T16:01:00.000Z",
      host: "mcp-test",
      mode: "search",
      status: "empty",
      durationMs: 9,
      resultCount: 0,
      gaps: ["missing_recent_decision"],
    });

    const server = new MCPServer({ vault, configPath });
    await initialize(server);

    const list = await callTelemetry(server, {
      operation: "list",
      mode: "context_pack",
    });
    expect(list["total"]).toBe(1);
    expect((list["records"] as Array<Record<string, unknown>>)[0]!["payload"]).toMatchObject({
      mode: "context_pack",
      result_count: 1,
    });

    const summary = await callTelemetry(server, {
      operation: "summary",
      host: "mcp-test",
    });
    expect(summary).toMatchObject({
      total: 2,
      by_mode: { context_pack: 1, search: 1 },
      by_status: { ok: 1, empty: 1 },
      total_results: 1,
      empty_runs: 1,
      gap_counts: { missing_recent_decision: 1 },
    });
  });

  test("context-pack and pre-compress tools can opt in to telemetry", async () => {
    writePreference(vault, {
      slug: "alpha",
      topic: "alpha",
      principle: "Prefer crisp answers",
      created_at: "2026-05-20T00:00:00.000Z",
      unconfirmed_until: "2026-05-21T00:00:00.000Z",
      status: BRAIN_PREFERENCE_STATUS.confirmed,
      evidenced_by: ["[[sig-2026-05-20-alpha]]"],
      confirmed_at: "2026-05-20T01:00:00.000Z",
      applied_count: 1,
      violated_count: 0,
      last_evidence_at: "2026-05-20T01:00:00.000Z",
      confidence: BRAIN_CONFIDENCE.high,
      confidence_value: 0.9,
    });
    const server = new MCPServer({ vault, configPath });
    await initialize(server);

    const contextPack = await callTool(server, "brain_context_pack", {
      max_tokens: 10000,
      telemetry: true,
      telemetry_host: "mcp-test",
    });
    expect(contextPack["telemetry_id"]).toStartWith("ctn_");

    const preCompress = await callTool(server, "brain_pre_compress_pack", {
      telemetry: true,
      telemetry_host: "mcp-test",
    });
    expect(preCompress["telemetry_id"]).toStartWith("ctn_");

    const summary = await callTelemetry(server, {
      operation: "summary",
      host: "mcp-test",
    });
    expect(summary).toMatchObject({
      total: 2,
      by_mode: { context_pack: 1, pre_compress: 1 },
      by_status: { ok: 2 },
    });
  });
});
