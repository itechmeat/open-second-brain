/**
 * v0.10.16 MCP wrapper coverage: brain_dream and brain_doctor now
 * surface the trust-layer fields that landed on the core
 * `DreamRunSummary` and `RunDoctorResult` structs. Prevents future
 * regressions where the core type carries a field but the wrapper
 * silently drops it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { resetVaultIdentityPins, writeVaultIdentity } from "../../src/core/brain/vault-identity.ts";

let tmp: string;
let vault: string;
let configHome: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-trust-fields-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
  mkdirSync(join(vault, "Brain", "inbox"), { recursive: true });
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n");
  configHome = mkdtempSync(join(tmpdir(), "o2b-mcp-trust-fields-cfg-"));
  configPath = join(configHome, "config.yaml");
  for (const k of ["VAULT_AGENT_NAME", "VAULT_TIMEZONE", "VAULT_DIR", "OPEN_SECOND_BRAIN_CONFIG"]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  resetVaultIdentityPins();
});

afterEach(() => {
  resetVaultIdentityPins();
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
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "trust-fields-test", version: "0" },
    },
  });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    method: "notifications/initialized",
  });
}

async function callTool(
  server: MCPServer,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const r = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 9,
    method: "tools/call",
    params: { name, arguments: args },
  })) as { result: { content: ReadonlyArray<{ type: string; text: string }> } };
  return JSON.parse(r.result.content[0]!.text);
}

describe("brain_dream MCP wrapper - trust fields", () => {
  test("no-op run emits empty uncertain[] and quarantined[]", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const out = await callTool(server, "brain_dream", {});
    expect(out["uncertain"]).toEqual([]);
    expect(out["quarantined"]).toEqual([]);
    expect(out["suppressed"]).toEqual([]);
  });
});

describe("brain_doctor MCP wrapper - trust fields", () => {
  test("clean vault emits trust_verdict=clean and empty instruction_file_warnings", async () => {
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const out = await callTool(server, "brain_doctor", {});
    expect(out["trust_verdict"]).toBe("clean");
    expect(out["instruction_file_warnings"]).toEqual([]);
  });

  test("the uncertain stream reaches an MCP caller, not only the terminal", async () => {
    // The whole degradation stream - frontmatter lines the scanner
    // dropped, lineage-ledger findings, an unmarked vault root, stale
    // writer locks - was rendered by the CLI alone. An agent driving the
    // doctor over MCP could not see any of it.
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const out = await callTool(server, "brain_doctor", {});
    const uncertain = out["uncertain"] as Array<{
      code: string;
      path?: string;
      message: string;
    }>;
    expect(Array.isArray(uncertain)).toBe(true);
    // This fixture builds the Brain tree by hand, so it carries no
    // identity marker - the exact shape a mis-resolved root takes.
    const marker = uncertain.find((u) => u.code === "vault-marker-absent");
    expect(marker).toBeDefined();
    expect(marker!.message.length).toBeGreaterThan(0);
  });

  test("a frontmatter drop reaches brain_doctor under its own code", async () => {
    mkdirSync(join(vault, "Brain", "notes"), { recursive: true });
    writeFileSync(
      join(vault, "Brain", "notes", "odd.md"),
      "---\ntitle: Odd\ntopic: odd\n-foo\n---\n\nBody.\n",
    );
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const out = await callTool(server, "brain_doctor", {});
    const uncertain = out["uncertain"] as Array<{ code: string; path?: string }>;
    const hit = uncertain.find((u) => u.code === "frontmatter-line-dropped");
    expect(hit).toBeDefined();
    // Paths are vault-relative on the wire, exactly like errors/warnings.
    expect(hit!.path).toBe("Brain/notes/odd.md");
  });

  test("a vault with nothing uncertain omits the key entirely", async () => {
    writeVaultIdentity(vault);
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const out = await callTool(server, "brain_doctor", {});
    expect(Object.hasOwn(out, "uncertain")).toBe(false);
  });

  test("long CLAUDE.md surfaces instruction_file_warnings via brain_doctor", async () => {
    writeFileSync(join(vault, "CLAUDE.md"), "line\n".repeat(300));
    const server = new MCPServer({ vault, configPath });
    await initialize(server);
    const out = await callTool(server, "brain_doctor", {});
    const warnings = out["instruction_file_warnings"] as Array<{ path: string; lines: number }>;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.path).toBe("CLAUDE.md");
    expect(warnings[0]?.lines).toBe(300);
  });
});
