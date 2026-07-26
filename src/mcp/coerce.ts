/**
 * Shared coercion helpers for MCP tool handlers.
 *
 * Used by tools.ts, brain-tools.ts, and search-tools.ts to validate
 * and cast incoming JSON-RPC arguments. All helpers throw `MCPError`
 * with `INVALID_PARAMS` on bad input.
 */

import { INVALID_PARAMS, MCPError } from "./protocol.ts";

export function coerceStr(
  args: Record<string, unknown>,
  key: string,
  required = true,
  defaultValue: string | null = null,
): string | null {
  const value = args[key];
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
    if (required) throw new MCPError(INVALID_PARAMS, `missing required argument: ${key}`);
    return defaultValue;
  }
  if (typeof value !== "string")
    throw new MCPError(INVALID_PARAMS, `argument '${key}' must be a string`);
  return value;
}

export function coerceStrList(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new MCPError(INVALID_PARAMS, `argument '${key}' must be a list of strings`);
  }
  return [...value] as string[];
}

export function coerceInt(
  args: Record<string, unknown>,
  key: string,
  defaultValue: number,
  min: number,
  max: number,
): number {
  const value = args[key] ?? defaultValue;
  if (typeof value === "boolean" || typeof value !== "number" || !Number.isInteger(value)) {
    throw new MCPError(INVALID_PARAMS, `argument '${key}' must be an integer`);
  }
  if (value < min || value > max) {
    throw new MCPError(INVALID_PARAMS, `argument '${key}' must be between ${min} and ${max}`);
  }
  return value;
}

export function coerceBool(args: Record<string, unknown>, key: string): boolean {
  const value = args[key];
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean")
    throw new MCPError(INVALID_PARAMS, `argument '${key}' must be a boolean`);
  return value;
}

export function coerceBoolOptional(
  args: Record<string, unknown>,
  key: string,
): boolean | undefined {
  if (!(key in args)) return undefined;
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean")
    throw new MCPError(INVALID_PARAMS, `argument '${key}' must be a boolean`);
  return v;
}

export function coerceStringOptional(
  args: Record<string, unknown>,
  key: string,
  maxLen: number,
): string | undefined {
  if (!(key in args)) return undefined;
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string")
    throw new MCPError(INVALID_PARAMS, `argument '${key}' must be a string`);
  if (v.length > maxLen)
    throw new MCPError(INVALID_PARAMS, `argument '${key}' exceeds ${maxLen} characters`);
  return v;
}

/**
 * Input-schema fragment for the owner-scope argument
 * (context-integrity-gates, Unit A). Declared once so eleven tools
 * cannot grow eleven descriptions of the same argument.
 */
export const AGENT_SCOPE_ARG_NAME = "agent_scope";

/** Longest accepted owner token; an agent name, not a document. */
const AGENT_SCOPE_MAX_LEN = 128;

export const AGENT_SCOPE_SCHEMA = Object.freeze({
  type: "string",
  description:
    "Optional agent-ownership scope; shared (ownerless) memories always match, owner-tagged memories only their owner. Absent = no ownership filtering.",
});

/**
 * Read the owner scope a content-returning tool was called with.
 *
 * `fallbackToServerIdentity` is for the GATED preference-backed
 * surfaces: with no explicit argument they scope to the process's own
 * agent identity, which is what makes `owner_scope_delivery: fail`
 * effective for clients that never pass the argument. It is safe there
 * and only there, because those surfaces filter nothing until the
 * operator sets the gate. The ungated search-backed surfaces pass
 * `false`, so an omitted argument keeps them byte-identical.
 */
export function coerceAgentScope(
  ctx: { readonly agentName?: string },
  args: Record<string, unknown>,
  fallbackToServerIdentity: boolean,
): string | undefined {
  const explicit = coerceStringOptional(args, AGENT_SCOPE_ARG_NAME, AGENT_SCOPE_MAX_LEN);
  if (explicit !== undefined) return explicit;
  return fallbackToServerIdentity ? ctx.agentName : undefined;
}

export function coerceIsoDate(args: Record<string, unknown>, key: string): Date | null {
  const raw = coerceStr(args, key, false);
  if (raw === null) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime()))
    throw new MCPError(INVALID_PARAMS, `argument '${key}' must be a valid ISO-8601 timestamp`);
  return d;
}

export function coerceFormat(args: Record<string, unknown>, key = "format"): "markdown" | "json" {
  const raw = coerceStr(args, key, false);
  if (raw === null) return "markdown";
  if (raw !== "markdown" && raw !== "json") {
    throw new MCPError(INVALID_PARAMS, `argument '${key}' must be 'markdown' or 'json'`);
  }
  return raw;
}
