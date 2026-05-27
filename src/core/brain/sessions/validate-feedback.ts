/**
 * Pure validator for the `brain_feedback` tool-use payload.
 *
 * Shared between two surfaces:
 *   - `src/mcp/brain-tools.ts:toolBrainFeedback` (live MCP invocation).
 *   - `src/core/brain/sessions/import.ts` (replay of `brain_feedback`
 *     tool_use calls extracted from a session JSONL by §16).
 *
 * Single source of truth so the MCP contract and the session-replay
 * contract cannot drift. Returns a tagged-union result instead of
 * throwing — callers branch on `ok` and surface the right error
 * envelope (`MCPError` for MCP, soft warning for import).
 */

import { assessRuleQuality } from "../trust/assess-rule-quality.ts";
import { BRAIN_SIGNAL_SIGN } from "../types.ts";

export interface ValidatedFeedback {
  readonly topic: string;
  readonly signal: "positive" | "negative";
  readonly principle: string;
  readonly scope?: string;
  readonly agent?: string;
  readonly raw?: string;
  readonly source?: ReadonlyArray<string>;
  readonly force_confirmed?: boolean;
}

export type ValidationResult =
  | { ok: true; value: ValidatedFeedback }
  | { ok: false; reason: string };

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function optionalString(value: unknown): string | null | "INVALID" {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return "INVALID";
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function optionalStringArray(value: unknown): ReadonlyArray<string> | null | "INVALID" {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return "INVALID";
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return "INVALID";
    out.push(item);
  }
  return out;
}

export function validateBrainFeedbackInput(input: unknown): ValidationResult {
  if (input === null || input === undefined || typeof input !== "object") {
    return { ok: false, reason: "brain_feedback input must be a non-null object" };
  }
  const record = input as Record<string, unknown>;

  const topic = nonEmptyString(record["topic"]);
  if (topic === null) {
    return { ok: false, reason: "brain_feedback missing required field: topic" };
  }

  const signalRaw = nonEmptyString(record["signal"]);
  if (signalRaw === null) {
    return { ok: false, reason: "brain_feedback missing required field: signal" };
  }
  if (signalRaw !== BRAIN_SIGNAL_SIGN.positive && signalRaw !== BRAIN_SIGNAL_SIGN.negative) {
    return {
      ok: false,
      reason: `brain_feedback field 'signal' must be 'positive' or 'negative'; got ${JSON.stringify(signalRaw)}`,
    };
  }

  const principle = nonEmptyString(record["principle"]);
  if (principle === null) {
    return { ok: false, reason: "brain_feedback missing required field: principle" };
  }

  // v0.10.16: structural quality gate. Reject only on structurally-broken
  // input (empty, single token). Warn-level findings are advisory and do
  // not block submission - the operator may still write a long or filler-
  // heavy principle if they accept the trade-off. The detector is
  // language-agnostic by construction (codepoint shape only).
  const quality = assessRuleQuality(principle);
  if (quality.severity === "reject") {
    return {
      ok: false,
      reason: `brain_feedback principle failed quality gate: ${quality.reasons.join(", ")}`,
    };
  }

  const scope = optionalString(record["scope"]);
  if (scope === "INVALID") return { ok: false, reason: "scope must be a string" };

  const agent = optionalString(record["agent"]);
  if (agent === "INVALID") return { ok: false, reason: "agent must be a string" };

  const raw = optionalString(record["raw"]);
  if (raw === "INVALID") return { ok: false, reason: "raw must be a string" };

  const source = optionalStringArray(record["source"]);
  if (source === "INVALID") {
    return { ok: false, reason: "source must be an array of strings" };
  }

  let force_confirmed: boolean | undefined;
  if (record["force_confirmed"] !== undefined && record["force_confirmed"] !== null) {
    if (typeof record["force_confirmed"] !== "boolean") {
      return { ok: false, reason: "force_confirmed must be a boolean" };
    }
    force_confirmed = record["force_confirmed"];
  }

  const value: ValidatedFeedback = {
    topic,
    signal: signalRaw as "positive" | "negative",
    principle,
    ...(scope !== null ? { scope } : {}),
    ...(agent !== null ? { agent } : {}),
    ...(raw !== null ? { raw } : {}),
    ...(source !== null ? { source } : {}),
    ...(force_confirmed !== undefined ? { force_confirmed } : {}),
  };
  return { ok: true, value };
}
