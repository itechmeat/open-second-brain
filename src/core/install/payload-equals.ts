import { buildPayload } from "./payload.ts";
import type { InstallEnv, McpPayload, McpServerEntry } from "./types.ts";

export function expectedPayloadFromEnv(env: InstallEnv): McpPayload {
  return buildPayload({
    vault: env.vault,
    agent_name: env.env["VAULT_AGENT_NAME"] ?? null,
    timezone: env.env["VAULT_TIMEZONE"] ?? null,
  });
}

export function payloadKeyEquals(
  current: Record<string, unknown> | undefined,
  expected: McpServerEntry,
): boolean {
  if (!current) return false;
  if (current["command"] !== expected.command) return false;
  const args = current["args"];
  if (!Array.isArray(args) || args.length !== expected.args.length) return false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== expected.args[i]) return false;
  }
  const env = current["env"];
  if (expected.env) {
    if (!env || typeof env !== "object") return false;
    const e = env as Record<string, unknown>;
    const expectedKeys = Object.keys(expected.env).toSorted();
    const actualKeys = Object.keys(e).toSorted();
    if (expectedKeys.length !== actualKeys.length) return false;
    for (const k of expectedKeys) {
      if (e[k] !== expected.env[k]) return false;
    }
  } else if (env !== undefined) {
    return false;
  }
  return true;
}
