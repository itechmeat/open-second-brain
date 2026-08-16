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
 * The configuration layers a resolved value can come from, highest
 * precedence first.
 *
 * Four members rather than three because a vault carries a COMMITTED
 * configuration of its own (`<vault>/Brain/_brain.yaml`) that travels
 * with the vault, next to the machine-local `config.yaml` that does not.
 * Collapsing the two into one "config" answer would make the only
 * interesting provenance question - "did this value come from something
 * my teammate also has?" - unanswerable.
 *
 * `default` is a layer, not the absence of one: a caller that reports
 * where a value came from must be able to say "nothing configured it"
 * without inventing a null case at every call site.
 */
export const CONFIG_ORIGIN = Object.freeze({
  env: "env",
  userConfig: "user-config",
  vaultConfig: "vault-config",
  default: "default",
} as const);

export type ConfigOrigin = (typeof CONFIG_ORIGIN)[keyof typeof CONFIG_ORIGIN];

/** The layers, in precedence order (highest first). */
export const CONFIG_ORIGINS: ReadonlyArray<ConfigOrigin> = Object.freeze([
  CONFIG_ORIGIN.env,
  CONFIG_ORIGIN.vaultConfig,
  CONFIG_ORIGIN.userConfig,
  CONFIG_ORIGIN.default,
]);

export function isConfigOrigin(value: unknown): value is ConfigOrigin {
  return typeof value === "string" && (CONFIG_ORIGINS as ReadonlyArray<string>).includes(value);
}

/** A resolved configuration value together with the layer that produced it. */
export interface ResolvedConfigValue {
  /** `null` when no layer supplied a non-empty value. */
  readonly value: string | null;
  readonly origin: ConfigOrigin;
}

/**
 * {@link envOrConfig} with the layer that produced the value.
 *
 * The sibling exists rather than a widened `envOrConfig` because that
 * function is the choke point for roughly fifty-five keys and only the
 * install, hook-generation and inventory surfaces need provenance. A
 * mechanical sweep of every call site would buy those few callers
 * nothing and put the other fifty at risk.
 *
 * Only the two layers this function can see are ever reported; a caller
 * that also consults `<vault>/Brain/_brain.yaml` layers
 * {@link CONFIG_ORIGIN.vaultConfig} on top of this result itself (see
 * `src/core/install/settings.ts`).
 */
export function resolveWithOrigin(
  env: NodeJS.ProcessEnv,
  config: Readonly<Record<string, string>>,
  envKey: string,
  configKey: string,
): ResolvedConfigValue {
  const e = env[envKey];
  if (e !== undefined && e !== "") return { value: e, origin: CONFIG_ORIGIN.env };
  const c = config[configKey];
  if (c !== undefined && c !== "") return { value: c, origin: CONFIG_ORIGIN.userConfig };
  return { value: null, origin: CONFIG_ORIGIN.default };
}

/**
 * Resolve a value from an environment variable or config map, preferring
 * the environment. Returns `null` when neither source has a non-empty value.
 *
 * A thin delegation to {@link resolveWithOrigin} so the two can never
 * disagree about which source wins - `tests/core/config-origin.test.ts`
 * drives every branch through both and requires the same value.
 */
export function envOrConfig(
  env: NodeJS.ProcessEnv,
  config: Readonly<Record<string, string>>,
  envKey: string,
  configKey: string,
): string | null {
  return resolveWithOrigin(env, config, envKey, configKey).value;
}
