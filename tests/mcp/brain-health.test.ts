/**
 * brain_health MCP tool (F6 surface): returns the semantic-health
 * report (contradiction / concept-gap / stale-claim domains + verdict)
 * produced by runDoctor's reconciliation pass. Read-only.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { BRAIN_PREFERENCE_STATUS, BRAIN_SIGNAL_SIGN } from "../../src/core/brain/types.ts";

let tmp: string;
let vault: string;
let configHome: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-health-"));
  vault = join(tmp, "vault");
  for (const d of ["preferences", "retired", "inbox", "processed", "log"]) {
    mkdirSync(join(vault, "Brain", d), { recursive: true });
  }
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n");
  configHome = mkdtempSync(join(tmpdir(), "o2b-mcp-health-cfg-"));
  configPath = join(configHome, "config.yaml");
  for (const k of ["VAULT_AGENT_NAME", "VAULT_TIMEZONE", "VAULT_DIR", "OPEN_SECOND_BRAIN_CONFIG"]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function initialize(server: MCPServer): Promise<void> {
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "health-test", version: "0" } },
  });
  await server.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
}

async function callTool(server: MCPServer, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 9,
    method: "tools/call",
    params: { name, arguments: args },
  })) as { result: { content: ReadonlyArray<{ type: string; text: string }> } };
  return JSON.parse(r.result.content[0]!.text);
}

describe("brain_health MCP tool", () => {
  test("clean vault returns a clean verdict and empty domains", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const out = await callTool(server, "brain_health", {});
    expect(out["verdict"]).toBe("clean");
    expect(out["contradictions"]).toEqual([]);
    expect(out["concept_gaps"]).toEqual([]);
    expect(out["stale_claims"]).toEqual([]);
  });

  test("contradictory preferences surface with an investigate verdict", async () => {
    const pos = writeSignal(vault, {
      topic: "indentation", signal: BRAIN_SIGNAL_SIGN.positive, agent: "t",
      principle: "use tabs", created_at: "2026-05-01T00:00:00Z", date: "2026-05-01", slug: "tabs-pos",
    }).id;
    const neg = writeSignal(vault, {
      topic: "indentation", signal: BRAIN_SIGNAL_SIGN.negative, agent: "t",
      principle: "use spaces", created_at: "2026-05-01T00:00:00Z", date: "2026-05-01", slug: "tabs-neg",
    }).id;
    for (const [slug, principle, ev] of [
      ["tabs-rule", "always indent source with tabs not spaces", pos],
      ["spaces-rule", "never indent source with tabs always spaces", neg],
    ] as const) {
      writePreference(vault, {
        slug, topic: slug, principle,
        created_at: "2026-05-01T00:00:00Z", unconfirmed_until: "2026-05-08T00:00:00Z",
        confirmed_at: "2026-05-08T00:00:00Z", status: BRAIN_PREFERENCE_STATUS.confirmed,
        evidenced_by: [`[[${ev}]]`],
      }, { overwrite: true });
    }
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const out = await callTool(server, "brain_health", {});
    expect(out["verdict"]).toBe("investigate");
    expect((out["contradictions"] as unknown[]).length).toBe(1);
  });
});
