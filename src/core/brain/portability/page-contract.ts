/**
 * Page interchange contract (Brain Portability & Interop suite, Unit B).
 *
 * `projectPageContracts` serialises every user vault page (the Brain
 * machinery root and the standard ignored dirs excluded) into a stable,
 * sorted, schema-versioned interchange record a downstream importer can
 * consume without knowing OSB internals. Each record carries the page's
 * `path`, `kind`, advisory `confidence`/`provenance`, flattened
 * `citations`, `aliases`, and `freshness`.
 *
 * Derivation is structural only - frontmatter fields, body wikilinks,
 * typed-relation targets, and the file mtime. The provider-agnostic
 * kernel never synthesises a field, and no natural-language heuristic
 * (keyword/title matching in any language) is used: an absent advisory
 * field is reported as `null`, never guessed.
 */

import { statSync } from "node:fs";
import { posix, relative } from "node:path";

import { EXCLUDED_DIRS, extractWikilinks, listVaultPages, parseFrontmatter } from "../../vault.ts";
import type { FrontmatterMap, FrontmatterValue } from "../../types.ts";
import {
  extractFrontmatterRelations,
  normalizeRelationTarget,
} from "../../graph/frontmatter-relations.ts";
import { BRAIN_ROOT_REL } from "../paths.ts";
import { isoSecond } from "../time.ts";

export const PAGE_CONTRACT_VERSION = "1";

/** Structural default `kind` for a page with no frontmatter `kind:` field. */
export const DEFAULT_PAGE_KIND = "note";

export interface PageContract {
  /** Vault-relative POSIX path. */
  readonly path: string;
  /** Frontmatter `kind:` when present, else the structural default. */
  readonly kind: string;
  /** Advisory: frontmatter `confidence` (number or string) when present. */
  readonly confidence: number | string | null;
  /** Advisory: frontmatter `provenance` string when present. */
  readonly provenance: string | null;
  /** Sorted-unique body wikilink + typed-relation targets. */
  readonly citations: ReadonlyArray<string>;
  /** Frontmatter `aliases`, else empty. */
  readonly aliases: ReadonlyArray<string>;
  /** Frontmatter `updated_at`/`updated` else the file mtime (ISO second). */
  readonly freshness: string | null;
}

/** Frontmatter timestamp fields, in precedence order, for `freshness`. */
const FRESHNESS_FIELDS = ["updated_at", "updated"] as const;

function stringField(meta: FrontmatterMap, key: string): string | null {
  const value: FrontmatterValue | undefined = meta[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function confidenceField(meta: FrontmatterMap): number | string | null {
  const value: FrontmatterValue | undefined = meta["confidence"];
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.length > 0) return value;
  return null;
}

function aliasField(meta: FrontmatterMap): ReadonlyArray<string> {
  const value: FrontmatterValue | undefined = meta["aliases"];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set([...values].filter((v) => v.length > 0))].toSorted();
}

/**
 * Collect a page's citations: every body wikilink plus every typed
 * relation target, normalised, de-duplicated, and sorted. Reuses the
 * same extraction the graph exporter uses so the contract stays
 * decoupled from any natural-language parsing.
 */
function collectCitations(meta: FrontmatterMap, body: string): string[] {
  const targets: string[] = [];
  for (const raw of extractWikilinks(body)) {
    const norm = normalizeRelationTarget(raw);
    if (norm !== null) targets.push(norm);
  }
  for (const edge of extractFrontmatterRelations(meta)) targets.push(edge.target);
  return sortedUnique(targets);
}

function freshnessOf(meta: FrontmatterMap, absPath: string): string | null {
  for (const field of FRESHNESS_FIELDS) {
    const stamp = stringField(meta, field);
    if (stamp !== null) return stamp;
  }
  try {
    return isoSecond(statSync(absPath).mtime);
  } catch {
    // A page that listed but cannot be stat'd has no derivable freshness;
    // report null rather than fabricating a timestamp.
    return null;
  }
}

/**
 * Project every user vault page to a {@link PageContract}, sorted by
 * `path` for deterministic output. Pure and read-only.
 */
export function projectPageContracts(vault: string): ReadonlyArray<PageContract> {
  const pages = listVaultPages(vault, { skipDirs: [...EXCLUDED_DIRS, BRAIN_ROOT_REL] });
  const contracts: PageContract[] = [];
  for (const page of pages) {
    let body: string;
    try {
      const [, parsedBody] = parseFrontmatter(page.path);
      body = parsedBody;
    } catch {
      continue;
    }
    const meta = page.metadata;
    contracts.push({
      path: relative(vault, page.path).split(/[\\/]/).join(posix.sep),
      kind: stringField(meta, "kind") ?? DEFAULT_PAGE_KIND,
      confidence: confidenceField(meta),
      provenance: stringField(meta, "provenance"),
      citations: collectCitations(meta, body),
      aliases: aliasField(meta),
      freshness: freshnessOf(meta, page.path),
    });
  }
  contracts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return contracts;
}
