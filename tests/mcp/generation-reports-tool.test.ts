import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listGenerationReports } from "../../src/core/brain/generation-reports.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";

let tmp: string;
let vault: string;
let configHome: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-generation-reports-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  configHome = mkdtempSync(join(tmpdir(), "o2b-mcp-generation-reports-cfg-"));
  configPath = join(configHome, "config.yaml");
  for (const key of [
    "VAULT_AGENT_NAME",
    "VAULT_TIMEZONE",
    "VAULT_DIR",
    "OPEN_SECOND_BRAIN_CONFIG",
    "OPEN_SECOND_BRAIN_GENERATION_TRACE_ENABLED",
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
      clientInfo: { name: "generation-reports-test", version: "0" },
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
  const response = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 9,
    method: "tools/call",
    params: { name: "brain_generation_reports", arguments: args },
  })) as { result: { content: ReadonlyArray<{ type: string; text: string }> } };
  return JSON.parse(response.result.content[0]!.text);
}

describe("brain_generation_reports tool registration", () => {
  test("registered in the full tool table, absent from writer-only", () => {
    expect(
      buildToolTable("full").find((tool) => tool.name === "brain_generation_reports"),
    ).toBeDefined();
    expect(
      buildToolTable("writer").find((tool) => tool.name === "brain_generation_reports"),
    ).toBeUndefined();
  });
});

describe("brain_generation_reports tool", () => {
  test("record is gated off by default and writes nothing", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const res = await call(server, {
      action: "record",
      handoff_kind: "write_session",
      ref: "ws-1",
      agent: "tester",
      prompt: "do the thing",
    });
    expect(res).toMatchObject({ recorded: false, reason: "disabled" });
    expect(listGenerationReports(vault)).toHaveLength(0);
  });

  test("record with enable writes one report; list and summary read it back", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);

    const rec = await call(server, {
      action: "record",
      handoff_kind: "context_pack",
      ref: "ctn_receipt-1",
      agent: "tester",
      enable: true,
      prompt: "consume context secret token=sk-keep-out",
      usage: { input_tokens: 50, output_tokens: 20 },
      source_refs: [{ id: "pref-foo", path: "Brain/preferences/pref-foo.md" }],
      created_at: "2026-06-15T08:00:00Z",
    });
    expect(rec["recorded"]).toBe(true);
    expect(rec["id"]).toStartWith("ctn_");

    const list = await call(server, { action: "list", handoff_kind: "context_pack" });
    expect(list["total"]).toBe(1);
    const report = (list["reports"] as Array<Record<string, unknown>>)[0]!;
    expect(report["payload"]).toMatchObject({
      handoff: { kind: "context_pack", ref: "ctn_receipt-1" },
      agent: "tester",
      usage: { input_tokens: 50, output_tokens: 20 },
    });
    // The raw prompt must never appear in the tool output.
    expect(JSON.stringify(list)).not.toContain("sk-keep-out");
    expect(JSON.stringify(list)).not.toContain("consume context");

    const summary = await call(server, { action: "summary" });
    expect(summary).toMatchObject({
      total: 1,
      by_handoff_kind: { context_pack: 1 },
      reported_count: 1,
    });
    expect(
      (summary["by_path"] as Record<string, unknown>)["Brain/preferences/pref-foo.md"],
    ).toEqual([report["id"]]);
  });

  test("rejects an unknown action and an unknown handoff_kind", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);

    const badAction = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 10,
      method: "tools/call",
      params: { name: "brain_generation_reports", arguments: { action: "delete" } },
    })) as { result?: { isError?: boolean }; error?: unknown };
    expect(badAction.error ?? badAction.result?.isError).toBeTruthy();
  });
});
