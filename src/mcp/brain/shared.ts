/**
 * Helpers shared by the Brain MCP domain modules: argument
 * coercion, vault-relative path rendering, and the consolidated
 * view dispatcher used by brain_brief / brain_analytics.
 */

import { isAbsolute, relative, resolve } from "node:path";
import { resolveTimezone } from "../../core/config.ts";
import { type RecallTelemetryOptions } from "../../core/brain/recall-telemetry.ts";
import { isoSecond } from "../../core/brain/time.ts";
import { formatLocalTimestamp } from "../../core/brain/present-time.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import type { ServerContext } from "../tools.ts";
import { coerceBool } from "../coerce.ts";

export const ISO_DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function coerceIsoTimestampOrDate(
  tool: string,
  field: string,
  raw: unknown,
  shape: "date-only" | "date-or-timestamp" = "date-or-timestamp",
): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new MCPError(
      INVALID_PARAMS,
      `${tool}: ${field} must be an ISO date${shape === "date-or-timestamp" ? " or ISO timestamp" : " (YYYY-MM-DD)"}`,
    );
  }
  const v = raw.trim();
  if (shape === "date-only" && !ISO_DATE_ONLY_RE.test(v)) {
    throw new MCPError(
      INVALID_PARAMS,
      `${tool}: ${field} must be an ISO date (YYYY-MM-DD); got ${JSON.stringify(v)}`,
    );
  }
  // Validate by parsing - rejects "2026-13-99" / "garbage" / etc.
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) {
    throw new MCPError(
      INVALID_PARAMS,
      `${tool}: ${field} must be a parseable ISO date${shape === "date-or-timestamp" ? " or timestamp" : ""}; got ${JSON.stringify(v)}`,
    );
  }
  return v;
}

export function coercePositiveInteger(
  tool: string,
  field: string,
  raw: unknown,
): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "number") {
    if (!Number.isInteger(raw) || raw < 1) {
      throw new MCPError(INVALID_PARAMS, `${tool}: ${field} must be a positive integer`);
    }
    return raw;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed === "" || !/^[0-9]+$/.test(trimmed)) {
      throw new MCPError(INVALID_PARAMS, `${tool}: ${field} must be a positive integer`);
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (parsed < 1) {
      throw new MCPError(INVALID_PARAMS, `${tool}: ${field} must be a positive integer`);
    }
    return parsed;
  }
  throw new MCPError(INVALID_PARAMS, `${tool}: ${field} must be a positive integer`);
}

export function dispatchByView(
  table: Readonly<
    Record<
      string,
      (ctx: ServerContext, args: Record<string, unknown>) => Promise<unknown> | unknown
    >
  >,
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<unknown> | unknown {
  const view = typeof args["view"] === "string" ? args["view"] : "";
  const handler = table[view];
  if (handler === undefined) {
    throw new MCPError(
      INVALID_PARAMS,
      `view must be one of ${Object.keys(table).join(", ")}; got ${JSON.stringify(args["view"])}`,
    );
  }
  return handler(ctx, args);
}

/**
 * Timezone presentation (t_2ccadc6a): when the operator configured an
 * IANA zone, brief/analytics envelopes gain two ADDITIVE fields - a
 * `timezone` echo and `local_time` (the render instant in that zone).
 * Stored timestamps inside the envelope stay canonical UTC; with no
 * timezone configured the envelope is byte-identical to 0.45.0.
 */
export function localizeEnvelope(ctx: ServerContext, result: unknown): unknown {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return result;
  const tz = resolveTimezone(ctx.configPath ?? undefined);
  if (tz === null) return result;
  return {
    ...(result as Record<string, unknown>),
    timezone: tz,
    local_time: formatLocalTimestamp(isoSecond(new Date()), tz),
  };
}

/** Parse an optional positive-integer arg, throwing INVALID_PARAMS otherwise. */
export function optionalPositiveInt(
  args: Record<string, unknown>,
  key: string,
  tool: string,
): number | undefined {
  const raw = args[key];
  if (raw === undefined) return undefined;
  const n =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^[0-9]+$/.test(raw.trim())
        ? Number.parseInt(raw.trim(), 10)
        : Number.NaN;
  if (!Number.isInteger(n) || n <= 0) {
    throw new MCPError(INVALID_PARAMS, `${tool}: ${key} must be a positive integer`);
  }
  return n;
}

export function optionalStringArg(
  tool: string,
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const raw = args[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new MCPError(INVALID_PARAMS, `${tool}: ${key} must be a non-empty string`);
  }
  return raw.trim();
}

export function requiredStringArg(
  tool: string,
  args: Record<string, unknown>,
  key: string,
): string {
  const value = optionalStringArg(tool, args, key);
  if (value === undefined) throw new MCPError(INVALID_PARAMS, `${tool}: ${key} is required`);
  return value;
}

// ----- brain_recall_telemetry ---------------------------------------------

export function telemetryOptionsFromArgs(
  tool: string,
  args: Record<string, unknown>,
  defaultHost: string,
): RecallTelemetryOptions | undefined {
  if (!coerceBool(args, "telemetry")) return undefined;
  return {
    host: optionalStringArg(tool, args, "telemetry_host") ?? defaultHost,
    ...(optionalStringArg(tool, args, "session_id") !== undefined
      ? { sessionId: optionalStringArg(tool, args, "session_id") }
      : {}),
    ...(optionalStringArg(tool, args, "turn_id") !== undefined
      ? { turnId: optionalStringArg(tool, args, "turn_id") }
      : {}),
  };
}

/**
 * Produce a vault-relative path, swallowing errors (a defensive pattern
 * for output rendering). Exported for unit tests
 * — internal callers stay inside this module.
 *
 * @internal
 */
export function vaultRelativeSafe(vault: string, target: string): string {
  const absVault = resolve(vault);
  const absTarget = resolve(target);
  // Use Node's path.relative so the separator handling matches the host
  // OS (forward-slashes on POSIX, back-slashes on Windows). The prior
  // implementation hard-coded `"/"` and silently broke on Windows when
  // the vault sat under e.g. `C:\Users\...`.
  const rel = relative(absVault, absTarget);
  if (rel === "") return "";
  // `relative()` returns a path starting with `..` (or, in rare drive-
  // mismatch cases on Windows, an absolute path) when the target sits
  // outside the vault. In both situations we return the original target
  // unchanged — callers treat that as "not under vault" and render it
  // as-is.
  if (rel.startsWith("..") || isAbsolute(rel)) return target;
  return rel;
}

// ----- Tool registration ---------------------------------------------------
