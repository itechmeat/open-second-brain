/**
 * Alias index over the Brain artifact set.
 *
 * Obsidian-flavoured frontmatter allows a note to declare extra
 * lookup names via `aliases: [foo, bar]`. The backlink index, the
 * unlinked-mentions scanner, and the concept-cluster assembler all
 * need to resolve a wikilink target `[[foo]]` to the canonical
 * artifact id even when `foo` is an alias rather than the bare
 * basename.
 *
 * `buildAliasIndex` is a single-pass read over
 * `Brain/preferences/` + `Brain/retired/`. Each declared alias is
 * NFC-normalised and lower-cased to form the lookup key; the value
 * is the canonical artifact id (file basename without `.md`).
 *
 * Collisions (two artifacts claim the same alias) resolve
 * first-wins by sorted canonical id - deterministic without an
 * extra timestamp lookup. A caller that must refuse a colliding
 * alias instead of guessing reads `listAliasClaims`, which keeps
 * every claimant. A follow-up `brain_doctor` lint can
 * later surface colliding aliases for operator attention; this
 * helper is intentionally tolerant so the index keeps building.
 *
 * Empty / non-array `aliases` values are silently skipped. Malformed
 * frontmatter (parse failure) is silently skipped - `brain_doctor`
 * surfaces those separately.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { parseFrontmatter } from "../../vault.ts";
import { brainDirs } from "../paths.ts";

/**
 * Frozen `aliasLowerNFC → canonicalId` map. Keys are pre-normalised
 * so callers should normalise their lookup key the same way (NFC +
 * lower-case) before consulting the map.
 */
export type AliasIndex = ReadonlyMap<string, string>;

/**
 * Walk Brain preferences + retired artifacts, collect their
 * frontmatter `aliases:` arrays, and return the inverted lookup.
 *
 * The returned map is frozen. Re-call to refresh; there is no
 * incremental update path on purpose.
 */
export function buildAliasIndex(vault: string): AliasIndex {
  const map = new Map<string, string>();
  // First-wins: only set when the key isn't taken yet.
  forEachAliasClaim(vault, (key, canonicalId) => {
    if (!map.has(key)) map.set(key, canonicalId);
  });
  return Object.freeze(map) as AliasIndex;
}

/**
 * Frozen `aliasLowerNFC → canonicalIds` multimap: every artifact that
 * claims each alias, in the same sorted order whose first entry
 * `buildAliasIndex` keeps. An artifact listing one alias twice is one
 * claimant.
 */
export type AliasClaims = ReadonlyMap<string, ReadonlyArray<string>>;

/**
 * Every claimant of every alias, under the same normalisation and
 * shadowing rules as `buildAliasIndex`, without resolving collisions.
 */
export function listAliasClaims(vault: string): AliasClaims {
  const map = new Map<string, string[]>();
  forEachAliasClaim(vault, (key, canonicalId) => {
    const claimants = map.get(key);
    if (claimants === undefined) map.set(key, [canonicalId]);
    else if (!claimants.includes(canonicalId)) claimants.push(canonicalId);
  });
  return Object.freeze(map) as AliasClaims;
}

/** Visit every (alias key, canonical id) claim in deterministic order. */
function forEachAliasClaim(vault: string, visit: (key: string, canonicalId: string) => void): void {
  const dirs = brainDirs(vault);

  // Collect every on-disk canonical id (lower-cased + NFC) in one
  // pass so the alias-collection phase can skip any alias that
  // collides with a real basename. Without this guard, an alias
  // entry can hijack an existing artifact's backlinks.
  const reservedCanonical = new Set<string>();
  collectCanonicalNames(dirs.preferences, reservedCanonical);
  collectCanonicalNames(dirs.retired, reservedCanonical);

  // A single sorted pass yields a deterministic claim order. Sorting
  // by `(kind, basename)` puts `pref-*` before `ret-*`; within each
  // kind, alphabetical basename order comes first.
  collect(dirs.preferences, reservedCanonical, visit);
  collect(dirs.retired, reservedCanonical, visit);
}

function collectCanonicalNames(dir: string, into: Set<string>): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    const canonicalId = name.slice(0, -".md".length);
    into.add(canonicalId.normalize("NFC").toLowerCase());
  }
}

function collect(
  dir: string,
  reservedCanonical: ReadonlySet<string>,
  visit: (key: string, canonicalId: string) => void,
): void {
  if (!existsSync(dir)) return;
  // Sort the directory listing so the claim order is deterministic
  // across filesystems that don't enumerate in stable order.
  const entries = readdirSync(dir).toSorted();
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const canonicalId = name.slice(0, -".md".length);
    let meta: Record<string, unknown>;
    try {
      const [m] = parseFrontmatter(join(dir, name));
      meta = m as Record<string, unknown>;
    } catch {
      continue;
    }
    const aliases = meta["aliases"];
    if (!Array.isArray(aliases)) continue;
    for (const alias of aliases) {
      if (typeof alias !== "string") continue;
      const trimmed = alias.trim();
      if (trimmed.length === 0) continue;
      const key = trimmed.normalize("NFC").toLowerCase();
      // Skip aliases that would shadow an existing on-disk id.
      // The canonical artifact wins; the alias is silently dropped
      // to avoid hijacking its backlinks. A follow-up brain_doctor
      // lint surfaces these collisions for operator attention.
      if (reservedCanonical.has(key)) continue;
      visit(key, canonicalId);
    }
  }
}
