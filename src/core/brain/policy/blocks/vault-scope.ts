/**
 * The `vault:` block — what is part of the vault, in both polarities.
 *
 * One reason to change: what an operator may declare as a vault
 * boundary, and which shapes of declaration are refused outright. The
 * module was `vault-ignore.ts` while `ignore_paths` was the only key;
 * the name stopped being true when `include_paths` arrived, so it was
 * renamed rather than left to describe half of what it parses.
 *
 * Shape problems are hard errors rather than dropped entries: the
 * boundary governs the search indexer, `scan-inline` and every future
 * walker, so an entry that silently disabled itself would be a
 * fail-open footgun.
 *
 * ## The empty list means two different things, deliberately
 *
 * `ignore_paths: []` keeps its documented meaning of "exclude nothing",
 * which is a coherent request with a visible effect.
 *
 * `include_paths: []` is REFUSED, for the reason `write_binding`
 * refuses an empty prefix list: a list that admits no path is not a
 * boundary, it is an off switch on indexing, and an operator who
 * mistyped a list could not tell a disabled vault from a bounded one.
 * The way to index everything is to remove the key. The asymmetry is
 * not an oversight - it follows from the polarity. An empty exclusion
 * list excludes nothing and everything still works; an empty allowlist
 * admits nothing and the index goes empty.
 *
 * ## One grammar for both keys
 *
 * Both lists are normalised by {@link normaliseVaultPathEntry} and
 * classified by `classifyVaultPathRule`, so an entry means the same
 * thing on either key: no slash is a bare NAME matched at any depth, a
 * slash is a vault-relative path matched exactly. `include_paths:
 * [Brain]` therefore also admits a nested `projects/Brain/`. Giving the
 * include side a second reading of the same string would be two
 * grammars for one syntax, which is the drift the vault-scope module
 * exists to prevent; an operator who means exactly one place names a
 * path (`Notes/Daily`) rather than a bare name.
 */

import type { BrainVaultConfig } from "../../types.ts";
import { BrainConfigError } from "../errors.ts";
import { assertNoYamlUnsafeChars, describe, requireArrayField } from "../field-checks.ts";
import { openBlock, warnUnknownKeys, type BlockParseContext } from "../key-index.ts";
import { classifyVaultPathRule } from "../../../vault-scope/defaults.ts";

const BLOCK = "vault";
const IGNORE_KEY = "ignore_paths";
const INCLUDE_KEY = "include_paths";
const IGNORE_FIELD = `${BLOCK}.${IGNORE_KEY}`;
const INCLUDE_FIELD = `${BLOCK}.${INCLUDE_KEY}`;

/**
 * The block is absent for vaults created before v0.10.9 and for
 * operators who explicitly removed it; the resolver falls back to
 * `DEFAULT_VAULT_IGNORE_PATHS` with no allowlist in both cases.
 *
 * Shape:
 *   vault:
 *     ignore_paths:
 *       - .obsidian
 *     include_paths:
 *       - Brain
 */
export function parseVaultBlock(ctx: BlockParseContext): BrainVaultConfig | undefined {
  const rawMap = openBlock(ctx, BLOCK);
  if (rawMap === undefined) return undefined;

  const ignorePaths = parseList(ctx, rawMap, IGNORE_KEY, IGNORE_FIELD);
  const includePaths = parseList(ctx, rawMap, INCLUDE_KEY, INCLUDE_FIELD);
  if (includePaths !== undefined && includePaths.length === 0) {
    throw new BrainConfigError(
      "must name at least one root; a list that admits no path is an off switch on " +
        `indexing rather than a boundary. Remove '${INCLUDE_FIELD}' to index the whole ` +
        "vault minus the exclusions.",
      INCLUDE_FIELD,
      ctx.source,
    );
  }
  warnUnknownKeys(ctx, rawMap, [IGNORE_KEY, INCLUDE_KEY], BLOCK);

  if (ignorePaths === undefined && includePaths === undefined) return undefined;
  return Object.freeze({
    ...(ignorePaths !== undefined ? { [IGNORE_KEY]: ignorePaths } : {}),
    ...(includePaths !== undefined ? { [INCLUDE_KEY]: includePaths } : {}),
  });
}

/**
 * One declared list, validated entry by entry, or `undefined` when the
 * key is absent. Absent and empty are kept apart here so the caller can
 * apply the polarity-specific rule about what an empty list means.
 */
function parseList(
  ctx: BlockParseContext,
  rawMap: Record<string, unknown>,
  key: string,
  field: string,
): ReadonlyArray<string> | undefined {
  if (!(key in rawMap)) return undefined;
  const list = requireArrayField(
    rawMap[key],
    field,
    ctx.source,
    `must be a list of strings; got ${describe(rawMap[key])}`,
  );
  return Object.freeze(
    list.map((entry, i) => normaliseVaultPathEntry(entry, `${field}[${i}]`, ctx.source)),
  );
}

/**
 * One declared entry, validated and normalised to the vault-relative
 * POSIX form the matcher compares against. Shared by both keys: an
 * entry that is refused under one polarity is refused under the other,
 * and every refusal names the indexed field so the operator sees WHICH
 * entry is wrong rather than that some entry is.
 */
function normaliseVaultPathEntry(entry: unknown, field: string, source: string | null): string {
  if (typeof entry !== "string") {
    throw new BrainConfigError(`must be a string; got ${describe(entry)}`, field, source);
  }
  const trimmed = entry.trim();
  if (trimmed.length === 0) {
    throw new BrainConfigError("must be a non-empty string", field, source);
  }
  assertNoYamlUnsafeChars(trimmed, field, source, "use a simple one-line path");
  // `classifyVaultPathRule` strips leading `./` / trailing
  // `/` / collapsing `//`. An entry that normalises to the
  // empty string (`./`, `/`, `///`) would silently disable
  // itself; reject so the operator sees the typo immediately.
  const normalised = classifyVaultPathRule(trimmed).raw;
  if (normalised.length === 0) {
    throw new BrainConfigError(
      "normalises to the empty string; use a real directory name or vault-relative path",
      field,
      source,
    );
  }
  // Reject leading-slash entries explicitly. The matcher only
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
  // Reject a `..` segment for the same reason and a sharper one. The
  // walkers only ever produce vault-relative paths with no upward segment,
  // so a rule carrying one matches nothing they will ever hand it: on the
  // ignore side that is an exclusion that silently excludes nothing, and on
  // the include side it is an allowlist that admits nothing, which empties
  // the whole index. The dead-root check cannot catch that one either,
  // because `existsSync` on a climbing path resolves OUTSIDE the vault and
  // answers true for a directory the vault does not contain. The parser is
  // the only place that can see it, so it refuses here.
  if (normalised.split("/").includes("..")) {
    throw new BrainConfigError(
      "must stay inside the vault; a '..' segment matches no path the walkers produce",
      field,
      source,
    );
  }
  return normalised;
}
