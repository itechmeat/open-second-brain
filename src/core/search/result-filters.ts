/**
 * Frontmatter-driven post-rank filters and annotations over a ranked
 * result set: the shared per-call frontmatter read cache, property /
 * visibility-scope / agent-ownership filtering, terminal-status
 * collection for evidence downranking, and inline trust metadata.
 */

import { statSync } from "node:fs";
import { join } from "node:path";

import { parseFrontmatter } from "../vault.ts";
import type { FrontmatterMap } from "../types.ts";
import { isVisible, pageVisibility } from "../graph/visibility.ts";
import { isOwnerVisible, pageOwner } from "../graph/agent-scope.ts";
import { applyDegreeFilters, filterByProperties, type DegreePredicate } from "./property-filter.ts";
import { degreeForPath, getGraphSnapshot } from "../brain/link-graph/graph-index.ts";
import type { Store } from "./store.ts";
import { deriveTrust, hasSupersededRelation } from "./enrich.ts";
import { isTerminalStatus } from "./evidence-pack.ts";
import { isTombstoned } from "../brain/lifecycle/tombstone.ts";
import { SUPERSEDE_FADE_MULTIPLIER } from "./ranker.ts";
import {
  keepVerdict,
  multiplyVerdict,
  type RankAdjuster,
  type RankAdjustVerdict,
} from "./rank-adjust.ts";
import type { BrainSearchResult } from "./types.ts";

/**
 * One frontmatter read per (vault, path) pair, shared across every filter
 * stage of a single `search()` call. `parseFrontmatter` never throws (a
 * read failure resolves to empty metadata internally), so caching the raw
 * result changes no call site's fallback behaviour - it only stops the
 * same file being read and parsed once per stage instead of once total.
 */
export function readCachedFrontmatter(
  cache: Map<string, FrontmatterMap>,
  vault: string,
  path: string,
): FrontmatterMap {
  const cached = cache.get(path);
  if (cached !== undefined) return cached;
  const [meta] = parseFrontmatter(join(vault, path));
  cache.set(path, meta);
  return meta;
}

/**
 * Build the set of terminal-state paths for evidence-pack downranking.
 * Reads each unique candidate path's frontmatter `status:` field once
 * and includes the path when the declared status is terminal (controlled
 * vocabulary). A missing or unreadable status is non-terminal. This is
 * the language-agnostic replacement for scanning note prose for English
 * status words.
 */
export function buildTerminalPaths(
  vault: string,
  results: ReadonlyArray<BrainSearchResult>,
  frontmatterCache: Map<string, FrontmatterMap>,
): ReadonlySet<string> {
  const terminal = new Set<string>();
  const seen = new Set<string>();
  for (const r of results) {
    if (seen.has(r.path)) continue;
    seen.add(r.path);
    try {
      const meta = readCachedFrontmatter(frontmatterCache, vault, r.path);
      if (isTerminalStatus((meta as Record<string, unknown>)["status"])) terminal.add(r.path);
    } catch {
      // Unreadable frontmatter is non-terminal.
    }
  }
  return terminal;
}

/**
 * Belief lifecycle suite (t_7d5a3589): drop tombstoned (incl.
 * superseded-non-tip) rows from a ranked result set. A tombstoned memory
 * stays on disk for audit but must not be recalled. Reads each unique
 * path's cached frontmatter once; a vault with no tombstoned entries
 * passes through byte-identically (nothing is dropped).
 */
export function applyStatusFilter(
  ranked: ReadonlyArray<BrainSearchResult>,
  vault: string,
  frontmatterCache: Map<string, FrontmatterMap>,
): ReadonlyArray<BrainSearchResult> {
  return ranked.filter((r) => {
    try {
      return !isTombstoned(readCachedFrontmatter(frontmatterCache, vault, r.path));
    } catch {
      // Unreadable frontmatter is not a tombstone; leave the row in.
      return true;
    }
  });
}

export function applyPropertyFilter(
  ranked: ReadonlyArray<BrainSearchResult>,
  filters: ReadonlyMap<string, ReadonlyArray<string>>,
  vault: string,
  frontmatterCache: Map<string, FrontmatterMap>,
): ReadonlyArray<BrainSearchResult> {
  const reader = (path: string): Record<string, unknown> | null => {
    try {
      return readCachedFrontmatter(frontmatterCache, vault, path) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  return filterByProperties(ranked, filters, reader);
}

/**
 * Stamp inline trust metadata (Search & Recall Quality Suite) onto each
 * result: age from the document mtime, plus the superseded / conflict
 * flags from the typed relations the result already carries. Read-time
 * and never stored. One `statSync` per surfaced result (≤ limit); a path
 * that cannot be stat'd is left without trust rather than reporting a
 * bogus age.
 */
export function attachTrustMetadata(
  vault: string,
  results: ReadonlyArray<BrainSearchResult>,
): ReadonlyArray<BrainSearchResult> {
  const nowMs = Date.now();
  return results.map((r) => {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(join(vault, r.path)).mtimeMs;
    } catch {
      return r;
    }
    return Object.freeze({
      ...r,
      trust: deriveTrust({ mtimeMs, nowMs, ...(r.relations ? { relations: r.relations } : {}) }),
    });
  });
}

/** Namespace name kernel 1 uses when attributing the fade. */
export const SUPERSEDE_FADE_ADJUSTER_NAME = "supersede_fade";

/**
 * Relation-only supersede fade (t_c4a9cef8): the second consumer of
 * kernel 1. Fade any candidate whose surfaced typed relations mark it
 * superseded - reusing {@link hasSupersededRelation}, the exact source of
 * truth `attachTrustMetadata` / `deriveTrust` use for display - by the
 * named-constant {@link SUPERSEDE_FADE_MULTIPLIER}. The caller supplies a
 * documentId → relations lookup (the per-query typed-relations fetch in
 * search.ts) so the adjuster does no I/O of its own. A candidate with no
 * supersede relation is kept unchanged, so a pool with no such relation
 * ranks byte-identically. This is orthogonal to the superseded-non-tip
 * tombstone drop, which removes tombstoned rows before the fade runs.
 */
export function supersedeFadeAdjuster(
  relationsFor: (documentId: number) => ReadonlyArray<{ readonly relation: string }>,
): RankAdjuster {
  return {
    name: SUPERSEDE_FADE_ADJUSTER_NAME,
    adjust(result: BrainSearchResult): RankAdjustVerdict {
      if (!hasSupersededRelation(relationsFor(result.documentId))) return keepVerdict();
      return multiplyVerdict(SUPERSEDE_FADE_MULTIPLIER, "superseded");
    },
  };
}

/**
 * Graph-degree cardinality filter (t_9bee8f0b): drop rows whose
 * backlink/outlink counts do not satisfy every predicate. Degree data
 * comes from the memoized link-graph snapshot, so a repeat query against
 * an unchanged index does no graph rebuild. An empty predicate list is a
 * byte-identical pass-through (the caller gates on that, but this stays
 * safe if called directly).
 */
export function applyDegreeFilter(
  ranked: ReadonlyArray<BrainSearchResult>,
  predicates: ReadonlyArray<DegreePredicate>,
  store: Store,
): ReadonlyArray<BrainSearchResult> {
  if (predicates.length === 0) return ranked;
  const snapshot = getGraphSnapshot(store);
  return applyDegreeFilters(ranked, predicates, (path) => degreeForPath(snapshot, path));
}

export function applyVisibilityScope(
  ranked: ReadonlyArray<BrainSearchResult>,
  scope: ReadonlySet<string>,
  vault: string,
  frontmatterCache: Map<string, FrontmatterMap>,
): ReadonlyArray<BrainSearchResult> {
  const tagsFor = (path: string): string[] => {
    try {
      return pageVisibility(readCachedFrontmatter(frontmatterCache, vault, path));
    } catch {
      return [];
    }
  };
  return ranked.filter((r) => isVisible(tagsFor(r.path), scope));
}

export function applyAgentScope(
  ranked: ReadonlyArray<BrainSearchResult>,
  scope: string,
  vault: string,
  frontmatterCache: Map<string, FrontmatterMap>,
): ReadonlyArray<BrainSearchResult> {
  // Fail-closed sentinel: a page whose frontmatter cannot be parsed has
  // an unknowable owner, so under an active scope it is dropped rather
  // than leaked. This is stricter than visibility scoping's fail-open
  // default - deliberate, because agent-scope is an isolation boundary.
  const UNPARSEABLE = " unparseable-owner";
  const ownerFor = (path: string): string => {
    try {
      return pageOwner(readCachedFrontmatter(frontmatterCache, vault, path)) ?? "";
    } catch {
      return UNPARSEABLE;
    }
  };
  return ranked.filter((r) => {
    const owner = ownerFor(r.path);
    if (owner === UNPARSEABLE) return false; // fail closed
    return isOwnerVisible(owner === "" ? null : owner, scope);
  });
}
