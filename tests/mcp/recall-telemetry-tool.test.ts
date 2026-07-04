import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emitRecallTelemetry } from "../../src/core/brain/recall-telemetry.ts";
import { recordHostMemoryWrite } from "../../src/core/brain/host-memory-write.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { BRAIN_CONFIDENCE, BRAIN_PREFERENCE_STATUS } from "../../src/core/brain/types.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { INVALID_PARAMS } from "../../src/mcp/protocol.ts";
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

  test("context-pack and pre-compress tools can opt in to receipts and telemetry", async () => {
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
      receipt: true,
      receipt_host: "mcp-test",
      telemetry: true,
      telemetry_host: "mcp-test",
    });
    expect(contextPack["receipt_id"]).toStartWith("ctn_");
    expect(contextPack["telemetry_id"]).toStartWith("ctn_");

    const preCompress = await callTool(server, "brain_pre_compress_pack", {
      receipt: true,
      receipt_host: "mcp-test",
      telemetry: true,
      telemetry_host: "mcp-test",
    });
    expect(preCompress["receipt_id"]).toStartWith("ctn_");
    expect(preCompress["telemetry_id"]).toStartWith("ctn_");

    const receipts = await callTool(server, "brain_context_receipts", {
      operation: "list",
      host: "mcp-test",
    });
    expect(receipts["total"]).toBe(2);
    expect(
      (receipts["receipts"] as Array<Record<string, unknown>>)
        .map((receipt) => receipt["trigger"])
        .toSorted(),
    ).toEqual(["context_pack", "pre_compress"]);

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

  test("cost meter folds write volume against reads", async () => {
    recordHostMemoryWrite(vault, {
      action: "add",
      target: "memory",
      content: "one",
      createdAt: "2026-05-20T09:00:00.000Z",
    });
    recordHostMemoryWrite(vault, {
      action: "add",
      target: "memory",
      content: "two",
      createdAt: "2026-05-20T09:01:00.000Z",
    });
    emitRecallTelemetry(vault, {
      createdAt: "2026-05-20T09:02:00.000Z",
      host: "mcp-test",
      mode: "search",
      status: "ok",
      durationMs: 3,
      resultCount: 1,
    });

    const server = new MCPServer({ vault, configPath });
    await initialize(server);

    const meter = await callTelemetry(server, {
      operation: "cost",
      write_cost: 2,
      read_cost: 1,
    });
    expect(meter).toMatchObject({
      write_read_ratio: 2, // 2 host writes / 1 read
      write_heavy: true,
      cost: { write: 4, read: 1, total: 5 },
    });
    expect((meter["writes"] as Record<string, unknown>)["by_kind"]).toEqual({
      host_memory_write: 2,
    });
  });

  test("cost meter rejects a negative weight", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const response = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 9,
      method: "tools/call",
      params: {
        name: "brain_recall_telemetry",
        arguments: { operation: "cost", write_cost: -1 },
      },
    })) as { result?: { isError?: boolean }; error?: unknown };
    // Invalid params surface as a tool error rather than a valid meter.
    expect(response.error ?? response.result?.isError).toBeTruthy();
  });

  test("cost meter rejects read-side-only filters (mode/status/host/limit)", async () => {
    // Parity with the CLI: mode/status/host/limit filter recall records only
    // and have no write-side analogue. They must be rejected for the cost
    // meter, not silently ignored as a valid filtered result.
    for (const field of ["mode", "status", "host", "limit"]) {
      const server = new MCPServer({ vault, configPath });
      await initialize(server);
      const response = (await server.handleRequest({
        jsonrpc: JSONRPC_VERSION,
        id: 9,
        method: "tools/call",
        params: {
          name: "brain_recall_telemetry",
          arguments: { operation: "cost", [field]: "search" },
        },
      })) as { error?: { code: number; message: string } };
      expect(response.error?.code).toBe(INVALID_PARAMS);
      expect(response.error?.message).toContain(field);
    }
  });
});
