/**
 * The `vault:` block — the vault-wide exclusion list every walker obeys.
 *
 * One reason to change: what an exclusion entry may look like. Shape
 * problems are hard errors rather than dropped entries: exclusions affect
 * the search indexer, `scan-inline` and every future walker, so an entry
 * that silently disabled itself would be a fail-open footgun.
 */

import type { BrainVaultConfig } from "../../types.ts";
import { BrainConfigError } from "../errors.ts";
import { assertNoYamlUnsafeChars, describe, requireArrayField } from "../field-checks.ts";
import { openBlock, warnUnknownKeys, type BlockParseContext } from "../key-index.ts";
import { classifyVaultIgnoreRule } from "../../../vault-scope/defaults.ts";

const BLOCK = "vault";

/**
 * The block is absent for vaults created before v0.10.9 and for
 * operators who explicitly removed it; the resolver falls back to
 * `DEFAULT_VAULT_IGNORE_PATHS` in both cases.
 */
export function parseVaultBlock(ctx: BlockParseContext): BrainVaultConfig | undefined {
  const rawMap = openBlock(ctx, BLOCK);
  if (rawMap === undefined) return undefined;

  let vault: BrainVaultConfig | undefined;
  if ("ignore_paths" in rawMap) {
    const list = requireArrayField(
      rawMap["ignore_paths"],
      "vault.ignore_paths",
      ctx.source,
      `must be a list of strings; got ${describe(rawMap["ignore_paths"])}`,
    );
    const validated = list.map((entry, i) =>
      normaliseIgnorePath(entry, `vault.ignore_paths[${i}]`, ctx.source),
    );
    vault = { ignore_paths: Object.freeze(validated) };
  }
  warnUnknownKeys(ctx, rawMap, ["ignore_paths"], BLOCK);
  return vault;
}

function normaliseIgnorePath(entry: unknown, field: string, source: string | null): string {
  if (typeof entry !== "string") {
    throw new BrainConfigError(`must be a string; got ${describe(entry)}`, field, source);
  }
  const trimmed = entry.trim();
  if (trimmed.length === 0) {
    throw new BrainConfigError("must be a non-empty string", field, source);
  }
  assertNoYamlUnsafeChars(trimmed, field, source, "use a simple one-line path");
  // `classifyVaultIgnoreRule` strips leading `./` / trailing
  // `/` / collapsing `//`. An entry that normalises to the
  // empty string (`./`, `/`, `///`) would silently disable
  // itself; reject so the operator sees the typo immediately.
  const normalised = classifyVaultIgnoreRule(trimmed).raw;
  if (normalised.length === 0) {
    throw new BrainConfigError(
      "normalises to the empty string; use a real directory name or vault-relative path",
      field,
      source,
    );
  }
  // Reject leading-slash entries explicitly. `matchIgnore` only
  // compares vault-relative POSIX prefixes (no leading `/`), so
  // `/Brain/.snapshots` would silently never match — exactly the
  // fail-closed contract violation the v0.10.9 policy forbids.
  if (normalised.startsWith("/")) {
    throw new BrainConfigError(
      "must be a bare name or vault-relative POSIX path without a leading '/'",
      field,
      source,
    );
  }
  return normalised;
}
