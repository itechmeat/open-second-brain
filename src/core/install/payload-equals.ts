import { buildPayload } from "./payload.ts";
import type { InstallEnv, McpPayload, McpServerEntry } from "./types.ts";

export function expectedPayloadFromEnv(env: InstallEnv): McpPayload {
  return buildPayload({
    vault: env.vault,
    agent_name: env.env["VAULT_AGENT_NAME"] ?? null,
    timezone: env.env["VAULT_TIMEZONE"] ?? null,
  });
}

/**
 * Strict structural equality over JSON-shaped values. Used by adapters
 * with a custom on-disk entry shape (`serializeEntry`) to compare the
 * current entry against the re-serialized canonical payload: any added,
 * removed, or changed field counts as drift, matching the
 * "drift via payload re-construction" model.
 */
export function deepJsonEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepJsonEquals(a[i], b[i])) return false;
    }
    return true;
  }
  if (
    a !== null &&
    b !== null &&
    typeof a === "object" &&
    typeof b === "object" &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const ka = Object.keys(a as Record<string, unknown>).toSorted();
    const kb = Object.keys(b as Record<string, unknown>).toSorted();
    if (ka.length !== kb.length) return false;
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] !== kb[i]) return false;
      const k = ka[i]!;
      if (!deepJsonEquals((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) {
        return false;
      }
    }
    return true;
  }
  return false;
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
