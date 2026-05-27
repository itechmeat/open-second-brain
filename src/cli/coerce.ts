/**
 * Shared coercion helpers for the `o2b` CLI.
 *
 * Parse and validate optional CLI flag values. Each helper returns a
 * `{ value, error }` tuple so the caller can decide the exit code.
 */

import { parseOptionalFiniteNumberInput } from "../core/validate.ts";

/**
 * Parse an optional `--<name>` flag whose value should be a finite number.
 * Returns `{ value: number | null, error: string | null }`.
 *
 * Trim before testing for emptiness — `Number(" ")` evaluates to `0` in JS.
 */
export function parseOptionalNumberFlag(
  flags: Record<string, string | boolean | string[] | undefined>,
  name: string,
): { value: number | null; error: string | null } {
  const raw = flags[name];
  if (raw === undefined) return { value: null, error: null };
  // A non-string value (boolean / string[]) indicates a misconfigured
  // flag schema — surface it as a clean validation error instead of
  // throwing at the `.trim()` call below.
  if (typeof raw !== "string") {
    return {
      value: null,
      error: `--${name} must be provided as a single string value`,
    };
  }
  const parsed = parseOptionalFiniteNumberInput(raw);
  if (parsed.error !== null) {
    return { value: null, error: `--${name} must be a number, got: ${raw}` };
  }
  return { value: parsed.value, error: null };
}

/**
 * Strict ISO-8601 timestamp matcher used by `--now / --since / --until`.
 * The plain `new Date(s)` constructor is far too permissive. We require
 * a full date-time including offset (`Z` or `±HH:MM`).
 *
 * Sibling regex: `ISO_UTC_TS_RE` in `src/core/brain/log-jsonl.ts`. That
 * one is intentionally stricter (Z only, no `±HH:MM`, no millisecond
 * cap) because it parses values that the *writer* (`renderJsonlLine`)
 * has just emitted in canonical UTC. This one is looser because it
 * has to accept whatever a human typed on the CLI; the resulting
 * `Date` is normalised to UTC by the JS runtime before any downstream
 * code touches it.
 */
export const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Parse an optional `--<name>` flag as a strict ISO-8601 Date.
 * Returns `{ value: Date | null, error: string | null }`.
 */
export function parseOptionalIsoDate(
  flags: Record<string, string | boolean | string[] | undefined>,
  name: string,
): { value: Date | null; error: string | null } {
  const raw = flags[name];
  if (raw === undefined) return { value: null, error: null };
  if (typeof raw !== "string") {
    return {
      value: null,
      error: `--${name} must be provided as a single string value`,
    };
  }
  const trimmed = raw.trim();
  if (trimmed === "") return { value: null, error: null };
  if (!ISO_8601_RE.test(trimmed)) {
    return {
      value: null,
      error: `--${name} must be a valid ISO-8601 timestamp; got ${raw}`,
    };
  }
  const d = new Date(trimmed);
  if (!Number.isFinite(d.getTime())) {
    return {
      value: null,
      error: `--${name} must be a valid ISO-8601 timestamp; got ${raw}`,
    };
  }
  return { value: d, error: null };
}
