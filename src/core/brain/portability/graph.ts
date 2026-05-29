/**
 * Vault graph export/import (Vault portability suite, Feature 5).
 *
 * `exportVaultGraph` serialises the user's vault pages (excluding the
 * Brain machinery root and the standard ignored dirs) into a stable,
 * sorted `graph.json`: one node per page with its wikilinks and typed
 * relations. Re-export is byte-identical (everything sorted, no
 * timestamps), so the format is a deterministic interchange artifact.
 *
 * The importer (`importVaultGraph`, Feature 5 Task 4) reconstructs page
 * stubs under three conflict modes.
 */

import { posix, relative } from "node:path";

import {
  EXCLUDED_DIRS,
  extractWikilinks,
  listVaultPages,
  parseFrontmatter,
} from "../../vault.ts";
import type { FrontmatterMap } from "../../types.ts";
import {
  extractFrontmatterRelations,
  normalizeRelationTarget,
} from "../../graph/frontmatter-relations.ts";
import { BRAIN_ROOT_REL } from "../paths.ts";

export const GRAPH_VERSION = "1";

/** Typed-relation frontmatter fields (v0.19.0) carried in the graph. */
export const RELATION_FIELDS = ["related", "extends", "contradicts", "superseded_by"] as const;

export interface VaultGraphNode {
  /** Obsidian basename id (wikilink target). */
  readonly id: string;
  /** Vault-relative POSIX path. */
  readonly path: string;
  readonly title: string;
  /** Sorted, de-duplicated wikilink targets in the body. */
  readonly links: ReadonlyArray<string>;
  /** Typed relations -> sorted target lists (only non-empty fields present). */
  readonly relations: Readonly<Record<string, ReadonlyArray<string>>>;
}

export interface VaultGraph {
  readonly version: string;
  readonly nodes: ReadonlyArray<VaultGraphNode>;
}

function stem(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.md$/i, "");
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set([...values].filter((v) => v.length > 0))].sort();
}

function collectRelations(meta: FrontmatterMap): Record<string, ReadonlyArray<string>> {
  const grouped = new Map<string, string[]>();
  for (const edge of extractFrontmatterRelations(meta)) {
    const arr = grouped.get(edge.relation);
    if (arr) arr.push(edge.target);
    else grouped.set(edge.relation, [edge.target]);
  }
  const out: Record<string, ReadonlyArray<string>> = {};
  for (const [relation, targets] of grouped) out[relation] = sortedUnique(targets);
  return out;
}

/**
 * Export every user vault page (Brain machinery excluded) as a stable,
 * sorted graph. Pure and read-only.
 */
export function exportVaultGraph(vault: string): VaultGraph {
  const pages = listVaultPages(vault, { skipDirs: [...EXCLUDED_DIRS, BRAIN_ROOT_REL] });
  const nodes: VaultGraphNode[] = [];
  for (const page of pages) {
    let body: string;
    let meta: FrontmatterMap;
    try {
      const [m, b] = parseFrontmatter(page.path);
      meta = m;
      body = b;
    } catch {
      continue;
    }
    const links = sortedUnique(
      extractWikilinks(body)
        .map((t) => normalizeRelationTarget(t))
        .filter((t): t is string => t !== null),
    );
    nodes.push({
      id: stem(page.path),
      path: relative(vault, page.path).split(/[\\/]/).join(posix.sep),
      title: page.title,
      links,
      relations: collectRelations(meta),
    });
  }
  nodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.path < b.path ? -1 : 1));
  return { version: GRAPH_VERSION, nodes };
}
