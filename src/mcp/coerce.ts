/**
 * Shared coercion helpers for MCP tool handlers.
 *
 * Used by tools.ts, brain-tools.ts, and search-tools.ts to validate
 * and cast incoming JSON-RPC arguments. All helpers throw `MCPError`
 * with `INVALID_PARAMS` on bad input.
 */

import { INVALID_PARAMS, MCPError } from "./protocol.ts";
import { parseOptionalFiniteNumberInput } from "../core/validate.ts";

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

export function coerceOptionalNumber(args: Record<string, unknown>, key: string): number | null {
  const parsed = parseOptionalFiniteNumberInput(args[key]);
  if (parsed.error === "finite-number") {
    throw new MCPError(INVALID_PARAMS, `argument '${key}' must be a finite number`);
  }
  if (parsed.error === "number-or-numeric-string") {
    throw new MCPError(INVALID_PARAMS, `argument '${key}' must be a number or numeric string`);
  }
  return parsed.value;
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
