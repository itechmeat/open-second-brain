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

import { memoryFromStore, storePagesIn } from "../memory-pages.ts";
import { parseFrontmatter } from "../../vault.ts";
import { brainDirs } from "../paths.ts";
import { requireVaultAdapter, WIKILINK_AUDIT } from "../../vault-adapter/index.ts";

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
export function buildAliasIndex(vaultOrNull: string | null): AliasIndex {
  const vault = requireVaultAdapter(vaultOrNull, WIKILINK_AUDIT.aliasIndex);
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
export function listAliasClaims(vaultOrNull: string | null): AliasClaims {
  const vault = requireVaultAdapter(vaultOrNull, WIKILINK_AUDIT.aliasIndex);
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
  // Store-only (task 2.10): the preference fold's records, read as the
  // pages they would be.
  const fromStore = memoryFromStore(vault);
  const pagesOf = (dir: string): ReadonlyArray<AliasPage> =>
    fromStore
      ? storePagesIn(vault, dir).map((page) => ({ name: `${page.id}.md`, meta: () => page.meta }))
      : legacyPages(dir);
  const preferences = pagesOf(dirs.preferences);
  const retired = pagesOf(dirs.retired);
  collectCanonicalNames(preferences, reservedCanonical);
  collectCanonicalNames(retired, reservedCanonical);

  // A single sorted pass yields a deterministic claim order. Sorting
  // by `(kind, basename)` puts `pref-*` before `ret-*`; within each
  // kind, alphabetical basename order comes first.
  collect(preferences, reservedCanonical, visit);
  collect(retired, reservedCanonical, visit);
}

/** One `.md` page of a folder: its file name and how to read its frontmatter. */
interface AliasPage {
  readonly name: string;
  readonly meta: () => Record<string, unknown>;
}

function legacyPages(dir: string): ReadonlyArray<AliasPage> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((name) => ({
    name,
    meta: () => parseFrontmatter(join(dir, name))[0] as Record<string, unknown>,
  }));
}

function collectCanonicalNames(pages: ReadonlyArray<AliasPage>, into: Set<string>): void {
  for (const { name } of pages) {
    if (!name.endsWith(".md")) continue;
    const canonicalId = name.slice(0, -".md".length);
    into.add(canonicalId.normalize("NFC").toLowerCase());
  }
}

function collect(
  pages: ReadonlyArray<AliasPage>,
  reservedCanonical: ReadonlySet<string>,
  visit: (key: string, canonicalId: string) => void,
): void {
  // Sort the listing so the claim order is deterministic across
  // filesystems that don't enumerate in stable order.
  const entries = pages.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const { name, meta: read } of entries) {
    if (!name.endsWith(".md")) continue;
    const canonicalId = name.slice(0, -".md".length);
    let meta: Record<string, unknown>;
    try {
      meta = read();
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
