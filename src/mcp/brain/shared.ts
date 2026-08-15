/**
 * Helpers shared by the Brain MCP domain modules: argument
 * coercion, vault-relative path rendering, and the consolidated
 * view dispatcher used by brain_brief / brain_analytics.
 */

import { isAbsolute, relative, resolve } from "node:path";
import { resolveTimezone } from "../../core/config.ts";
import { RECALL_CHANNEL, type RecallTelemetryOptions } from "../../core/brain/recall-telemetry.ts";
import { isoSecond } from "../../core/brain/time.ts";
import { formatLocalTimestamp } from "../../core/brain/present-time.ts";
import { INTERNAL_ERROR, INVALID_PARAMS, MCPError } from "../protocol.ts";
import type { ServerContext } from "../tool-contract.ts";
import { coerceBool } from "../coerce.ts";
import {
  CountGuardError,
  assertExpectedCount,
  type CountGuardOptions,
} from "../../core/brain/count-guard.ts";
import type { ProgressSink } from "../../core/brain/progress.ts";
import {
  createSafeguard,
  resolveSafeguardTimeoutMs,
  type Operation,
  type Safeguard,
} from "../../core/brain/safeguard.ts";

/**
 * Read the shared `--expect` / `--strict` count-guard arguments from an MCP
 * tool payload. `expect` absent means no assertion; a non-integer or negative
 * value is a client error.
 */
export function readCountGuardArgs(args: Record<string, unknown>): {
  expect: number | null;
  strict: boolean;
} {
  const raw = args["expect"];
  let expect: number | null = null;
  if (raw !== undefined && raw !== null) {
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      throw new MCPError(INVALID_PARAMS, "'expect' must be a non-negative integer");
    }
    expect = n;
  }
  return { expect, strict: coerceBool(args, "strict") === true };
}

/**
 * Run the count guard, mapping a {@link CountGuardError} to INVALID_PARAMS so
 * the caller (not the server) is blamed for the mismatch / guardless mutation.
 */
export function enforceCountGuard(opts: CountGuardOptions): void {
  try {
    assertExpectedCount(opts);
  } catch (err) {
    if (err instanceof CountGuardError) throw new MCPError(INVALID_PARAMS, err.message);
    throw err;
  }
}

/**
 * A cooperative deadline for one long MCP operation, resolved through the
 * documented ladder: `safeguard_timeout_<operation>_seconds`, then
 * `safeguard_timeout_seconds`, then the built-in default.
 *
 * One factory rather than one per domain module. Three had grown - the
 * maintenance lane's, the graph tools', and none at all for `brain_dream`
 * - and the gap was invisible precisely because each module answered the
 * question locally. `docs/mcp.md` states the ladder once; this is the one
 * place that implements it for the MCP surface, so a tool that reaches a
 * long operation and forgets the deadline is a missing call to a named
 * helper rather than a missing copy of a three-line idiom.
 */
export function toolSafeguard(ctx: ServerContext, operation: Operation): Safeguard {
  return createSafeguard({
    operation,
    timeoutMs: resolveSafeguardTimeoutMs(operation, ctx.configPath ?? undefined),
  });
}

export const ISO_DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Run a tool handler body, classifying a thrown error into the right MCP
 * error code: a client-resolvable input problem (any class in
 * `validationClasses`, or an already-typed `MCPError`) surfaces as
 * `INVALID_PARAMS`; anything else is a server fault (`INTERNAL_ERROR`).
 * This mapping is safety-relevant - it decides whether the CALLER or the
 * SERVER is blamed for a failure - and was previously copy-pasted
 * identically across derive-tools, ingest-tools, ner-tools, and
 * research-tools, one drift away from silently reclassifying an error.
 */
export async function wrapToolErrors<T>(
  tool: string,
  validationClasses: ReadonlyArray<new (...args: never[]) => Error>,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (validationClasses.some((cls) => err instanceof cls)) {
      throw new MCPError(INVALID_PARAMS, `${tool}: ${(err as Error).message}`);
    }
    if (err instanceof MCPError) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    throw new MCPError(INTERNAL_ERROR, `${tool}: ${reason}`);
  }
}

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

/**
 * Coerce an optional integer argument that MAY be zero (non-negative).
 * Distinct from {@link coercePositiveInteger}: some core builders accept
 * `0` (e.g. a zero-day activity window or a zero-entry limit), and the MCP
 * surface must not reject a value the core and CLI honour.
 */
export function coerceNonNegativeInteger(
  tool: string,
  field: string,
  raw: unknown,
): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "number") {
    if (!Number.isInteger(raw) || raw < 0) {
      throw new MCPError(INVALID_PARAMS, `${tool}: ${field} must be a non-negative integer`);
    }
    return raw;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed === "" || !/^[0-9]+$/.test(trimmed)) {
      throw new MCPError(INVALID_PARAMS, `${tool}: ${field} must be a non-negative integer`);
    }
    return Number.parseInt(trimmed, 10);
  }
  throw new MCPError(INVALID_PARAMS, `${tool}: ${field} must be a non-negative integer`);
}

/**
 * Route one consolidated tool's `view` argument to its per-view handler.
 *
 * The progress sink is forwarded rather than dropped. It is optional at
 * every link, so a view that has nothing to report ignores it - but a
 * dispatcher that silently swallowed it would make a view which DOES run
 * long, such as the operator brief's dry-run consolidation pass, look
 * like a tool that emits no progress rather than one whose progress was
 * discarded in transit. Those are the two cases this release exists to
 * keep apart.
 */
export function dispatchByView(
  table: Readonly<
    Record<
      string,
      (
        ctx: ServerContext,
        args: Record<string, unknown>,
        onProgress?: ProgressSink,
      ) => Promise<unknown> | unknown
    >
  >,
  ctx: ServerContext,
  args: Record<string, unknown>,
  onProgress?: ProgressSink,
): Promise<unknown> | unknown {
  const view = typeof args["view"] === "string" ? args["view"] : "";
  const handler = table[view];
  if (handler === undefined) {
    throw new MCPError(
      INVALID_PARAMS,
      `view must be one of ${Object.keys(table).join(", ")}; got ${JSON.stringify(args["view"])}`,
    );
  }
  return handler(ctx, args, onProgress);
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

/**
 * Telemetry options for an MCP tool handler, or `undefined` when the
 * caller did not opt in.
 *
 * `channel` is fixed at {@link RECALL_CHANNEL.mcp} rather than taken from
 * the caller: every caller of this helper IS an MCP tool handler, so the
 * transport is a fact about the seam, not an argument. `telemetry_host`
 * stays the caller's to set, and stays a runtime identity - which is the
 * separation the channel dimension exists to make.
 */
export function telemetryOptionsFromArgs(
  tool: string,
  args: Record<string, unknown>,
  defaultHost: string,
): RecallTelemetryOptions | undefined {
  if (!coerceBool(args, "telemetry")) return undefined;
  // Each id parsed ONCE. The conditional-spread idiom used to call the
  // parser twice per field, so a validating parser ran its checks twice
  // and any future non-idempotent one would have diverged silently.
  const sessionId = optionalStringArg(tool, args, "session_id");
  const turnId = optionalStringArg(tool, args, "turn_id");
  return {
    host: optionalStringArg(tool, args, "telemetry_host") ?? defaultHost,
    channel: RECALL_CHANNEL.mcp,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(turnId !== undefined ? { turnId } : {}),
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
