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
export function parseFloat01(
  raw: string | null,
  default_: number,
  fieldName: string,
): number {
  if (raw === null) return default_;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(`${fieldName} must be a number in [0, 1], got '${raw}'`);
  }
  return n;
}

/**
 * Parse a string into a boolean. Accepts `"true"`/`"1"` → `true`,
 * `"false"`/`"0"` → `false`. Throws `Error` on any other value.
 */
export function parseBool(
  raw: string | null,
  default_: boolean,
  fieldName: string,
): boolean {
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
