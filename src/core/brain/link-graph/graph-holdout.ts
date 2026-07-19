/**
 * Graph-efficacy holdout harness (G1, t_6832aac6).
 *
 * A graph-neighbor holdout is an (anchor, target) pair where the anchor is a
 * note assumed to be directly recalled and the target is a note reached by
 * following graph edges. The harness measures GRAPH LIFT (targets reachable
 * only through the graph, not as a direct neighbor of the anchor) separately
 * from DIRECT RECALL (targets that are already a direct neighbor), so the
 * value the graph edges add is visible on its own.
 *
 * Every target must resolve to durable memory (the note exists) and hydrate
 * into bounded evidence (a non-empty body, capped at a named constant). A
 * dangling edge - a target that resolves to nothing - fails the gate, because
 * a graph that points at absent memory cannot lift recall.
 *
 * Reads only link structure and note bodies; no natural-language word list.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ensureInsideVault } from "../../path-safety.ts";
import { EXCLUDED_DIRS, extractWikilinks, listVaultPages, parseFrontmatter } from "../../vault.ts";
import { canonicalCoOccurrenceKey } from "./co-occurrence.ts";

/** Upper bound on the evidence hydrated from a target note. */
export const HOLDOUT_EVIDENCE_MAX_CHARS = 2000;

/** One graph-neighbor holdout: an anchor and the target reached from it. */
export interface GraphHoldout {
  /** Vault-relative path of the directly-recalled anchor note. */
  readonly anchor: string;
  /** Vault-relative path of the graph-neighbor target under test. */
  readonly target: string;
}

export interface HoldoutResolution {
  readonly holdout: GraphHoldout;
  /** The target resolves to a durable-memory note. */
  readonly resolved: boolean;
  /** The target hydrates into non-empty bounded evidence. */
  readonly hydrated: boolean;
  /** Length of the hydrated evidence, capped at {@link HOLDOUT_EVIDENCE_MAX_CHARS}. */
  readonly evidenceChars: number;
  /** The edge points at absent memory (not resolved). */
  readonly dangling: boolean;
  /** The target is a direct (1-hop) neighbor of the anchor. */
  readonly directNeighbor: boolean;
  /** The target is reachable only through the graph (2-hop, not 1-hop). */
  readonly graphReachable: boolean;
}

export interface HoldoutGateResult {
  /** True only when no edge is dangling. */
  readonly passed: boolean;
  readonly total: number;
  readonly resolvedCount: number;
  readonly danglingCount: number;
  /** Holdouts whose target is a direct neighbor of the anchor. */
  readonly directRecall: number;
  /** Holdouts whose target is reachable only through the graph. */
  readonly graphLift: number;
  readonly resolutions: readonly HoldoutResolution[];
}

/** Canonical-key adjacency over the vault's resolved wikilink structure. */
function buildKeyAdjacency(vault: string): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  for (const page of listVaultPages(vault, { skipDirs: [...EXCLUDED_DIRS] })) {
    const sourceKey = canonicalCoOccurrenceKey(page.path);
    if (sourceKey === null) continue;
    let body = "";
    try {
      [, body] = parseFrontmatter(page.path);
    } catch {
      body = "";
    }
    const neighbours = adjacency.get(sourceKey) ?? new Set<string>();
    for (const raw of extractWikilinks(body)) {
      const targetKey = canonicalCoOccurrenceKey(raw);
      if (targetKey !== null && targetKey !== sourceKey) neighbours.add(targetKey);
    }
    adjacency.set(sourceKey, neighbours);
  }
  return adjacency;
}

/** Two-hop neighbour keys of `key`, excluding the key itself and its 1-hop set. */
function twoHopKeys(adjacency: ReadonlyMap<string, ReadonlySet<string>>, key: string): Set<string> {
  const direct = adjacency.get(key) ?? new Set<string>();
  const twoHop = new Set<string>();
  for (const mid of direct) {
    for (const far of adjacency.get(mid) ?? new Set<string>()) {
      if (far !== key && !direct.has(far)) twoHop.add(far);
    }
  }
  return twoHop;
}

/** Read a target note's body as bounded evidence. Empty when unresolved. */
function hydrateEvidence(vault: string, target: string): { resolved: boolean; text: string } {
  const abs = ensureInsideVault(join(vault, target), vault);
  if (!existsSync(abs)) return { resolved: false, text: "" };
  try {
    const [, body] = parseFrontmatter(abs);
    return { resolved: true, text: body.trim().slice(0, HOLDOUT_EVIDENCE_MAX_CHARS) };
  } catch {
    try {
      const raw = readFileSync(abs, "utf8");
      return { resolved: true, text: raw.trim().slice(0, HOLDOUT_EVIDENCE_MAX_CHARS) };
    } catch {
      return { resolved: false, text: "" };
    }
  }
}

/**
 * Evaluate graph-neighbor holdouts, reporting graph lift separately from
 * direct recall and failing the gate on any dangling edge.
 */
export function evaluateGraphHoldouts(
  vault: string,
  holdouts: readonly GraphHoldout[],
): HoldoutGateResult {
  const adjacency = buildKeyAdjacency(vault);
  const resolutions: HoldoutResolution[] = [];
  let resolvedCount = 0;
  let danglingCount = 0;
  let directRecall = 0;
  let graphLift = 0;

  for (const holdout of holdouts) {
    const anchorKey = canonicalCoOccurrenceKey(holdout.anchor);
    const targetKey = canonicalCoOccurrenceKey(holdout.target);
    const direct =
      anchorKey !== null ? (adjacency.get(anchorKey) ?? new Set<string>()) : new Set<string>();
    const twoHop = anchorKey !== null ? twoHopKeys(adjacency, anchorKey) : new Set<string>();

    const directNeighbor = targetKey !== null && direct.has(targetKey);
    const graphReachable = targetKey !== null && !directNeighbor && twoHop.has(targetKey);

    const evidence = hydrateEvidence(vault, holdout.target);
    const resolved = evidence.resolved;
    const hydrated = resolved && evidence.text.length > 0;
    const dangling = !resolved;

    if (resolved) resolvedCount += 1;
    if (dangling) danglingCount += 1;
    if (directNeighbor) directRecall += 1;
    if (graphReachable) graphLift += 1;

    resolutions.push({
      holdout,
      resolved,
      hydrated,
      evidenceChars: evidence.text.length,
      dangling,
      directNeighbor,
      graphReachable,
    });
  }

  return {
    passed: danglingCount === 0,
    total: holdouts.length,
    resolvedCount,
    danglingCount,
    directRecall,
    graphLift,
    resolutions: Object.freeze(resolutions),
  };
}
