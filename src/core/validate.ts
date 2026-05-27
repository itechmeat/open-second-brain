/**
 * Config-level input validators shared across the core library.
 *
 * Extracted from `src/core/search/index.ts` where they were private helpers
 * for `resolveSearchConfig`. They parse string env/config values into typed
 * scalars and validate numeric ranges — no I/O, no side effects.
 *
 * Error convention: every function throws `Error` with a message that
 * includes the field name. Callers that need a typed error (e.g. SearchError
 * in the search layer) wrap the message in their own error type.
 */

/**
 * Parse a string into an integer, falling back to `default_` when `raw` is
 * null. Throws `Error` on non-integer, non-finite, or out-of-range input.
 */
export function parseInteger(
  raw: string | null,
  default_: number,
  fieldName: string,
  range?: { readonly min?: number; readonly max?: number },
): number {
  if (raw === null) return default_;
  // `Number(" ")` returns 0 in JS — without this guard a whitespace-
  // only config value would silently coerce to a valid integer.
  if (raw.trim() === "") {
    throw new Error(`${fieldName} must be an integer, got empty string`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`${fieldName} must be an integer, got '${raw}'`);
  }
  if (range?.min !== undefined && n < range.min) {
    throw new Error(`${fieldName} must be >= ${range.min}, got ${n}`);
  }
  if (range?.max !== undefined && n > range.max) {
    throw new Error(`${fieldName} must be <= ${range.max}, got ${n}`);
  }
  return n;
}

/**
 * Parse a string into a number in `[0, 1]`, falling back to `default_` when
 * `raw` is null. Throws `Error` on out-of-range or non-finite input.
 */
export function parseFloat01(raw: string | null, default_: number, fieldName: string): number {
  if (raw === null) return default_;
  if (raw.trim() === "") {
    throw new Error(`${fieldName} must be a number in [0, 1], got empty string`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(`${fieldName} must be a number in [0, 1], got '${raw}'`);
  }
  return n;
}

export type OptionalFiniteNumberInputError = "finite-number" | "number-or-numeric-string";

export interface OptionalFiniteNumberInputResult {
  readonly value: number | null;
  readonly error: OptionalFiniteNumberInputError | null;
}

/**
 * Parse an optional finite number accepted at external API boundaries.
 * `null`, `undefined`, and blank strings mean "not provided".
 */
export function parseOptionalFiniteNumberInput(raw: unknown): OptionalFiniteNumberInputResult {
  if (raw === undefined || raw === null) return { value: null, error: null };
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return { value: null, error: "finite-number" };
    return { value: raw, error: null };
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed === "") return { value: null, error: null };
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return { value: null, error: "number-or-numeric-string" };
    return { value: parsed, error: null };
  }
  return { value: null, error: "number-or-numeric-string" };
}

/**
 * Parse a string into a boolean. Accepts `"true"`/`"1"` → `true`,
 * `"false"`/`"0"` → `false`. Throws `Error` on any other value.
 */
export function parseBool(raw: string | null, default_: boolean, fieldName: string): boolean {
  if (raw === null) return default_;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`${fieldName} must be 'true' or 'false', got '${raw}'`);
}

/**
 * Resolve a value from an environment variable or config map, preferring
 * the environment. Returns `null` when neither source has a non-empty value.
 */
export function envOrConfig(
  env: NodeJS.ProcessEnv,
  config: Readonly<Record<string, string>>,
  envKey: string,
  configKey: string,
): string | null {
  const e = env[envKey];
  if (e !== undefined && e !== "") return e;
  const c = config[configKey];
  if (c !== undefined && c !== "") return c;
  return null;
}
