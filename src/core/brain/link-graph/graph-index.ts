/**
 * Precomputed link-graph side-index (Unit 4 of the Vault Integrity &
 * Trust suite).
 *
 * The resolved undirected adjacency of the doc-level link graph is
 * rebuilt from scratch by every graph reader (community detection, graph
 * stats): an O(n) SQL query plus a full map build, repeated per call.
 * This module computes that structure once and memoizes it on the Store,
 * keyed on the store's monotonic `indexRevision()`. Repeat reads against
 * an unchanged index are O(1); the first read after a reindex rebuilds,
 * because the revision bump invalidates the cached snapshot.
 *
 * In-memory only - never persisted to SQLite. Read-only and
 * deterministic: identical index, identical snapshot. The cache is a
 * WeakMap keyed on the Store instance, so a closed/garbage-collected
 * store drops its snapshot with it.
 */

import type { Store } from "../../search/store.ts";

export interface GraphSnapshot {
  /** The index revision this snapshot was built against. */
  readonly revision: number;
  /** documentId -> vault-relative path, for every indexed document. */
  readonly pathById: ReadonlyMap<number, string>;
  /** vault-relative path -> documentId (inverse of {@link pathById}). */
  readonly idByPath: ReadonlyMap<string, number>;
  /**
   * Undirected adjacency over resolved doc-link pairs, self-loops
   * dropped. Only documents with at least one edge appear as keys.
   */
  readonly adjacency: ReadonlyMap<number, ReadonlySet<number>>;
  /** documentId -> neighbour count (degree). Mirrors {@link adjacency}. */
  readonly degree: ReadonlyMap<number, number>;
  /**
   * documentId -> out-link count: distinct resolved documents this note
   * links to (self-loops dropped). Only documents with at least one
   * out-link appear; absence means zero. Feeds the `outlinks` filter
   * predicate.
   */
  readonly outDegree: ReadonlyMap<number, number>;
  /**
   * documentId -> back-link count: distinct resolved documents that link
   * to this note (self-loops dropped). Only documents with at least one
   * back-link appear; absence means zero. Feeds the `backlinks` filter
   * predicate.
   */
  readonly inDegree: ReadonlyMap<number, number>;
  /** Linked node ids in ascending order (the deterministic sweep order). */
  readonly nodesSorted: ReadonlyArray<number>;
  /** Count of distinct undirected edges. */
  readonly edgeCount: number;
}

/** Per-Store memo: rebuilt only when the index revision moves. */
const SNAPSHOT_CACHE = new WeakMap<Store, GraphSnapshot>();

/**
 * Return the link-graph snapshot for `store`, building it once and
 * reusing it until the store's index revision changes.
 */
export function getGraphSnapshot(store: Store): GraphSnapshot {
  const cached = SNAPSHOT_CACHE.get(store);
  if (cached !== undefined && cached.revision === store.indexRevision()) {
    return cached;
  }
  const snapshot = buildGraphSnapshot(store);
  SNAPSHOT_CACHE.set(store, snapshot);
  return snapshot;
}

function buildGraphSnapshot(store: Store): GraphSnapshot {
  const revision = store.indexRevision();

  const pathById = new Map<number, string>();
  const idByPath = new Map<string, number>();
  for (const [path, summary] of store.listDocuments()) {
    pathById.set(summary.id, path);
    idByPath.set(path, summary.id);
  }

  const adjacency = new Map<number, Set<number>>();
  // Directed neighbour sets, kept distinct so a note that links to the
  // same target twice counts it once. Backlinks read `inNeighbours`,
  // out-links read `outNeighbours`.
  const outNeighbours = new Map<number, Set<number>>();
  const inNeighbours = new Map<number, Set<number>>();
  let edgeCount = 0;
  for (const { source, target } of store.resolvedDocLinkPairs()) {
    if (source === target || !pathById.has(source) || !pathById.has(target)) continue;
    const forward = adjacency.get(source) ?? adjacency.set(source, new Set()).get(source)!;
    if (!forward.has(target)) {
      forward.add(target);
      // Count each undirected edge once (only when first seen from this side).
      edgeCount += 1;
    }
    const back = adjacency.get(target) ?? adjacency.set(target, new Set()).get(target)!;
    back.add(source);
    (outNeighbours.get(source) ?? outNeighbours.set(source, new Set()).get(source)!).add(target);
    (inNeighbours.get(target) ?? inNeighbours.set(target, new Set()).get(target)!).add(source);
  }

  const degree = new Map<number, number>();
  for (const [node, neighbours] of adjacency) degree.set(node, neighbours.size);
  const outDegree = new Map<number, number>();
  for (const [node, neighbours] of outNeighbours) outDegree.set(node, neighbours.size);
  const inDegree = new Map<number, number>();
  for (const [node, neighbours] of inNeighbours) inDegree.set(node, neighbours.size);

  const nodesSorted = [...adjacency.keys()].toSorted((a, b) => a - b);

  return Object.freeze({
    revision,
    pathById,
    idByPath,
    adjacency,
    degree,
    outDegree,
    inDegree,
    nodesSorted,
    edgeCount,
  });
}

/** Directed degree of one note: distinct back-links and out-links. */
export interface NoteDegree {
  /** Distinct resolved documents that link TO this note. */
  readonly backlinks: number;
  /** Distinct resolved documents this note links to. */
  readonly outlinks: number;
}

/**
 * Look up a note's directed degree by vault-relative path. A path with no
 * resolved edges (or an unknown path) is an orphan: `{ backlinks: 0,
 * outlinks: 0 }`. Pure over the snapshot; no I/O.
 */
export function degreeForPath(snapshot: GraphSnapshot, path: string): NoteDegree {
  const id = snapshot.idByPath.get(path);
  if (id === undefined) return { backlinks: 0, outlinks: 0 };
  return {
    backlinks: snapshot.inDegree.get(id) ?? 0,
    outlinks: snapshot.outDegree.get(id) ?? 0,
  };
}

export interface GraphDegreeEntry {
  readonly path: string;
  readonly degree: number;
}

export interface GraphStats {
  /** Total indexed documents (including unlinked ones). */
  readonly documentCount: number;
  /** Documents with at least one resolved edge. */
  readonly nodeCount: number;
  /** Distinct undirected edges. */
  readonly edgeCount: number;
  /** Highest-degree nodes, degree desc then path asc. */
  readonly topByDegree: ReadonlyArray<GraphDegreeEntry>;
}

/**
 * O(1)-after-snapshot graph statistics: counts plus the highest-degree
 * nodes. Reads exclusively from {@link getGraphSnapshot}, so successive
 * calls against an unchanged index do no graph rebuild.
 */
export function graphStats(store: Store, opts: { top?: number } = {}): GraphStats {
  const snapshot = getGraphSnapshot(store);
  const top = Math.max(0, Math.floor(opts.top ?? 10));

  const ranked = snapshot.nodesSorted
    .map((id) => ({
      path: snapshot.pathById.get(id) ?? String(id),
      degree: snapshot.degree.get(id) ?? 0,
    }))
    .toSorted((a, b) => (a.degree !== b.degree ? b.degree - a.degree : a.path < b.path ? -1 : 1));

  return Object.freeze({
    documentCount: snapshot.pathById.size,
    nodeCount: snapshot.nodesSorted.length,
    edgeCount: snapshot.edgeCount,
    topByDegree: Object.freeze(ranked.slice(0, top)),
  });
}
