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

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";

import {
  EXCLUDED_DIRS,
  extractWikilinks,
  listVaultPages,
  parseFrontmatter,
  writeFrontmatterAtomic,
} from "../../vault.ts";
import type { FrontmatterMap } from "../../types.ts";
import {
  extractFrontmatterRelations,
  normalizeRelationTarget,
} from "../../graph/frontmatter-relations.ts";
import { BRAIN_ROOT_REL, ensureInsideVault } from "../paths.ts";
import { loadVaultMap, resolveTokens } from "./role-tokens.ts";

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
  return [...new Set([...values].filter((v) => v.length > 0))].toSorted();
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

// ----- Import --------------------------------------------------------------

export type GraphImportMode = "skip" | "overwrite" | "merge";

export interface GraphImportResult {
  readonly created: string[];
  readonly skipped: string[];
  readonly overwritten: string[];
  readonly merged: string[];
  /** Node paths refused because they escaped the vault. */
  readonly rejected: string[];
}

/** Shape the importer reads from a graph node (loosely typed for JSON input). */
interface GraphNodeInput {
  readonly path: string;
  readonly title?: string;
  readonly links?: ReadonlyArray<string>;
  readonly relations?: Readonly<Record<string, ReadonlyArray<string>>>;
}

/**
 * Render a deterministic page stub. Single-target relations land in
 * frontmatter (the only form OSB's frontmatter parser round-trips);
 * body wikilinks list the links. Multi-target relations are flattened
 * into the body links (type not preserved - a documented limitation of
 * the frontmatter parser).
 */
function renderStub(
  title: string,
  links: ReadonlyArray<string>,
  relations: Readonly<Record<string, ReadonlyArray<string>>>,
): [FrontmatterMap, string] {
  const meta: FrontmatterMap = { title };
  const bodyTargets = new Set(links);
  for (const [relation, targets] of Object.entries(relations)) {
    if (targets.length === 1) meta[relation] = `[[${targets[0]}]]`;
    else for (const t of targets) bodyTargets.add(t);
  }
  const sorted = [...bodyTargets].filter((t) => t.length > 0).toSorted();
  const body = sorted.length > 0 ? sorted.map((t) => `- [[${t}]]`).join("\n") + "\n" : "";
  return [meta, body];
}

function readExisting(path: string): { links: string[]; relations: Record<string, string[]> } {
  const [meta, body] = parseFrontmatter(path);
  const links = extractWikilinks(body)
    .map((t) => normalizeRelationTarget(t))
    .filter((t): t is string => t !== null);
  const relations: Record<string, string[]> = {};
  for (const edge of extractFrontmatterRelations(meta)) {
    (relations[edge.relation] ??= []).push(edge.target);
  }
  return { links, relations };
}

/**
 * Reconstruct vault page stubs from a graph under one conflict mode.
 * `skip` (default) never overwrites and is idempotent; `overwrite`
 * replaces; `merge` unions wikilinks + relations with the existing page.
 * Every write is guarded by {@link ensureInsideVault}.
 */
export function importVaultGraph(
  vault: string,
  graph: { nodes?: ReadonlyArray<GraphNodeInput> },
  opts: { mode?: GraphImportMode } = {},
): GraphImportResult {
  const mode: GraphImportMode = opts.mode ?? "skip";
  const result: GraphImportResult = {
    created: [],
    skipped: [],
    overwritten: [],
    merged: [],
    rejected: [],
  };

  const vaultMap = loadVaultMap(vault);
  for (const node of graph.nodes ?? []) {
    // Resolve `{{role}}` tokens in the target path via the vault-map so a
    // portable graph can address user folders abstractly (v0.22.0).
    const relPath = resolveTokens(vaultMap, node.path);
    let path: string;
    try {
      path = ensureInsideVault(join(vault, relPath), vault);
    } catch {
      result.rejected.push(node.path);
      continue;
    }
    const title = node.title ?? node.path;
    const incomingLinks = node.links ?? [];
    const incomingRelations = node.relations ?? {};
    const exists = existsSync(path);

    if (exists && mode === "skip") {
      result.skipped.push(node.path);
      continue;
    }

    let links: ReadonlyArray<string> = incomingLinks;
    let relations: Record<string, ReadonlyArray<string>> = { ...incomingRelations };
    if (exists && mode === "merge") {
      const prev = readExisting(path);
      links = [...new Set([...prev.links, ...incomingLinks])];
      const merged: Record<string, string[]> = {};
      for (const [rel, targets] of Object.entries(prev.relations)) merged[rel] = [...targets];
      for (const [rel, targets] of Object.entries(incomingRelations)) {
        merged[rel] = [...new Set([...(merged[rel] ?? []), ...targets])];
      }
      relations = merged;
    }

    const [meta, body] = renderStub(title, links, relations);
    mkdirSync(dirname(path), { recursive: true });
    writeFrontmatterAtomic(path, meta, body, { overwrite: true, vaultForRelativePath: vault });

    if (!exists) result.created.push(node.path);
    else if (mode === "merge") result.merged.push(node.path);
    else result.overwritten.push(node.path);
  }

  return result;
}
