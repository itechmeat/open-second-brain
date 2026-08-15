/**
 * Shared constants, rule types and the path-coverage predicate for the
 * Vault Scope module.
 *
 * Split out of `index.ts` so `src/core/brain/policy.ts` can read the
 * default exclusion set without dragging in the resolver — the
 * resolver imports `policy.ts`, which would otherwise create a
 * module-initialisation cycle.
 *
 * That cycle-safety is why {@link pathCovers} lives here rather than in
 * any of the five modules that used to carry a private copy: this leaf
 * reaches nothing but the path constants, so the write-binding grammar,
 * the index-admission lane check, the note walker, the search indexer
 * and the snapshot manifest can all import it without closing a loop.
 *
 * Anchored in docs/plans/2026-05-19-vault-scope-design.md §5.
 */

import { BRAIN_SNAPSHOTS_REL } from "../brain/paths.ts";

/**
 * The ONE separator this grammar knows. Every path it is handed is
 * vault-relative POSIX: the walkers build theirs by joining directory
 * entries with `/`, and `inspectPath` converts the native separator
 * before it hands anything over.
 *
 * A backslash is DELIBERATELY not a separator. On POSIX it is an
 * ordinary filename character, so splitting on it reads structure into
 * a name: a prefix of `Projects` would cover the literal one-segment
 * filename `Projects\evil.md`, which lands at the vault ROOT. Callers
 * that can receive a host path refuse a backslash-bearing one outright
 * (`brain/notes/create-note.ts`, `assertHostPathSeparators`) rather
 * than letting this module guess which reading was meant.
 */
const POSIX_SEP = "/";

/**
 * One declared entry, classified. POLARITY-FREE by design: the same
 * shape carries an exclusion (`vault.ignore_paths`) and an inclusion
 * (`vault.include_paths`), and the matcher reads both through one
 * grammar. Two readings of the same string - a bare name meaning
 * "anywhere" on one key and "at the root" on the other - is precisely
 * the drift this module exists to prevent, so the include side inherits
 * the depth-agnostic reading rather than inventing a second syntax.
 */
export interface VaultPathRule {
  /** Entry exactly as written in `Brain/_brain.yaml`. */
  readonly raw: string;
  /**
   * `name` matches any directory whose basename equals `raw`,
   * anywhere in the tree. `path` matches a vault-relative POSIX
   * path exactly.
   */
  readonly kind: "name" | "path";
}

/**
 * The resolved scope, both polarities in one value.
 *
 * `include` is `null` when the operator declared no allowlist, which is
 * every vault that predates the key and every vault that does not want
 * one. It is NEVER an empty array: a list that admits no path is an off
 * switch on indexing rather than a boundary, and the block parser
 * refuses it at parse time so the distinction cannot arrive here as a
 * shape the matcher has to guess about.
 */
export interface VaultScopeRules {
  readonly ignore: ReadonlyArray<VaultPathRule>;
  readonly include: ReadonlyArray<VaultPathRule> | null;
}

export const DEFAULT_VAULT_IGNORE_PATHS: ReadonlyArray<string> = Object.freeze([
  ".git",
  "node_modules",
  ".open-second-brain",
  ".obsidian",
  ".trash",
  ".stversions",
  BRAIN_SNAPSHOTS_REL,
]);

/**
 * Classify a raw entry into a {@link VaultPathRule}. Shared by both
 * keys under `vault:` - one grammar, one normalisation, no second
 * reading of the same string.
 *
 * Normalises three operator footguns that would silently disable a
 * rule otherwise — the matcher walks prefixes with no trailing
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
export function classifyVaultPathRule(raw: string): VaultPathRule {
  const normalised = normaliseRawRule(raw);
  return { raw: normalised, kind: normalised.includes("/") ? "path" : "name" };
}

function normaliseRawRule(raw: string): string {
  let s = raw.startsWith("./") ? raw.slice(2) : raw;
  s = s.replace(/\/+/g, "/");
  s = s.replace(/\/+$/g, "");
  return s;
}

// ----- path coverage -------------------------------------------------------

/**
 * Canonical form of a vault-relative POSIX path: no empty segments (so
 * no leading, trailing or repeated slash) and no `.` segments.
 *
 * Returns the empty string for a path that carries no segments at all
 * (`""`, `.`, `/`, `///`). That is the vault ROOT, not a usable prefix —
 * a declaration that normalises to it would cover the whole vault, and
 * the block parsers refuse it rather than letting a typo widen a
 * boundary.
 *
 * `..` is left alone: it is a segment like any other here. Resolving it
 * would be traversal, and the callers that can receive an untrusted path
 * reject it before this module ever sees it.
 */
export function normalisePathSegments(raw: string): string {
  const segments: string[] = [];
  for (const segment of raw.split(POSIX_SEP)) {
    if (segment === "" || segment === ".") continue;
    segments.push(segment);
  }
  return segments.join(POSIX_SEP);
}

/**
 * Whether `relPath` lies at or under `prefix`, SEGMENT-WISE.
 *
 * Segment-wise is the whole point. A character-prefix test would let a
 * prefix of `Notes` cover `Notes-archive/x.md`, so every declaration
 * would silently reach a folder the operator never named — the same
 * failure whether the prefix is a write binding, an indexed root, a
 * lane boundary or a snapshot exclusion.
 *
 * `prefix` must ALREADY be canonical; only `relPath` is normalised. A
 * prefix that kept its trailing slash therefore covers nothing, which is
 * the honest answer: `Notes/` is a declaration this grammar cannot
 * express, and reading it as `Notes` would be a guess. Every caller
 * normalises its prefixes at the boundary where they are declared.
 *
 * The empty prefix covers the vault root and nothing else, because a
 * normalised target never starts with a separator. That is deliberate:
 * an empty prefix is a declaration that named no folder, and it must not
 * degrade into match-everything.
 */
export function pathCovers(prefix: string, relPath: string): boolean {
  const target = normalisePathSegments(relPath);
  if (target === prefix) return true;
  return target.startsWith(prefix + POSIX_SEP);
}
