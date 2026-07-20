/**
 * Structural vault navmap (retrieval-quality-and-context-delivery, D1).
 *
 * The additive nav tier injects a navigation/map layer built ENTIRELY from
 * deterministic structural surfaces - never LLM-authored text. The map is the
 * vault's link-graph shape: its size (documents / edges) plus the highest-degree
 * notes, which are the de-facto hubs and Maps of Content an agent should orient
 * around before re-reading raw notes.
 *
 * This module reuses the existing {@link graphStats} surface (O(1) over the
 * cached graph snapshot) rather than re-deriving any graph analysis, and keeps
 * the pure rendering ({@link renderNavmap}) separate from the store access
 * ({@link buildNavmap}) so the render is unit-testable without an index.
 */

import { fenceUntrustedContent, neutralizeUntrustedText } from "./untrusted-source.ts";
import { graphStats, type GraphStats } from "./link-graph/graph-index.ts";
import { resolveSearchConfig } from "../search/index.ts";
import { Store } from "../search/store.ts";
import { SearchError } from "../search/types.ts";

/** Default number of hubs surfaced in the navmap. */
export const NAVMAP_DEFAULT_TOP_HUBS = 8;

/** `origin` label stamped on the navmap's untrusted-content fence. */
const NAVMAP_FENCE_ORIGIN = "nav-tier";

/** One hub note: a vault-relative path and its undirected link degree. */
export interface NavmapEntry {
  readonly path: string;
  readonly degree: number;
}

/** The structural navmap: vault-graph size plus the top hubs by degree. */
export interface Navmap {
  readonly documentCount: number;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly hubs: ReadonlyArray<NavmapEntry>;
}

export interface BuildNavmapOptions {
  readonly topHubs?: number;
}

/**
 * Project the graph-stats surface onto the narrow navmap shape. Pure and
 * I/O-free so it is trivially testable and deterministic.
 */
export function deriveNavmap(stats: GraphStats): Navmap {
  return Object.freeze({
    documentCount: stats.documentCount,
    nodeCount: stats.nodeCount,
    edgeCount: stats.edgeCount,
    hubs: Object.freeze(
      stats.topByDegree.map((e) => Object.freeze({ path: e.path, degree: e.degree })),
    ),
  });
}

/**
 * Collapse any control/newline/tab run in an untrusted vault path to a single
 * space so a smuggled newline can never break the one-hub-per-line structure or
 * forge a fake block. Mirrors the recall-inject neutralizer precedent.
 */
function neutralizeSingleLine(text: string): string {
  return neutralizeUntrustedText(text).replace(/[\n\t]+/g, " ");
}

/**
 * Render the navmap as a deterministic, fenced structural block. Returns an
 * empty string when there are no hubs (an all-orphan or empty graph has no map
 * worth injecting), so the caller can treat "empty" as "nothing to inject".
 */
export function renderNavmap(navmap: Navmap): string {
  if (navmap.hubs.length === 0) return "";
  const header = `Vault navmap (structural: ${navmap.documentCount} notes, ${navmap.edgeCount} links):`;
  const hubHeader = "Top hubs by connectivity (query these before re-reading raw notes):";
  const hubLines = navmap.hubs.map(
    (hub) => `- ${neutralizeSingleLine(hub.path)} (deg ${hub.degree})`,
  );
  const body = [header, hubHeader, ...hubLines].join("\n");
  return fenceUntrustedContent(body, NAVMAP_FENCE_ORIGIN);
}

/**
 * Build the navmap for a vault by reading the existing search index's link
 * graph. Returns `null` (fail-open) when there is no index yet or the graph has
 * no hubs to map - the nav tier then injects nothing, exactly as when the tier
 * is off. A genuinely unexpected store error is NOT swallowed here; the caller
 * (a fail-soft hook) is the single place that decides how to degrade.
 */
export async function buildNavmap(
  vault: string,
  configPath: string,
  opts: BuildNavmapOptions = {},
): Promise<Navmap | null> {
  const searchConfig = resolveSearchConfig({ vault, configPath });
  let store: Store;
  try {
    store = await Store.open(searchConfig, { mode: "read" });
  } catch (exc) {
    if (
      exc instanceof SearchError &&
      (exc.code === "INDEX_MISSING" || exc.code === "SCHEMA_MISMATCH")
    ) {
      return null;
    }
    throw exc;
  }
  try {
    const stats = graphStats(store, { top: opts.topHubs ?? NAVMAP_DEFAULT_TOP_HUBS });
    const navmap = deriveNavmap(stats);
    return navmap.hubs.length > 0 ? navmap : null;
  } finally {
    await store.close();
  }
}
