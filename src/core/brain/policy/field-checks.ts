/**
 * Scalar and shape constraints reused across every `_brain.yaml` block.
 *
 * One reason to change: the vocabulary of constraints a config field can
 * be held to. Every check raises {@link BrainConfigError} naming the
 * offending field — none of them clamps, defaults, or returns a neutral
 * value, because a knob that silently reverted would be indistinguishable
 * from the operator never having set it.
 */

import { BrainConfigError } from "./errors.ts";

/**
 * Bytes the small `_brain.yaml` subset cannot round-trip: the writer
 * quotes strings but implements no escape sequences, so a value carrying
 * one of these could be written and then read back as something else.
 */
const YAML_STRING_REJECTED_CHARS = ['"', "\\", "\n", "\r"] as const;

export function describe(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === "object") return "object";
  return `${typeof value}(${JSON.stringify(value)})`;
}

/**
 * Reject a string that the `_brain.yaml` writer could not emit verbatim.
 * `hint` names the shape the field does accept and is appended to the
 * message, so a path field and an agent-id field each point at their own
 * remedy.
 */
export function assertNoYamlUnsafeChars(
  value: string,
  field: string,
  source: string | null,
  hint: string,
): void {
  for (const bad of YAML_STRING_REJECTED_CHARS) {
    if (value.includes(bad)) {
      throw new BrainConfigError(
        `contains a disallowed character ${JSON.stringify(bad)}; ${hint}`,
        field,
        source,
      );
    }
  }
}

/**
 * Narrow a raw config value to a plain object, or throw a field-named
 * `BrainConfigError`. Centralizes the "block must be a map of keys" guard
 * that used to be copy-pasted at every optional-block site with two
 * slightly different wordings ("must be a mapping" vs "must be a map of
 * keys") - callers get one consistent message (`BrainConfigError` already
 * prepends the block's `field` name, so the message itself does not repeat
 * it).
 */
export function requireMapBlock(
  raw: unknown,
  blockKey: string,
  source: string | null,
): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new BrainConfigError(`must be a map of keys; got ${describe(raw)}`, blockKey, source);
  }
  return raw as Record<string, unknown>;
}

/**
 * Narrow a raw config value to an array. The message is caller-supplied
 * because each list field names what its entries are for ("pattern
 * strings", "vault-relative folder paths", …), and those wordings are
 * pinned by tests.
 */
export function requireArrayField(
  raw: unknown,
  field: string,
  source: string | null,
  message: string,
): ReadonlyArray<unknown> {
  if (!Array.isArray(raw)) {
    throw new BrainConfigError(message, field, source);
  }
  return raw as ReadonlyArray<unknown>;
}

export function requirePositiveInteger(field: string, value: unknown, source: string | null): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new BrainConfigError(`must be a positive integer; got ${describe(value)}`, field, source);
  }
}

export function requireNonNegativeInteger(
  field: string,
  value: unknown,
  source: string | null,
): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new BrainConfigError(
      `must be a non-negative integer; got ${describe(value)}`,
      field,
      source,
    );
  }
}

export function requireUnitInterval(field: string, value: unknown, source: string | null): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new BrainConfigError(`must be a number in [0, 1]; got ${describe(value)}`, field, source);
  }
}

/**
 * Assert that a present value is an integer inside `[min, max]`. Used
 * where the enclosing block already resolved a default for an absent key,
 * so "absent" is not one of the outcomes.
 */
export function requireIntegerInRange(
  field: string,
  value: unknown,
  min: number,
  max: number,
  source: string | null,
): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new BrainConfigError(
      `must be an integer between ${min} and ${max}; got ${describe(value)}`,
      field,
      source,
    );
  }
}

/**
 * Read an optional integer field bounded to `[min, max]` from a config
 * sub-map. Returns `undefined` when the key is absent; throws a
 * {@link BrainConfigError} (never clamps) when present but out of range
 * or non-integer.
 */
export function readBoundedInt(
  map: Readonly<Record<string, unknown>>,
  key: string,
  min: number,
  max: number,
  field: string,
  source: string | null,
): number | undefined {
  if (!(key in map)) return undefined;
  requireIntegerInRange(field, map[key], min, max, source);
  return map[key] as number;
}
