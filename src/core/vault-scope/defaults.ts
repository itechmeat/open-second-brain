/**
 * Shared constants and rule types for the Vault Scope module.
 *
 * Split out of `index.ts` so `src/core/brain/policy.ts` can read the
 * default exclusion set without dragging in the resolver — the
 * resolver imports `policy.ts`, which would otherwise create a
 * module-initialisation cycle.
 *
 * Anchored in docs/plans/2026-05-19-vault-scope-design.md §5.
 */

export interface VaultIgnoreRule {
  /** Entry exactly as written in `Brain/_brain.yaml`. */
  readonly raw: string;
  /**
   * `name` matches any directory whose basename equals `raw`,
   * anywhere in the tree. `path` matches a vault-relative POSIX
   * path exactly.
   */
  readonly kind: "name" | "path";
}

export const DEFAULT_VAULT_IGNORE_PATHS: ReadonlyArray<string> = Object.freeze([
  ".git",
  "node_modules",
  ".open-second-brain",
  ".obsidian",
  ".trash",
  ".stversions",
  "Brain/.snapshots",
]);

/**
 * Classify a raw entry into a `VaultIgnoreRule`.
 *
 * Normalises three operator footguns that would silently disable a
 * rule otherwise — `matchIgnore` walks prefixes with no trailing
 * slash and rejects empty segments, so the raw inputs are made to
 * match that shape:
 *
 *   - leading `./` is stripped (`./Brain/.snapshots` → `Brain/.snapshots`);
 *   - trailing `/` is stripped (`Brain/.snapshots/` → `Brain/.snapshots`);
 *   - runs of `//` are collapsed (`Brain//.snapshots` → `Brain/.snapshots`).
 *
 * After normalisation, an entry with `/` is a path-rule; otherwise
 * it is a bare-name rule. Entries that normalise to the empty string
 * keep their pre-normalisation classification; the policy validator
 * is responsible for rejecting them before they get here.
 */
export function classifyVaultIgnoreRule(raw: string): VaultIgnoreRule {
  const normalised = normaliseRawRule(raw);
  return { raw: normalised, kind: normalised.includes("/") ? "path" : "name" };
}

function normaliseRawRule(raw: string): string {
  let s = raw.startsWith("./") ? raw.slice(2) : raw;
  s = s.replace(/\/+/g, "/");
  s = s.replace(/\/+$/g, "");
  return s;
}
