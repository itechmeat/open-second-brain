/**
 * Per-runtime Brain identity.
 *
 * Rule: a runtime attributes its Brain writes to ITS OWN, host-qualified name -
 * the runtime's vendor token (the same id it uses as its session-import
 * `defaultAgent` and its install `target`: `opencode`, `grok`, ...) combined
 * with the host segment of the operator's configured `agent_name`. So on a box
 * whose operator name is `claude-vps-agent`, opencode logs as `opencode-vps-agent`
 * and grok as `grok-vps-agent`. See {@link deriveRuntimeAgentName} for the
 * derivation; it names no other runtime and discards the source vendor token.
 *
 * Without this, every runtime that registers the MCP servers would write under
 * the single operator `agent_name` from the shared config, so e.g. opencode
 * would log under whatever that name is (commonly a Claude one) and be
 * indistinguishable - one agent masquerading as another. Host-qualifying the
 * runtime's own id additionally keeps a shared multi-device vault able to tell
 * the same runtime apart across machines.
 *
 * The operator name is read from the payload's own `VAULT_AGENT_NAME` (which
 * `buildPayload` populates from the resolved config), so `apply` and `verify`
 * derive the identical value from the identical input - the install stays
 * idempotent and `--check` reports no drift after an apply.
 */

import { deriveRuntimeAgentName } from "../agent-identity.ts";
import type { McpPayload, McpServerEntry } from "./types.ts";

function withIdentity(entry: McpServerEntry, runtimeId: string): McpServerEntry {
  const name = deriveRuntimeAgentName(runtimeId, entry.env?.["VAULT_AGENT_NAME"]);
  return { ...entry, env: { ...entry.env, VAULT_AGENT_NAME: name } };
}

/**
 * Return a copy of the payload whose `VAULT_AGENT_NAME` is the runtime's own
 * host-qualified id, preserving the other env keys (timezone, ...).
 */
export function payloadWithRuntimeIdentity(payload: McpPayload, runtimeId: string): McpPayload {
  return {
    full: withIdentity(payload.full, runtimeId),
    writer: withIdentity(payload.writer, runtimeId),
  };
}

/**
 * The single host-qualified identity a runtime stamps everywhere (MCP env and,
 * for grok, the hooks env), derived from the payload's operator name. Callers
 * that write more than one artifact (grok writes both config.toml and a hooks
 * file) use this so every artifact agrees on one name.
 */
export function runtimeAgentNameFromPayload(payload: McpPayload, runtimeId: string): string {
  return deriveRuntimeAgentName(runtimeId, payload.full.env?.["VAULT_AGENT_NAME"]);
}
