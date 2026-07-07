import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { listTokenImpact } from "../../src/core/brain/token-impact.ts";
import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";

let tmp: string;
let vault: string;
let configHome: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

function writeConfig(ledger: boolean): void {
  atomicWriteFileSync(
    configPath,
    `vault: ${vault}\nagent_name: claude\ntoken_impact_ledger_enabled: "${ledger}"\n`,
  );
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-token-impact-tool-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  configHome = mkdtempSync(join(tmpdir(), "o2b-token-impact-tool-cfg-"));
  configPath = join(configHome, "config.yaml");
  for (const key of [
    "VAULT_AGENT_NAME",
    "VAULT_TIMEZONE",
    "VAULT_DIR",
    "OPEN_SECOND_BRAIN_CONFIG",
    "OPEN_SECOND_BRAIN_TOKEN_IMPACT_LEDGER_ENABLED",
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
      clientInfo: { name: "token-impact-test", version: "0" },
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

describe("brain_token_impact registration", () => {
  test("registered in the full tool table only", () => {
    expect(buildToolTable("full").find((t) => t.name === "brain_token_impact")).toBeDefined();
    expect(buildToolTable("writer").find((t) => t.name === "brain_token_impact")).toBeUndefined();
  });
});

describe("brain_token_impact record gating", () => {
  test("gate off records nothing but reports enabled:false", async () => {
    writeConfig(false);
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const out = await callTool(server, "brain_token_impact", {
      operation: "record",
      baseline_tokens: 100,
      packed_tokens: 40,
      method: "exact",
    });
    expect(out["recorded"]).toBe(false);
    expect(out["enabled"]).toBe(false);
    expect(listTokenImpact(vault)).toHaveLength(0);
  });

  test("gate on records a tokenizer-exact delta", async () => {
    writeConfig(true);
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const out = await callTool(server, "brain_token_impact", {
      operation: "record",
      baseline_tokens: 1000,
      packed_tokens: 300,
      method: "exact",
      pack_id: "receipt_1",
    });
    expect(out["recorded"]).toBe(true);
    expect(out["delta_tokens"]).toBe(700);
    const records = listTokenImpact(vault);
    expect(records).toHaveLength(1);
    expect(records[0]!.payload["pack_id"]).toBe("receipt_1");
  });

  test("method defaults to fallback when omitted", async () => {
    writeConfig(true);
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const out = await callTool(server, "brain_token_impact", {
      operation: "record",
      baseline_tokens: 10,
      packed_tokens: 4,
    });
    expect(out["method"]).toBe("fallback");
  });

  test("rejects a missing count", async () => {
    writeConfig(true);
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const response = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 9,
      method: "tools/call",
      params: {
        name: "brain_token_impact",
        arguments: { operation: "record", baseline_tokens: 1 },
      },
    })) as { result?: { isError?: boolean }; error?: unknown };
    expect(response.error ?? response.result?.isError).toBeTruthy();
  });
});

describe("brain_token_impact exact-vs-modeled summary + calibration", () => {
  test("summary keeps exact and modeled separate; outcomes calibrate the model", async () => {
    writeConfig(true);
    const server = new MCPServer({ vault, configPath });
    await initialize(server);

    await callTool(server, "brain_token_impact", {
      operation: "record",
      baseline_tokens: 800,
      packed_tokens: 200,
      method: "exact",
      modeled_avoided_inferences: 2,
      modeled_tokens_per_inference: 1000,
    });
    // 3 first-pass, 1 retry -> first_pass_rate 0.75.
    await callTool(server, "brain_token_impact", { operation: "outcome", outcome: "first_pass" });
    await callTool(server, "brain_token_impact", { operation: "outcome", outcome: "first_pass" });
    await callTool(server, "brain_token_impact", { operation: "outcome", outcome: "first_pass" });
    await callTool(server, "brain_token_impact", { operation: "outcome", outcome: "retry" });

    const summary = await callTool(server, "brain_token_impact", { operation: "summary" });
    const delta = summary["prompt_token_delta"] as Record<string, unknown>;
    expect(delta["net_savings_tokens"]).toBe(600);
    const modeled = summary["modeled_inference_avoidance"] as Record<string, unknown>;
    expect(modeled["raw_savings_tokens"]).toBe(2000);
    expect(modeled["calibrated_savings_tokens"]).toBe(1500); // 2000 * 0.75
    const cal = modeled["calibration"] as Record<string, unknown>;
    expect(cal["first_pass_rate"]).toBe(0.75);
  });

  test("list and summary read even with the gate off", async () => {
    // Write with the gate on...
    writeConfig(true);
    let server = new MCPServer({ vault, configPath });
    await initialize(server);
    await callTool(server, "brain_token_impact", {
      operation: "record",
      baseline_tokens: 50,
      packed_tokens: 10,
      method: "fallback",
    });
    // ...then flip the gate off and confirm reads still work.
    writeConfig(false);
    server = new MCPServer({ vault, configPath });
    await initialize(server);
    const list = await callTool(server, "brain_token_impact", { operation: "list" });
    expect(list["total"]).toBe(1);
    const summary = await callTool(server, "brain_token_impact", { operation: "summary" });
    expect((summary["prompt_token_delta"] as Record<string, unknown>)["net_savings_tokens"]).toBe(
      40,
    );
  });

  test("rejects an unknown operation", async () => {
    writeConfig(true);
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const response = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 9,
      method: "tools/call",
      params: { name: "brain_token_impact", arguments: { operation: "bogus" } },
    })) as { result?: { isError?: boolean }; error?: unknown };
    expect(response.error ?? response.result?.isError).toBeTruthy();
  });
});
