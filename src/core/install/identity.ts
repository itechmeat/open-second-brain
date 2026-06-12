/**
 * Per-runtime Brain identity.
 *
 * Rule: a runtime attributes its Brain writes to ITS OWN name - the same id it
 * already uses as its session-import `defaultAgent` and its install target
 * (`opencode`, `grok`, ...). A runtime never inherits another runtime's
 * configured name, and this rule names no other runtime: each integration
 * supplies only its own id.
 *
 * Without this, every runtime that registers the MCP servers would write under
 * the single operator `agent_name` from the shared config, so e.g. opencode
 * would log under whatever that name is (commonly a Claude one) and be
 * indistinguishable - one agent masquerading as another. Stamping the runtime's
 * own id on `VAULT_AGENT_NAME` makes the MCP server's identity instruction and
 * every Brain write say who actually wrote it.
 */

import type { McpPayload, McpServerEntry } from "./types.ts";

function withIdentity(entry: McpServerEntry, runtimeId: string): McpServerEntry {
  return { ...entry, env: { ...entry.env, VAULT_AGENT_NAME: runtimeId } };
}

/**
 * Return a copy of the payload whose `VAULT_AGENT_NAME` is the runtime's own
 * id, preserving the other env keys (timezone, ...).
 */
export function payloadWithRuntimeIdentity(payload: McpPayload, runtimeId: string): McpPayload {
  return {
    full: withIdentity(payload.full, runtimeId),
    writer: withIdentity(payload.writer, runtimeId),
  };
}
