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
  /** Stable id: the most-central member's basename. */
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
}

/**
 * Deterministic label propagation over the store's resolved link
 * graph. Read-only.
 */
export function detectCommunities(store: Store, opts: DetectCommunitiesOptions = {}): Community[] {
  const minSize = Math.max(2, opts.minSize ?? COMMUNITY_DEFAULT_MIN_SIZE);
  const maxIterations = Math.max(1, opts.maxIterations ?? COMMUNITY_MAX_ITERATIONS);

  const pathById = new Map<number, string>();
  for (const [path, summary] of store.listDocuments()) pathById.set(summary.id, path);

  // Undirected adjacency over resolved pairs, self-loops dropped.
  const adjacency = new Map<number, Set<number>>();
  for (const { source, target } of store.resolvedDocLinkPairs()) {
    if (source === target || !pathById.has(source) || !pathById.has(target)) continue;
    let a = adjacency.get(source);
    if (!a) adjacency.set(source, (a = new Set()));
    a.add(target);
    let b = adjacency.get(target);
    if (!b) adjacency.set(target, (b = new Set()));
    b.add(source);
  }

  // Synchronous sweeps in sorted-id order; lowest label wins ties.
  const nodes = [...adjacency.keys()].toSorted((a, b) => a - b);
  const labels = new Map<number, number>(nodes.map((n) => [n, n]));
  for (let iteration = 0; iteration < maxIterations; iteration++) {
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

  // Group, rank members, compute density.
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
        id: basename(members[0]!.path, ".md"),
        members: Object.freeze(members),
        size: ids.length,
        density: possible === 0 ? 0 : internalEdges / possible,
      }),
    );
  }

  return communities.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ── materialization ──────────────────────────────────────────────────────────

const GENERATED_KIND = "brain-cluster";

export interface MaterializeClusterNotesResult {
  readonly written: ReadonlyArray<string>;
  readonly removed: ReadonlyArray<string>;
}

function clustersDir(vault: string): string {
  return join(vault, "Brain", "clusters");
}

/**
 * Regenerate one derived note per community and remove generated
 * notes whose community vanished. Hand-written files (no
 * `kind: brain-cluster`) are never touched.
 */
export function materializeClusterNotes(
  vault: string,
  communities: ReadonlyArray<Community>,
  opts: { readonly store: Store; readonly now: Date },
): MaterializeClusterNotesResult {
  const dir = clustersDir(vault);
  mkdirSync(dir, { recursive: true });

  const written: string[] = [];
  const expected = new Set<string>();
  for (const community of communities) {
    const fileName = `cluster-${community.id}.md`;
    expected.add(fileName);
    const path = join(dir, fileName);
    atomicWriteFileSync(path, renderClusterNote(community, opts));
    written.push(`Brain/clusters/${fileName}`);
  }

  // Stale sweep: only generated notes are eligible for removal.
  const removed: string[] = [];
  for (const file of readdirSync(dir).toSorted()) {
    if (!file.endsWith(".md") || expected.has(file)) continue;
    const full = join(dir, file);
    const [meta] = parseFrontmatter(full);
    if (meta["kind"] !== GENERATED_KIND) continue;
    rmSync(full);
    removed.push(`Brain/clusters/${file}`);
  }

  return Object.freeze({ written: Object.freeze(written), removed: Object.freeze(removed) });
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
