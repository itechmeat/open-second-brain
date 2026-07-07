import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { listContextPackOutcomes } from "../../src/core/brain/context-pack-outcome.ts";
import { listTokenImpactOutcomes } from "../../src/core/brain/token-impact.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";

let tmp: string;
let vault: string;
let configHome: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

function writeConfig(enabled: boolean): void {
  atomicWriteFileSync(
    configPath,
    `vault: ${vault}\nagent_name: claude\ncontext_pack_outcome_enabled: "${enabled}"\n`,
  );
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-ctx-outcome-tool-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  configHome = mkdtempSync(join(tmpdir(), "o2b-ctx-outcome-tool-cfg-"));
  configPath = join(configHome, "config.yaml");
  for (const key of [
    "VAULT_AGENT_NAME",
    "VAULT_TIMEZONE",
    "VAULT_DIR",
    "OPEN_SECOND_BRAIN_CONFIG",
    "OPEN_SECOND_BRAIN_CONTEXT_PACK_OUTCOME_ENABLED",
  ]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
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
      clientInfo: { name: "ctx-outcome-test", version: "0" },
    },
  });
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

describe("brain_context_pack_outcome registration", () => {
  test("registered in the full tool table only", () => {
    expect(
      buildToolTable("full").find((t) => t.name === "brain_context_pack_outcome"),
    ).toBeDefined();
    expect(
      buildToolTable("writer").find((t) => t.name === "brain_context_pack_outcome"),
    ).toBeUndefined();
  });
});

describe("brain_context_pack_outcome post gating", () => {
  test("gate off records nothing but reports enabled:false", async () => {
    writeConfig(false);
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const out = await callTool(server, "brain_context_pack_outcome", {
      operation: "post",
      sample_id: "receipt_1",
      first_pass_success: true,
    });
    expect(out["recorded"]).toBe(false);
    expect(out["enabled"]).toBe(false);
    expect(listContextPackOutcomes(vault)).toHaveLength(0);
    expect(listTokenImpactOutcomes(vault)).toHaveLength(0);
  });

  test("gate on records an outcome row and composes the token-impact ledger", async () => {
    writeConfig(true);
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const out = await callTool(server, "brain_context_pack_outcome", {
      operation: "post",
      sample_id: "receipt_1",
      first_pass_success: true,
      exact_prompt_token_savings: 680,
      modeled_inference_avoidance: 420,
      observed_provider_tokens: 1200,
    });
    expect(out["recorded"]).toBe(true);
    expect(out["sample_id"]).toBe("receipt_1");

    const rows = listContextPackOutcomes(vault);
    expect(rows).toHaveLength(1);
    // three signals as separate keys, never merged
    expect(rows[0]!.payload["exact_prompt_token_savings"]).toBe(680);
    expect(rows[0]!.payload["modeled_inference_avoidance"]).toBe(420);
    expect(rows[0]!.payload["observed_provider_tokens"]).toBe(1200);

    // composes C3
    const outcomes = listTokenImpactOutcomes(vault);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.payload).toMatchObject({
      outcome: "first_pass",
      pack_id: "receipt_1",
      tokens_per_inference: 1200,
    });
  });

  test("omit-don't-invent: unsupplied optional counters are absent", async () => {
    writeConfig(true);
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    await callTool(server, "brain_context_pack_outcome", {
      operation: "post",
      sample_id: "receipt_1",
      first_pass_success: true,
    });
    const payload = listContextPackOutcomes(vault)[0]!.payload;
    expect("retry_count" in payload).toBe(false);
    expect("exact_prompt_token_savings" in payload).toBe(false);
    expect("observed_provider_tokens" in payload).toBe(false);
  });

  test("rejects a missing first_pass_success", async () => {
    writeConfig(true);
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const response = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 9,
      method: "tools/call",
      params: {
        name: "brain_context_pack_outcome",
        arguments: { operation: "post", sample_id: "receipt_1" },
      },
    })) as { result?: { isError?: boolean }; error?: unknown };
    expect(response.error ?? response.result?.isError).toBeTruthy();
  });
});

describe("brain_context_pack_outcome summary reads even with the gate off", () => {
  test("summary keeps the three token signals separate", async () => {
    writeConfig(true);
    let server = new MCPServer({ vault, configPath });
    await initialize(server);
    await callTool(server, "brain_context_pack_outcome", {
      operation: "post",
      sample_id: "a",
      first_pass_success: true,
      exact_prompt_token_savings: 100,
    });
    await callTool(server, "brain_context_pack_outcome", {
      operation: "post",
      sample_id: "b",
      first_pass_success: false,
      repair_required: true,
      modeled_inference_avoidance: 50,
    });
    // flip the gate off — reads still work
    writeConfig(false);
    server = new MCPServer({ vault, configPath });
    await initialize(server);
    const summary = await callTool(server, "brain_context_pack_outcome", { operation: "summary" });
    expect(summary["total"]).toBe(2);
    expect(summary["first_pass_rate"]).toBe(0.5);
    const signals = summary["token_signals"] as Record<string, Record<string, unknown>>;
    expect(signals["exact"]!["prompt_token_savings"]).toBe(100);
    expect(signals["modeled"]!["inference_avoidance"]).toBe(50);
    expect(signals["observed"]!["samples"]).toBe(0);
  });

  test("rejects an unknown operation", async () => {
    writeConfig(true);
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const response = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 9,
      method: "tools/call",
      params: { name: "brain_context_pack_outcome", arguments: { operation: "bogus" } },
    })) as { result?: { isError?: boolean }; error?: unknown };
    expect(response.error ?? response.result?.isError).toBeTruthy();
  });
});
