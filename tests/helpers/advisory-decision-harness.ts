/**
 * Harness for the advisory decision-model uses end to end (issue #213,
 * Parts 5 and 6): an MCP server over a temp vault, a config file written
 * next to it, a loopback fake `/v1/systemone` server and a counting
 * `fetch`. Tests prove the four activation cases with it:
 *
 *   1. no decision config at all;
 *   2. the key is in the environment, but the feature is not enabled;
 *   3. the feature is enabled, but the key variable is not set;
 *   4. enabled AND the key is set.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import { FAKE_DECISION_KEY } from "./fake-credentials.ts";
import type { FakeSystemOne } from "./fake-decision-provider.ts";

export const ADVISORY_KEY_VAR = "O2B_TEST_DECISION_ADVISORY_KEY";

/** Write a flat config file inside the vault's parent-free area. */
export function writeConfig(dir: string, entries: Record<string, string>): string {
  const path = join(dir, ".o2b-test-config.yaml");
  writeFileSync(
    path,
    Object.entries(entries)
      .map(([k, v]) => `${k}: "${v}"`)
      .join("\n") + "\n",
  );
  return path;
}

export function decisionEntries(server: FakeSystemOne, uses: string): Record<string, string> {
  return {
    decision_model_enabled: "true",
    decision_model_provider: "compatible",
    decision_model_threshold_profile: "jev-1.13",
    decision_model_id: "fake-model-1",
    decision_model_env_key: ADVISORY_KEY_VAR,
    decision_model_base_url: server.url,
    decision_model_uses: uses,
  };
}

export function setKey(on: boolean): void {
  if (on) process.env[ADVISORY_KEY_VAR] = FAKE_DECISION_KEY;
  else delete process.env[ADVISORY_KEY_VAR];
}

export async function mcpServer(vault: string, configPath: string): Promise<MCPServer> {
  const server = new MCPServer({ vault, configPath });
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "advisory-test", version: "0" },
    },
  });
  await server.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
  return server;
}

export interface ToolReply {
  readonly payload: Record<string, unknown> | null;
  readonly isError: boolean;
  readonly text: string;
}

export async function callTool(
  server: MCPServer,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolReply> {
  const response = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 9,
    method: "tools/call",
    params: { name, arguments: args },
  })) as {
    result?: { content: ReadonlyArray<{ text: string }>; isError?: boolean };
    error?: { message: string };
  };
  if (response.error !== undefined) {
    return { payload: null, isError: true, text: response.error.message };
  }
  const text = response.result!.content[0]!.text;
  let payload: Record<string, unknown> | null = null;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    payload = null;
  }
  if (payload !== null && payload["preview_truncated"] === true && name !== "brain_artifact_get") {
    // A large result arrives as a preview envelope; read the full payload.
    const full = await callTool(server, "brain_artifact_get", {
      artifact_id: payload["artifact_id"],
    });
    const content = full.payload?.["content"];
    if (typeof content === "string") {
      return {
        payload: JSON.parse(content),
        isError: response.result!.isError === true,
        text: content,
      };
    }
  }
  return { payload, isError: response.result!.isError === true, text };
}

/** Count `fetch` calls for the duration of a test; returns the restore. */
export function countFetch(): { readonly calls: () => number; readonly restore: () => void } {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    calls++;
    return real(...args);
  }) as typeof fetch;
  return {
    calls: () => calls,
    restore: () => {
      globalThis.fetch = real;
    },
  };
}
