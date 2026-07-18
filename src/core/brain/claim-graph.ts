/**
 * Persisted claim-graph projection (Belief lifecycle suite, A3,
 * t_6916369f).
 *
 * A bounded, deterministically-rebuildable JSON projection over the
 * relations already present in Brain memory frontmatter - `superseded_by`
 * (supersession chains), `contradicts` (contested claims), the
 * bi-temporal `valid_from` / `valid_until` fields, and `provenance`. It
 * is a VIEW, not a store of record: nothing here writes memory files or
 * touches any extractor. Rebuild reads the current vault and overwrites
 * the artifact.
 *
 * One query surface answers four questions:
 *   - "current truth"        -> {@link currentTruth}
 *   - "true at instant T"    -> {@link truthAt}
 *   - "what replaced X"      -> {@link whatReplaced}
 *   - "what contests X"      -> {@link whatContests}
 * Current-truth is the default; history / retracted content is opt-in via
 * {@link allClaims}.
 *
 * Import direction (design invariant): imports from `types.ts`, the
 * shared vault/path helpers, and the sibling lifecycle modules
 * (`tombstone.ts` chain conventions, `temporal-replace.ts` validity
 * evaluation), never the reverse.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import type { FrontmatterMap } from "../types.ts";
import { atomicWriteFileSync } from "../fs-atomic.ts";
import { parseFrontmatter } from "../vault.ts";
import { brainDirs, claimGraphPath } from "./paths.ts";
import { isTombstoned, normalizeChainLink, resolveChainTip } from "./lifecycle/tombstone.ts";
import { isValidAt } from "./lifecycle/temporal-replace.ts";

// ----- Constants ------------------------------------------------------------

/**
 * Hard cap on projected nodes. The projection is a bounded artifact by
 * design: a runaway vault cannot produce an unbounded JSON file. Nodes
 * are sorted by path before truncation so the retained set is
 * deterministic.
 */
export const CLAIM_GRAPH_MAX_NODES = 5000;

/** Current on-disk schema version of the projection artifact. */
export const CLAIM_GRAPH_VERSION = 1;

/** Brain memory subdirectories the projection scans (relative to `Brain/`). */
const SCANNED_SUBDIRS = ["preferences", "retired", "inbox", "inbox/processed", "theses"] as const;

// ----- Errors ---------------------------------------------------------------

export class ClaimGraphError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ClaimGraphError";
  }
}

// ----- Types ----------------------------------------------------------------

export interface ClaimNode {
  /** Bare basename id (e.g. `pref-foo`). */
  readonly id: string;
  /** Vault-relative POSIX path. */
  readonly path: string;
  readonly topic: string;
  readonly principle: string;
  readonly valid_from: string | null;
  readonly valid_until: string | null;
  /** Normalized successor id, or `null` when this node is a chain tip. */
  readonly superseded_by: string | null;
  /** Normalized ids this node declares it contradicts. */
  readonly contradicts: ReadonlyArray<string>;
  readonly provenance: string | null;
  readonly tombstoned: boolean;
}

export interface ClaimGraph {
  readonly version: number;
  readonly generated_at: string;
  readonly node_count: number;
  /** True when the node cap dropped claims from the projection. */
  readonly truncated: boolean;
  readonly nodes: ReadonlyArray<ClaimNode>;
}

export interface BuildClaimGraphOptions {
  /** Override the node cap (defaults to {@link CLAIM_GRAPH_MAX_NODES}). */
  readonly maxNodes?: number;
  /** Wall clock for `generated_at`. Defaults to `new Date()`. */
  readonly now?: Date;
}

// ----- Field extraction -----------------------------------------------------

function scalar(meta: FrontmatterMap, key: string): string | null {
  const value = meta[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function normalizedList(meta: FrontmatterMap, key: string): string[] {
  const value = meta[key];
  const raw =
    typeof value === "string" && value !== ""
      ? [value]
      : Array.isArray(value)
        ? (value as ReadonlyArray<string>)
        : [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || item.trim() === "") continue;
    out.push(normalizeChainLink(item));
  }
  return out.toSorted();
}

function toNode(vault: string, absPath: string): ClaimNode | null {
  let meta: FrontmatterMap;
  try {
    [meta] = parseFrontmatter(absPath);
  } catch {
    return null;
  }
  if (Object.keys(meta).length === 0) return null;
  const rel = relative(vault, absPath).split("\\").join("/");
  const id = normalizeChainLink(absPath);
  const superseded = scalar(meta, "superseded_by");
  return {
    id,
    path: rel,
    topic: scalar(meta, "topic") ?? "",
    principle: scalar(meta, "principle") ?? "",
    valid_from: scalar(meta, "valid_from"),
    valid_until: scalar(meta, "valid_until"),
    superseded_by: superseded === null ? null : normalizeChainLink(superseded),
    contradicts: normalizedList(meta, "contradicts"),
    provenance: scalar(meta, "provenance"),
    tombstoned: isTombstoned(meta),
  };
}

function collectMarkdown(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
    out.push(join(dir, entry.name));
  }
}

// ----- Build / persist ------------------------------------------------------

/**
 * Build the claim-graph projection from the current vault. Deterministic:
 * nodes are sorted by vault-relative path, and truncation (when the node
 * cap is exceeded) keeps the lexicographically-first `maxNodes`.
 */
export function buildClaimGraph(vault: string, opts: BuildClaimGraphOptions = {}): ClaimGraph {
  const maxNodes = opts.maxNodes ?? CLAIM_GRAPH_MAX_NODES;
  if (!Number.isInteger(maxNodes) || maxNodes <= 0) {
    throw new ClaimGraphError(
      `buildClaimGraph: maxNodes must be a positive integer; got ${maxNodes}`,
    );
  }
  const brain = brainDirs(vault).brain;
  const files: string[] = [];
  for (const sub of SCANNED_SUBDIRS) collectMarkdown(join(brain, sub), files);

  const nodes: ClaimNode[] = [];
  for (const file of files) {
    const node = toNode(vault, file);
    if (node !== null) nodes.push(node);
  }
  nodes.sort((a, b) => a.path.localeCompare(b.path));

  const truncated = nodes.length > maxNodes;
  const kept = truncated ? nodes.slice(0, maxNodes) : nodes;
  return {
    version: CLAIM_GRAPH_VERSION,
    generated_at: (opts.now ?? new Date()).toISOString(),
    node_count: kept.length,
    truncated,
    nodes: kept,
  };
}

/** Persist a projection to `Brain/claim-graph.json`. */
export function writeClaimGraph(vault: string, graph: ClaimGraph): void {
  atomicWriteFileSync(claimGraphPath(vault), `${JSON.stringify(graph, null, 2)}\n`);
}

/** Build the projection and persist it in one step. */
export function rebuildClaimGraph(vault: string, opts: BuildClaimGraphOptions = {}): ClaimGraph {
  const graph = buildClaimGraph(vault, opts);
  writeClaimGraph(vault, graph);
  return graph;
}

/** Load the persisted projection, or `null` when none has been built. */
export function loadClaimGraph(vault: string): ClaimGraph | null {
  const path = claimGraphPath(vault);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ClaimGraphError(
      `loadClaimGraph: corrupt projection at ${path}: ${(err as Error).message}`,
      {
        cause: err,
      },
    );
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as ClaimGraph).nodes)
  ) {
    throw new ClaimGraphError(`loadClaimGraph: projection at ${path} is not a claim graph`);
  }
  return parsed as ClaimGraph;
}

// ----- Queries --------------------------------------------------------------

/**
 * Claims true at `probeMs` under half-open validity. Tombstoned claims
 * (wrong beliefs) never count as truth; a temporally-superseded
 * predecessor is not tombstoned and remains the truth for its own valid
 * window, so a past probe returns it and a present probe returns the
 * successor. Sorted by path.
 */
export function truthAt(graph: ClaimGraph, probeMs: number): ClaimNode[] {
  return graph.nodes.filter((n) => !n.tombstoned && isValidAt(n, probeMs));
}

/** Claims true right now (the default view). */
export function currentTruth(graph: ClaimGraph, now: Date = new Date()): ClaimNode[] {
  return truthAt(graph, now.getTime());
}

/** Every claim in the projection, including tombstoned ones (history / audit). */
export function allClaims(graph: ClaimGraph): ClaimNode[] {
  return [...graph.nodes];
}

/**
 * Resolve the claim that ultimately replaced `id` by walking the
 * `superseded_by` chain to its live tip. Returns the tip node, or `null`
 * when `id` is unknown or the chain tip is not in the projection.
 */
export function whatReplaced(graph: ClaimGraph, id: string): ClaimNode | null {
  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const start = normalizeChainLink(id);
  if (!byId.has(start)) return null;
  const res = resolveChainTip(start, (link) => {
    const node = byId.get(link);
    return node ? { supersededBy: node.superseded_by } : null;
  });
  return byId.get(res.tip) ?? null;
}

/**
 * Claims that contest `id`: either those the target declares it
 * contradicts, or those that declare they contradict the target
 * (contradiction is treated as a symmetric contest). Sorted by path.
 */
export function whatContests(graph: ClaimGraph, id: string): ClaimNode[] {
  const target = normalizeChainLink(id);
  const out: ClaimNode[] = [];
  const seen = new Set<string>();
  const targetNode = graph.nodes.find((n) => n.id === target) ?? null;
  const declaredByTarget = new Set(targetNode?.contradicts ?? []);
  for (const node of graph.nodes) {
    if (node.id === target) continue;
    const contestsTarget = node.contradicts.includes(target) || declaredByTarget.has(node.id);
    if (contestsTarget && !seen.has(node.id)) {
      seen.add(node.id);
      out.push(node);
    }
  }
  return out;
}
