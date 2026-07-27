/**
 * The plugin config is present and unreadable, and the caller comes in
 * through the SERVER rather than the tool table.
 *
 * `tests/mcp/config-read-failure-tools.test.ts` pinned what the two
 * diagnostic handlers say about that condition, and said in a comment why
 * it could not go through `MCPServer`: the request path resolved the agent
 * identity from the same config before any handler ran, so every one of
 * those payloads was thrown away and replaced by an error envelope. A fix
 * only the tool table can observe is not a fix.
 *
 * The separation asserted here is between operations that NEED the
 * resolved identity and operations that do not:
 *
 *   - the read-only diagnostics answer, with the broken file named in the
 *     fields that exist to name it;
 *   - a writer refuses, by name, before it writes - recording under a
 *     guessed identity is worse than not recording;
 *   - `initialize` completes without claiming an identity it could not
 *     resolve, because a handshake that fails takes every tool above with
 *     it, including the two whose job is to diagnose this.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";

const VALID_CONFIG = `vault: "/srv/example-vault"\nagent_name: "vps-agent"\n`;

let tmp: string;
let vault: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-server-config-read-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain", "inbox"), { recursive: true });
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, VALID_CONFIG, "utf8");
  for (const k of [
    "VAULT_DIR",
    "VAULT_AGENT_NAME",
    "OPEN_SECOND_BRAIN_CONFIG",
    "OPEN_SECOND_BRAIN_EXPOSE_HOST_PATHS",
    "OPEN_SECOND_BRAIN_MCP_ROUTE_METRICS_ENABLED",
  ]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  chmodSync(configPath, 0o600);
  rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

interface CallOutcome {
  readonly payload?: Record<string, unknown>;
  readonly toolError?: string;
  readonly rpcError?: string;
}

/** Run `fn` with the config file present but unopenable. */
function withUnreadableConfig<T>(fn: () => T): T {
  chmodSync(configPath, 0o000);
  try {
    return fn();
  } finally {
    chmodSync(configPath, 0o600);
  }
}

async function callThroughServer(
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallOutcome> {
  return await withUnreadableConfig(async () => {
    const server = new MCPServer({ vault, configPath });
    const response = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    })) as {
      result?: { content: ReadonlyArray<{ text: string }>; isError?: boolean };
      error?: { message: string };
    };
    if (response.error) return { rpcError: response.error.message };
    const text = response.result!.content[0]!.text;
    if (response.result!.isError) return { toolError: text };
    return { payload: JSON.parse(text) as Record<string, unknown> };
  });
}

function inboxSignalCount(): number {
  return readdirSync(join(vault, "Brain", "inbox")).filter((n) => n.startsWith("sig-")).length;
}

describe("the server survives a config it cannot read", () => {
  test("construction does not raise on the route-metrics gate", () => {
    withUnreadableConfig(() => {
      expect(() => new MCPServer({ vault, configPath })).not.toThrow();
    });
  });

  test("initialize completes without naming an identity it could not resolve", async () => {
    const response = await withUnreadableConfig(async () => {
      const server = new MCPServer({ vault, configPath });
      return (await server.handleRequest({
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "config-read-failure-server-test", version: "0" },
        },
      })) as { result?: { instructions: string }; error?: { message: string } };
    });
    expect(response.error).toBeUndefined();
    const instructions = response.result!.instructions;
    expect(instructions).toContain(configPath);
    // Never the built-in default, and never the name the unreadable file
    // happens to hold: an identity that could not be read is not an
    // identity, and stating one invites the agent to log under it.
    expect(instructions).not.toContain("You are @agent");
    expect(instructions).not.toContain("@vps-agent");
  });
});

describe("the read-only diagnostics answer through the request path", () => {
  test("vault_health returns the report naming the broken file", async () => {
    const { payload, toolError, rpcError } = await callThroughServer("vault_health");
    expect(rpcError).toBeUndefined();
    expect(toolError).toBeUndefined();
    const checks = payload!["checks"] as Array<Record<string, unknown>>;
    const configCheck = checks.find((c) => c["name"] === "config_writeable");
    expect(configCheck).toBeDefined();
    expect(configCheck!["ok"]).toBe(false);
    expect(String(configCheck!["message"])).toContain(configPath);
    expect(payload!["ok"]).toBe(false);
    // The same degraded field the handler-level test pins, now actually
    // reachable: an unresolvable store reference reports the reason and
    // never falls back to the raw host path.
    expect(String((payload!["vault_path"] as Record<string, unknown>)["error"])).toContain(
      configPath,
    );
    expect(JSON.stringify(payload!["vault_path"])).not.toContain(vault);
  });

  test("second_brain_status reports the condition instead of collapsing to absent", async () => {
    const { payload, toolError, rpcError } = await callThroughServer("second_brain_status");
    expect(rpcError).toBeUndefined();
    expect(toolError).toBeUndefined();
    expect(payload!["config_path"]).toBe(configPath);
    expect(payload!["config_exists"]).toBe(true);
    expect(String((payload!["config"] as Record<string, unknown>)["error"])).toContain(configPath);
  });
});

describe("a write tool refuses by name", () => {
  test("brain_feedback errors with the config named and records nothing", async () => {
    const { toolError, payload } = await callThroughServer("brain_feedback", {
      topic: "unreadable-plugin-config",
      signal: "positive",
      principle: "This must not be recorded under a guessed identity.",
    });
    expect(payload).toBeUndefined();
    expect(toolError).toBeDefined();
    expect(toolError!).toContain(configPath);
    expect(inboxSignalCount()).toBe(0);
  });
});
