/**
 * The `recall_inject:` block - the named slices the recall-inject hook
 * retrieves and renders as headed groups inside its one fence.
 *
 * One reason to change: what an operator may declare about a slice.
 * Names are declared once in `slices:` and every per-slice field is
 * flat-encoded as `slice_<name>_<field>` to fit the two-level parser, as
 * `active.most_applied_*` already does. A name carries no underscore, so
 * the key splits at its first one. Every malformed slice key is a hard
 * error: a slice that silently lost its filter would recall the wrong
 * notes with no sign of why. Only non-slice keys get the usual
 * forward-compat warning.
 */

import type { BrainRecallInjectConfig, RecallSliceSpec } from "../../types.ts";
import { BrainConfigError } from "../errors.ts";
import { describe, readBoundedInt, requireArrayField } from "../field-checks.ts";
import { openBlock, warnUnknownKeys, type BlockParseContext } from "../key-index.ts";

const BLOCK = "recall_inject";

export const RECALL_SLICE_NAME_PATTERN = /^[a-z][a-z0-9]{0,23}$/;
export const RECALL_SLICES_MAX = 6;
export const RECALL_SLICE_LIMIT_MIN = 1;
export const RECALL_SLICE_LIMIT_MAX = 10;
export const RECALL_SLICE_MAX_CHARS_MIN = 100;
export const RECALL_SLICE_MAX_CHARS_MAX = 8000;

const SLICE_KEY_PREFIX = "slice_";
const SLICE_FIELDS = ["heading", "path_prefix", "types", "limit", "max_chars"] as const;
const KNOWN_KEYS = ["slices"] as const;

export function parseRecallInjectBlock(
  ctx: BlockParseContext,
): BrainRecallInjectConfig | undefined {
  const map = openBlock(ctx, BLOCK);
  if (map === undefined) return undefined;

  const names = parseSliceNames(map, ctx.source);
  const nonSlice: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(map)) {
    if (!key.startsWith(SLICE_KEY_PREFIX)) {
      nonSlice[key] = value;
      continue;
    }
    const rest = key.slice(SLICE_KEY_PREFIX.length);
    const cut = rest.indexOf("_");
    const name = cut === -1 ? rest : rest.slice(0, cut);
    const field = cut === -1 ? "" : rest.slice(cut + 1);
    if (!names.includes(name)) {
      throw new BrainConfigError(
        `names slice '${name}', which is not declared in ${BLOCK}.slices`,
        `${BLOCK}.${key}`,
        ctx.source,
      );
    }
    if (!(SLICE_FIELDS as ReadonlyArray<string>).includes(field)) {
      throw new BrainConfigError(
        `unknown slice field '${field}'; expected one of ${SLICE_FIELDS.join(", ")}`,
        `${BLOCK}.${key}`,
        ctx.source,
      );
    }
  }

  warnUnknownKeys(ctx, nonSlice, KNOWN_KEYS, BLOCK);
  return { slices: names.map((name) => parseSlice(name, map, ctx.source)) };
}

function parseSliceNames(
  map: Readonly<Record<string, unknown>>,
  source: string | null,
): ReadonlyArray<string> {
  const field = `${BLOCK}.slices`;
  const raw = requireArrayField(
    map["slices"] ?? [],
    field,
    source,
    "must be an array of slice names",
  );
  if (raw.length > RECALL_SLICES_MAX) {
    throw new BrainConfigError(
      `declares ${raw.length} slices; at most ${RECALL_SLICES_MAX} are allowed`,
      field,
      source,
    );
  }
  const seen = new Set<string>();
  for (const name of raw) {
    if (typeof name !== "string" || !RECALL_SLICE_NAME_PATTERN.test(name)) {
      throw new BrainConfigError(
        `slice name ${describe(name)} must match ${RECALL_SLICE_NAME_PATTERN.source}`,
        field,
        source,
      );
    }
    if (seen.has(name)) {
      throw new BrainConfigError(`duplicate slice name '${name}'`, field, source);
    }
    seen.add(name);
  }
  return [...seen];
}

/**
 * Whether a (slash-normalised) `path_prefix` is vault-relative. The search
 * request refuses `..`, a leading `/` and a drive letter at query time, so
 * the slice would then fail on every prompt with no sign of why; all three
 * are load errors here.
 */
function isVaultRelativePrefix(prefix: string): boolean {
  return !prefix.includes("..") && !prefix.startsWith("/") && !/^[A-Za-z]:/.test(prefix);
}

function parseSlice(
  name: string,
  map: Readonly<Record<string, unknown>>,
  source: string | null,
): RecallSliceSpec {
  const key = (field: string): string => `${SLICE_KEY_PREFIX}${name}_${field}`;
  const path = (field: string): string => `${BLOCK}.${key(field)}`;

  const heading = optionalString(map, key("heading"), path("heading"), source) ?? name;
  const rawPrefix = optionalString(map, key("path_prefix"), path("path_prefix"), source);
  const pathPrefix = rawPrefix === undefined ? null : rawPrefix.replaceAll("\\", "/");
  if (pathPrefix !== null && !isVaultRelativePrefix(pathPrefix)) {
    throw new BrainConfigError(
      "must be a vault-relative path without '..', a leading '/' or a drive letter",
      path("path_prefix"),
      source,
    );
  }
  const types = parseTypes(map, key("types"), path("types"), source);
  const limit = readBoundedInt(
    map,
    key("limit"),
    RECALL_SLICE_LIMIT_MIN,
    RECALL_SLICE_LIMIT_MAX,
    path("limit"),
    source,
  );
  const maxChars = readBoundedInt(
    map,
    key("max_chars"),
    RECALL_SLICE_MAX_CHARS_MIN,
    RECALL_SLICE_MAX_CHARS_MAX,
    path("max_chars"),
    source,
  );
  return {
    name,
    heading,
    pathPrefix,
    types,
    limit: limit ?? null,
    maxChars: maxChars ?? null,
  };
}

function optionalString(
  map: Readonly<Record<string, unknown>>,
  key: string,
  field: string,
  source: string | null,
): string | undefined {
  if (!(key in map)) return undefined;
  const value = map[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new BrainConfigError(`must be a non-empty string; got ${describe(value)}`, field, source);
  }
  return value;
}

function parseTypes(
  map: Readonly<Record<string, unknown>>,
  key: string,
  field: string,
  source: string | null,
): ReadonlyArray<string> {
  if (!(key in map)) return [];
  const raw = requireArrayField(map[key], field, source, "must be an array of note types");
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new BrainConfigError(
        `entries must be non-empty strings; got ${describe(entry)}`,
        field,
        source,
      );
    }
  }
  return raw as ReadonlyArray<string>;
}
