/**
 * Graph-wide community detection with materialized cluster notes
 * (link-recall-intelligence, t_4ba927ec).
 *
 * `buildConceptCluster` assembles depth-1 backlinks for ONE named
 * target; nothing discovered structure across the whole graph. This
 * pass runs deterministic synchronous label propagation over the
 * resolved doc-level link graph (undirected): labels start as sorted
 * document ids, every sweep assigns each node the most frequent label
 * among its neighbours (lowest label breaks ties), and a fixed
 * iteration cap guarantees termination on oscillating topologies
 * (bipartite stars flip forever under synchronous updates). No
 * Louvain dependency, no randomness - identical input, identical
 * communities.
 *
 * Communities of size >= minSize materialize one derived note each
 * under `Brain/clusters/`. Cluster notes are projections, not prose:
 * members ranked by internal degree, shared entities from the index,
 * link density - synthesis stays with the calling agent (the
 * deep-synthesis rule). Notes are regenerated every run; a note whose
 * community vanished is removed, but ONLY when it carries the
 * generated marker - hand-written files in the directory are never
 * touched.
 */

import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

import type { Store } from "../../search/store.ts";
import { getGraphSnapshot } from "./graph-index.ts";
import { atomicWriteFileSync } from "../../fs-atomic.ts";
import { isoSecond } from "../time.ts";
import { formatFrontmatter, parseFrontmatter } from "../../vault.ts";

export const COMMUNITY_DEFAULT_MIN_SIZE = 4;
export const COMMUNITY_MAX_ITERATIONS = 20;
/** Shared entities listed per cluster note. */
const CLUSTER_TOP_ENTITIES = 5;

export interface CommunityMember {
  readonly path: string;
  /** Edges to other members of the same community. */
  readonly internalDegree: number;
}

export interface Community {
  /**
   * Stable id: the most-central member's vault-relative path with
   * `/` flattened to `-` (basename alone collides when two folders
   * hold same-named hub notes, and colliding ids would overwrite
   * each other's cluster files).
   */
  readonly id: string;
  /** Members ranked by internal degree desc, path asc. */
  readonly members: ReadonlyArray<CommunityMember>;
  readonly size: number;
  /** internal edges / possible edges, [0, 1]. */
  readonly density: number;
}

export interface DetectCommunitiesOptions {
  readonly minSize?: number;
  readonly maxIterations?: number;
  /**
   * Cooperative deadline (t_06784b8d): checkpointed at entry and once
   * per propagation sweep.
   */
  readonly safeguard?: import("../safeguard.ts").Safeguard;
}

/**
 * Deterministic label propagation over the store's resolved link
 * graph. Read-only.
 */
export function detectCommunities(store: Store, opts: DetectCommunitiesOptions = {}): Community[] {
  const minSize = Math.max(2, opts.minSize ?? COMMUNITY_DEFAULT_MIN_SIZE);
  const maxIterations = Math.max(1, opts.maxIterations ?? COMMUNITY_MAX_ITERATIONS);
  opts.safeguard?.checkpoint();

  // Resolved undirected adjacency + pathById come from the memoized
  // graph snapshot (Unit 4): identical structure to the previous
  // per-call rebuild, but O(1) on repeat reads against an unchanged
  // index. Label propagation below is unchanged - the options vary per
  // call, so only the option-independent graph is shared.
  const snapshot = getGraphSnapshot(store);
  const pathById = snapshot.pathById;
  const adjacency = snapshot.adjacency;

  // Synchronous sweeps in sorted-id order; lowest label wins ties.
  const nodes = snapshot.nodesSorted;
  const labels = new Map<number, number>(nodes.map((n) => [n, n]));
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    // Cooperative deadline: abort between sweeps (read-only pass).
    opts.safeguard?.checkpoint();
    let changed = false;
    const next = new Map<number, number>();
    for (const node of nodes) {
      const counts = new Map<number, number>();
      for (const neighbour of adjacency.get(node)!) {
        const label = labels.get(neighbour)!;
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
      let bestLabel = labels.get(node)!;
      let bestCount = 0;
      for (const [label, count] of counts) {
        if (count > bestCount || (count === bestCount && label < bestLabel)) {
          bestLabel = label;
          bestCount = count;
        }
      }
      next.set(node, bestLabel);
      if (bestLabel !== labels.get(node)) changed = true;
    }
    for (const [node, label] of next) labels.set(node, label);
    if (!changed) break;
  }

  // Group, rank members, compute density. Groups are final-label
  // equivalence classes: when the iteration cap interrupts an
  // oscillating topology, a group is not guaranteed to be a connected
  // component - acceptable for a digest surface, never for routing.
  const groups = new Map<number, number[]>();
  for (const node of nodes) {
    const label = labels.get(node)!;
    const group = groups.get(label);
    if (group) group.push(node);
    else groups.set(label, [node]);
  }

  const communities: Community[] = [];
  for (const ids of groups.values()) {
    if (ids.length < minSize) continue;
    const memberSet = new Set(ids);
    let internalEdges = 0;
    const members = ids
      .map((id) => {
        let degree = 0;
        for (const neighbour of adjacency.get(id)!) {
          if (memberSet.has(neighbour)) degree++;
        }
        internalEdges += degree;
        return { path: pathById.get(id)!, internalDegree: degree };
      })
      .toSorted((a, b) =>
        a.internalDegree !== b.internalDegree
          ? b.internalDegree - a.internalDegree
          : a.path < b.path
            ? -1
            : 1,
      );
    internalEdges /= 2; // each undirected edge counted from both ends
    const possible = (ids.length * (ids.length - 1)) / 2;
    communities.push(
      Object.freeze({
        id: communityId(members[0]!.path),
        members: Object.freeze(members),
        size: ids.length,
        density: possible === 0 ? 0 : internalEdges / possible,
      }),
    );
  }

  return communities.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Collision-free id: vault-relative path, `/` -> `-`, no `.md`. */
function communityId(relPath: string): string {
  return relPath.replace(/\.md$/u, "").split("/").join("-");
}

// ── materialization ──────────────────────────────────────────────────────────

const GENERATED_KIND = "brain-cluster";

/**
 * Per-batch outcome from a batched materialization run (t_a286135c,
 * Graphify-inspired). Present only when `batchSize` is supplied; the
 * unbatched path stays byte-identical and omits it.
 */
export interface ClusterBatch {
  /** 0-based batch position. */
  readonly index: number;
  /** Inclusive community offset this batch starts at. */
  readonly start: number;
  /** Exclusive community offset this batch ends at. */
  readonly end: number;
  /** Relative paths written by this batch (partial if it failed midway). */
  readonly written: ReadonlyArray<string>;
  /**
   * Stale notes removed. Removal is a single global reconciliation run
   * after all writes, attributed to the final batch.
   */
  readonly removed: ReadonlyArray<string>;
  /** Failure detail; present only when the batch threw. */
  readonly error?: string;
}

export interface MaterializeClusterNotesResult {
  readonly written: ReadonlyArray<string>;
  readonly removed: ReadonlyArray<string>;
  /** Per-batch results; present only when `batchSize` was supplied. */
  readonly batches?: ReadonlyArray<ClusterBatch>;
}

export interface MaterializeClusterNotesOptions {
  readonly store: Store;
  readonly now: Date;
  /**
   * Opt-in batching for large graphs (t_a286135c): materialize
   * communities in fixed-size, order-preserving chunks so one failed
   * batch is isolated and reported instead of dropping the whole pass.
   * Unset => single pass, errors propagate, byte-identical to before.
   */
  readonly batchSize?: number;
  /**
   * Injection seam for the per-note writer (defaults to the atomic
   * write); lets callers and tests force a deterministic batch fault.
   */
  readonly writeNote?: (path: string, content: string) => void;
}

function clustersDir(vault: string): string {
  return join(vault, "Brain", "clusters");
}

/**
 * Regenerate one derived note per community and remove generated
 * notes whose community vanished. Hand-written files (no
 * `kind: brain-cluster`) are never touched.
 *
 * With `batchSize` set, communities are written in fixed-size chunks
 * and each batch is isolated: a batch that throws is recorded with an
 * `error` and the remaining batches continue. The stale sweep keys off
 * the full detected set, so a failed batch leaves its prior note in
 * place rather than deleting it.
 */
export function materializeClusterNotes(
  vault: string,
  communities: ReadonlyArray<Community>,
  opts: MaterializeClusterNotesOptions,
): MaterializeClusterNotesResult {
  const dir = clustersDir(vault);
  mkdirSync(dir, { recursive: true });
  const writeNote = opts.writeNote ?? atomicWriteFileSync;

  // The full detected set protects every community note from the stale
  // sweep regardless of batch success: a failed batch keeps its prior
  // note instead of having it deleted.
  const expected = new Set<string>(communities.map((c) => `cluster-${c.id}.md`));

  const writeOne = (community: Community): string => {
    const fileName = `cluster-${community.id}.md`;
    writeNote(join(dir, fileName), renderClusterNote(community, opts));
    return `Brain/clusters/${fileName}`;
  };

  const written: string[] = [];
  let batches: ClusterBatch[] | undefined;
  if (opts.batchSize === undefined) {
    for (const community of communities) written.push(writeOne(community));
  } else {
    if (!Number.isInteger(opts.batchSize) || opts.batchSize < 1) {
      throw new Error("materializeClusterNotes: batchSize must be a positive integer");
    }
    const size = opts.batchSize;
    batches = [];
    for (let start = 0, index = 0; start < communities.length; start += size, index++) {
      const end = Math.min(start + size, communities.length);
      const batchWritten: string[] = [];
      let error: string | undefined;
      try {
        for (let i = start; i < end; i++) batchWritten.push(writeOne(communities[i]!));
      } catch (exc) {
        // Independent batches keep going; record stable bounds + detail.
        error = (exc as Error).message ?? String(exc);
      }
      written.push(...batchWritten);
      batches.push(
        Object.freeze({
          index,
          start,
          end,
          written: Object.freeze([...batchWritten]),
          removed: Object.freeze([] as string[]),
          ...(error !== undefined ? { error } : {}),
        }),
      );
    }
  }

  // Single global stale sweep: only generated notes are eligible.
  const removed: string[] = [];
  for (const file of readdirSync(dir).toSorted()) {
    if (!file.endsWith(".md") || expected.has(file)) continue;
    const full = join(dir, file);
    const [meta] = parseFrontmatter(full);
    if (meta["kind"] !== GENERATED_KIND) continue;
    rmSync(full);
    removed.push(`Brain/clusters/${file}`);
  }

  // Attribute the single global sweep to the final batch so the
  // per-batch `removed` contract carries a real value.
  if (batches && batches.length > 0) {
    const last = batches[batches.length - 1]!;
    batches[batches.length - 1] = Object.freeze({ ...last, removed: Object.freeze([...removed]) });
  }

  return Object.freeze({
    written: Object.freeze(written),
    removed: Object.freeze(removed),
    ...(batches ? { batches: Object.freeze(batches) } : {}),
  });
}

function renderClusterNote(
  community: Community,
  opts: { readonly store: Store; readonly now: Date },
): string {
  const entities = sharedEntities(opts.store, community);
  const lines: string[] = [
    `# Cluster: ${community.id}`,
    "",
    "Auto-generated by `o2b brain clusters run`. Do not edit - regenerated on",
    "every run; synthesis belongs to the reading agent, not this file.",
    "",
    `${community.size} notes, link density ${community.density.toFixed(2)}.`,
    "",
    "## Members (by internal degree)",
    "",
  ];
  for (const member of community.members) {
    lines.push(
      `- [[${basename(member.path, ".md")}]] (${member.path}) - ${member.internalDegree} internal link(s)`,
    );
  }
  if (entities.length > 0) {
    lines.push("", "## Shared entities", "");
    for (const [entity, count] of entities) {
      lines.push(`- ${entity} (${count} member note(s))`);
    }
  }
  return formatFrontmatter(
    {
      kind: GENERATED_KIND,
      cluster: community.id,
      generated_at: isoSecond(opts.now),
      size: community.size,
      density: community.density.toFixed(2),
      members: community.members.map((m) => m.path),
    },
    lines.join("\n"),
  );
}

/** Entities appearing in >= 2 member notes, by member count desc. */
function sharedEntities(store: Store, community: Community): Array<[string, number]> {
  const counts = new Map<string, number>();
  const summaries = store.listDocuments();
  for (const member of community.members) {
    const summary = summaries.get(member.path);
    if (!summary) continue;
    for (const entity of store.entitiesForDocument(summary.id)) {
      counts.set(entity, (counts.get(entity) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .toSorted((a, b) => (a[1] !== b[1] ? b[1] - a[1] : a[0] < b[0] ? -1 : 1))
    .slice(0, CLUSTER_TOP_ENTITIES);
}
