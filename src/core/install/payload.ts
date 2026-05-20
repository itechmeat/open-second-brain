/**
 * Canonical MCP server payload builder.
 *
 * Pure function: given the plugin config (vault + identity), return the
 * two `McpServerEntry` objects that every adapter writes verbatim.
 * Same input → byte-identical output; this is what lets `--apply`
 * be idempotent and `verify` detect drift via re-construction rather
 * than a stored hash.
 */

import type { McpPayload, McpServerEntry } from "./types.ts";

export class PayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayloadError";
  }
}

export interface PayloadConfig {
  readonly vault: string;
  readonly agent_name: string | null;
  readonly timezone: string | null;
}

const COMMAND = "o2b";

export function buildPayload(cfg: PayloadConfig): McpPayload {
  if (!cfg.vault || typeof cfg.vault !== "string") {
    throw new PayloadError("buildPayload: vault is required");
  }
  const env = buildEnv(cfg);
  const full: McpServerEntry = {
    command: COMMAND,
    args: ["mcp", "--vault", cfg.vault],
    ...(env ? { env } : {}),
  };
  const writer: McpServerEntry = {
    command: COMMAND,
    args: ["mcp", "--writer-only", "--vault", cfg.vault],
    ...(env ? { env } : {}),
  };
  return { full, writer };
}

function buildEnv(cfg: PayloadConfig): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  if (cfg.agent_name) env["VAULT_AGENT_NAME"] = cfg.agent_name;
  if (cfg.timezone) env["VAULT_TIMEZONE"] = cfg.timezone;
  return Object.keys(env).length > 0 ? env : undefined;
}
