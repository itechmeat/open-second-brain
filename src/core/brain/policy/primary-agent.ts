/**
 * The `primary_agent:` scalar — both directions.
 *
 * One reason to change: the grammar of an agent id. Reader and writer sit
 * together on purpose. The loader enforces exactly the constraints the
 * writer enforces, so a hand-edited file that the writer would later
 * refuse to emit fails fast at load time instead of round-tripping into a
 * state we cannot persist.
 */

import { BrainConfigError } from "./errors.ts";
import { assertNoYamlUnsafeChars, describe } from "./field-checks.ts";
import { hasBlock, type BlockParseContext } from "./key-index.ts";
import { DEFAULT_BRAIN_CONFIG } from "./defaults.ts";

const FIELD = "primary_agent";
const SHAPE_HINT = "use a simple one-line agent id";
const EMPTY_MESSAGE = "must be either null or a non-empty string";

/**
 * Format a `primary_agent` value for the small `_brain.yaml` subset.
 *
 * We quote non-null values so spaces / `#` / `:` round-trip as data
 * instead of being interpreted as comments or YAML structure. Since the
 * parser intentionally does not implement escape sequences, reject bytes
 * that would require escaping rather than writing a value that cannot
 * be read back exactly.
 */
export function formatPrimaryAgentYamlValue(
  value: string | null,
  source: string | null = null,
): string {
  if (value === null) return "null";
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new BrainConfigError(EMPTY_MESSAGE, FIELD, source);
  }
  assertNoYamlUnsafeChars(trimmed, FIELD, source, SHAPE_HINT);
  return `"${trimmed}"`;
}

/**
 * Read the optional `primary_agent` scalar. Absent (or explicitly null)
 * resolves to the default so existing vaults are unaffected.
 */
export function parsePrimaryAgent(ctx: BlockParseContext): string | null {
  if (!hasBlock(ctx.obj, FIELD, ctx.keys)) return DEFAULT_BRAIN_CONFIG.primary_agent;
  const value = ctx.obj[FIELD];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new BrainConfigError(`${EMPTY_MESSAGE}; got ${describe(value)}`, FIELD, ctx.source);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new BrainConfigError(EMPTY_MESSAGE, FIELD, ctx.source);
  }
  assertNoYamlUnsafeChars(trimmed, FIELD, ctx.source, SHAPE_HINT);
  return trimmed;
}
