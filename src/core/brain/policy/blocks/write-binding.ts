/**
 * The `write_binding:` block — where a CALLER-NAMED write may land.
 *
 * One reason to change: what an operator may declare as a write
 * boundary, and which shapes of declaration are refused outright.
 *
 * Shape problems are hard errors rather than dropped entries, for the
 * same reason `vault.ignore_paths` treats them that way: an entry that
 * silently disabled itself would widen a boundary the operator believes
 * is in force, which is worse than declaring no boundary at all.
 *
 * The block is OPTIONAL and its absence is the historical behaviour. So
 * is a block present without `path_prefixes` — the binding is made of
 * that key, and a block that omits it has declared nothing, exactly as
 * `vault:` without `ignore_paths` falls back to the defaults.
 *
 * An EMPTY list is the one shape refused rather than honoured. A prefix
 * list that admits no path is not a boundary, it is an off switch on the
 * caller-named write surface; the way to run unbound is to remove the
 * block, and conflating the two would leave an operator who mistyped a
 * list unable to tell a disabled surface from a bounded one.
 */

import type { BrainWriteBindingConfig } from "../../types.ts";
import { BrainConfigError } from "../errors.ts";
import { assertNoYamlUnsafeChars, describe, requireArrayField } from "../field-checks.ts";
import { openBlock, warnUnknownKeys, type BlockParseContext } from "../key-index.ts";
import { normaliseWriteBindingPrefix } from "../../../write-binding/prefix.ts";

const BLOCK = "write_binding";
const PREFIXES_KEY = "path_prefixes";
const PREFIXES_FIELD = `${BLOCK}.${PREFIXES_KEY}`;

/**
 * Shape:
 *   write_binding:
 *     path_prefixes:
 *       - Projects
 *       - Journal/Weekly
 */
export function parseWriteBindingBlock(
  ctx: BlockParseContext,
): BrainWriteBindingConfig | undefined {
  const rawMap = openBlock(ctx, BLOCK);
  if (rawMap === undefined) return undefined;

  let block: BrainWriteBindingConfig | undefined;
  if (PREFIXES_KEY in rawMap) {
    const list = requireArrayField(
      rawMap[PREFIXES_KEY],
      PREFIXES_FIELD,
      ctx.source,
      `must be a list of vault-relative paths; got ${describe(rawMap[PREFIXES_KEY])}`,
    );
    if (list.length === 0) {
      throw new BrainConfigError(
        "must declare at least one prefix; a list that admits no path is an off switch " +
          `on caller-named writes rather than a boundary. Remove the '${BLOCK}' block to ` +
          "run unbound.",
        PREFIXES_FIELD,
        ctx.source,
      );
    }
    const validated = list.map((entry, i) =>
      cleanPrefix(entry, `${PREFIXES_FIELD}[${i}]`, ctx.source),
    );
    block = { path_prefixes: Object.freeze(validated) };
  }
  warnUnknownKeys(ctx, rawMap, [PREFIXES_KEY], BLOCK);
  return block;
}

/**
 * One declared prefix, validated and normalised to the vault-relative
 * POSIX form the matcher compares against. Every refusal names the
 * indexed field, so the operator sees which entry is wrong rather than
 * that some entry is.
 */
function cleanPrefix(entry: unknown, field: string, source: string | null): string {
  if (typeof entry !== "string") {
    throw new BrainConfigError(`must be a string; got ${describe(entry)}`, field, source);
  }
  const trimmed = entry.trim();
  if (trimmed.length === 0) {
    throw new BrainConfigError("must be a non-empty string", field, source);
  }
  assertNoYamlUnsafeChars(trimmed, field, source, "use a simple one-line path");
  if (trimmed.startsWith("/") || trimmed.startsWith("\\")) {
    throw new BrainConfigError(
      "must be a vault-relative path without a leading slash",
      field,
      source,
    );
  }
  if (trimmed.split(/[\\/]/).some((segment) => segment === "..")) {
    throw new BrainConfigError(
      "must not contain '..' segments; a prefix that can traverse out of the vault bounds " +
        "nothing",
      field,
      source,
    );
  }
  const normalised = normaliseWriteBindingPrefix(trimmed);
  if (normalised.length === 0) {
    throw new BrainConfigError(
      "normalises to the empty string, which would admit the whole vault; name a real " +
        "folder or vault-relative path",
      field,
      source,
    );
  }
  return normalised;
}
