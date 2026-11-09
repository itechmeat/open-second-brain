/**
 * A server with no vault (task 2.10, design D14): the MCP server refuses
 * a tool that needs a vault by name with a stable code, on the in-process
 * call and on the JSON-RPC transport, and reads the agent token map from
 * device config, falling back to the per-vault file. Its status answer is
 * owned by `no-vault-memory-tools.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import type { ArtifactStore } from "../../src/mcp/artifact-store.ts";
import { machineStateRoot } from "../../src/core/state/machine-state.ts";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { tokenStorePath } from "../../src/core/brain/secrets/store.ts";
import { mintAgentToken } from "../../src/core/brain/secrets/token-store.ts";
import { MCPServer } from "../../src/mcp/server.ts";
import { MCPError } from "../../src/mcp/protocol.ts";
import { VAULT_REQUIRED_CODE } from "../../src/mcp/tool-contract.ts";
import {
  deviceTokenStorePath,
  hasAnyMcpToken,
  resolveMcpToken,
} from "../../src/mcp/token-source.ts";

let parent: string;
let configPath: string;
const saved = new Map<string, string | undefined>();
const KEYS = ["OPEN_SECOND_BRAIN_CONFIG", "VAULT_DIR", "HOME", "XDG_STATE_HOME", "LOCALAPPDATA"];

beforeEach(() => {
  for (const key of KEYS) saved.set(key, process.env[key]);
  parent = mkdtempSync(join(tmpdir(), "osb-no-vault-mcp-"));
  configPath = join(parent, "config", "config.yaml");
  mkdirSync(join(parent, "config"), { recursive: true });
  writeFileSync(configPath, "agent_name: tester\n");
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
  delete process.env["VAULT_DIR"];
  process.env["HOME"] = join(parent, "home");
  process.env["XDG_STATE_HOME"] = join(parent, "state");
  process.env["LOCALAPPDATA"] = join(parent, "state");
});

afterEach(() => {
  for (const key of KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("an MCP server with no vault", () => {
  test("refuses a tool that needs a vault by name with the vault_required code", async () => {
    const server = new MCPServer({ vault: null, configPath });
    // A vault-adapter tool and a note writer: both need the user's notes.
    for (const [tool, args] of [
      ["second_brain_query", {}],
      ["brain_create_note", { path: "notes/a.md", content: "x" }],
    ] as const) {
      let caught: unknown;
      try {
        await server.callTool(tool, args);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(MCPError);
      expect((caught as MCPError).message).toContain(`\`${tool}\` needs a vault`);
      expect((caught as MCPError).data).toMatchObject({ code: VAULT_REQUIRED_CODE });
    }
  });

  test("answers a JSON-RPC tools/call refusal instead of failing the transport", async () => {
    const server = new MCPServer({ vault: null, configPath });
    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "second_brain_query", arguments: {} },
    });
    expect(JSON.stringify(response)).toContain("needs a vault");
  });
});

describe("the agent token map", () => {
  test("a server with no vault has no tokens until device config holds them", () => {
    expect(hasAnyMcpToken({ vault: null, configPath })).toBe(false);
  });

  test("the per-vault file serves a server with the vault, the device-config copy one without", () => {
    const vault = join(parent, "vault");
    mkdirSync(vault, { recursive: true });
    writeFileSync(configPath, `vault: ${vault}\nagent_name: tester\n`);
    bootstrapBrain(vault);
    const { tokenMaterial } = mintAgentToken(vault, "mcp_token_codex", "codex");
    expect(hasAnyMcpToken({ vault, configPath })).toBe(true);
    expect(resolveMcpToken({ vault, configPath }, tokenMaterial)).toMatchObject({
      agent: "codex",
    });
    expect(resolveMcpToken({ vault: null, configPath }, tokenMaterial)).toBeNull();
    // As the migration does: the per-vault map copied to device config.
    copyFileSync(tokenStorePath(vault), deviceTokenStorePath(configPath));
    expect(resolveMcpToken({ vault: null, configPath }, tokenMaterial)).toMatchObject({
      agent: "codex",
    });
  });

  test("a server with a vault reads the per-vault file even when a device-config copy exists", () => {
    const vault = join(parent, "vault");
    mkdirSync(vault, { recursive: true });
    writeFileSync(configPath, `vault: ${vault}\nagent_name: tester\n`);
    bootstrapBrain(vault);
    const { tokenMaterial: copied } = mintAgentToken(vault, "mcp_token_codex", "codex");
    copyFileSync(tokenStorePath(vault), deviceTokenStorePath(configPath));
    // A token minted into the per-vault file after the copy is honoured: the
    // writers write that file, so reading a stale copy would hide new tokens
    // and keep revoked ones valid.
    const { tokenMaterial: vaultOnly } = mintAgentToken(vault, "mcp_token_edge", "edge");
    expect(resolveMcpToken({ vault, configPath }, copied)).toMatchObject({ agent: "codex" });
    expect(resolveMcpToken({ vault, configPath }, vaultOnly)).toMatchObject({ agent: "edge" });
    // An empty device map changes nothing for a server with a vault.
    writeFileSync(deviceTokenStorePath(configPath), JSON.stringify({ tokens: {} }, null, 2));
    expect(hasAnyMcpToken({ vault, configPath })).toBe(true);
  });
});

describe("the artifact store of a server with no vault", () => {
  test("keeps payloads in this machine's no-vault state, never a per-vault folder", () => {
    const server = new MCPServer({ vault: null, configPath });
    const store = (server as unknown as { artifactStore: ArtifactStore }).artifactStore;
    const { path } = store.put("payload");
    expect(path.startsWith(join(machineStateRoot(null), ""))).toBe(true);
    expect(path).not.toContain(`${sep}fresh${sep}`);
  });
});

describe("skills with no vault", () => {
  test("skills_attach with usage ordering on answers instead of refusing", async () => {
    writeFileSync(
      configPath,
      'agent_name: tester\nskill_auto_attach: "true"\nskills_attach_usage_ordering: "true"\n',
    );
    const server = new MCPServer({ vault: null, configPath });
    const result = (await server.callTool("skills_attach", { query: "set up search" })) as {
      content: ReadonlyArray<{ text: string }>;
    };
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ enabled: true });
  });
});
