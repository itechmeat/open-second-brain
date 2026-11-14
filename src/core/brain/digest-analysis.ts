/**
 * The digest's ranking and connection analysis (task 3.19): the hot
 * section budget, the top-applied and top-referenced picks, the
 * connection-health computation and the empty-fold predicate, over the
 * preferences and backlinks the collection gathered. Split from
 * `digest.ts`.
 */

import { posix } from "node:path";
import { type ArtifactRefView } from "./artifact-ref-view.ts";
import { type BacklinkIndex } from "./backlinks.ts";
import { BRAIN_RETIRED_REL } from "./paths.ts";
import { normaliseWikilinkTarget } from "./wikilink.ts";
import { memoryFolderPages } from "./memory-pages.ts";
import { BRAIN_PREFERENCE_STATUS } from "./types.ts";
import type { BrainPreference } from "./types.ts";
import type {
  DigestData,
  DigestJsonConnectionHealth,
  DigestJsonTopApplied,
  DigestJsonTopReferenced,
} from "./digest-types.ts";

/**
 * How many entries to keep in each "hot" digest section. Small fixed
 * value — the digest is meant to be skimmable, not exhaustive.
 */
export const HOT_SECTION_LIMIT = 5;

export function pickTopApplied(
  preferences: ReadonlyArray<PreferenceWithPath>,
): ReadonlyArray<DigestJsonTopApplied> {
  const active = preferences.filter(
    ({ pref }) =>
      (pref.status === BRAIN_PREFERENCE_STATUS.confirmed ||
        pref.status === BRAIN_PREFERENCE_STATUS.quarantine) &&
      pref.applied_count > 0,
  );
  active.sort((a, b) => {
    const diff = b.pref.applied_count - a.pref.applied_count;
    if (diff !== 0) return diff;
    // Stable secondary key: id ascending. Without it the same input on
    // two filesystems (different readdir order) could swap ties.
    return a.pref.id.localeCompare(b.pref.id);
  });
  return active.slice(0, HOT_SECTION_LIMIT).map(({ pref }) => ({
    id: pref.id,
    topic: pref.topic,
    principle: pref.principle,
    scope: pref.scope ?? null,
    applied_count: pref.applied_count,
    violated_count: pref.violated_count,
    confidence: pref.confidence,
    status: pref.status,
  }));
}

/**
 * Inbound references to `target` whose source this reader may see. With
 * nothing filtered it is the index's own count.
 */
export function visibleBacklinkCount(
  index: BacklinkIndex,
  target: string,
  refs: ArtifactRefView,
): number {
  const sources = index.get(normaliseWikilinkTarget(target)) ?? [];
  return refs.filtersNothing
    ? sources.length
    : sources.filter((ref) => refs.visible(ref.source)).length;
}

export function pickTopReferenced(
  inbound: (id: string) => number,
  preferences: ReadonlyArray<PreferenceWithPath>,
): ReadonlyArray<DigestJsonTopReferenced> {
  const scored = preferences
    .map(({ pref }) => ({
      pref,
      count: inbound(pref.id),
    }))
    .filter((x) => x.count > 0);
  scored.sort((a, b) => {
    const diff = b.count - a.count;
    if (diff !== 0) return diff;
    return a.pref.id.localeCompare(b.pref.id);
  });
  return scored.slice(0, HOT_SECTION_LIMIT).map(({ pref, count }) => ({
    id: pref.id,
    topic: pref.topic,
    principle: pref.principle,
    scope: pref.scope ?? null,
    backlink_count: count,
  }));
}

/**
 * Compute vault-level connection-density health metrics from the
 * backlink index over all preferences and retired entries.
 */
export function computeConnectionHealth(
  vault: string,
  inbound: (id: string) => number,
  preferences: ReadonlyArray<PreferenceWithPath>,
  refs: ArtifactRefView,
): DigestJsonConnectionHealth {
  const allIds = preferences.map(({ pref }) => pref.id);
  // Also include retired entries.
  for (const entry of memoryFolderPages(vault, "retired", { regularFilesOnly: true })) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.name.startsWith("ret-")) continue;
    if (!refs.visible(posix.join(BRAIN_RETIRED_REL, entry.name))) continue;
    allIds.push(entry.name.replace(/\.md$/, ""));
  }

  const totalNodes = allIds.length;
  const counts = allIds.map(inbound);
  const linkedNodes = counts.filter((c) => c > 0).length;
  const orphanNodes = totalNodes - linkedNodes;

  let meanBacklinks = 0;
  let medianBacklinks = 0;
  if (totalNodes > 0) {
    const sum = counts.reduce((a, b) => a + b, 0);
    meanBacklinks = Math.round((sum / totalNodes) * 100) / 100;
    const sorted = [...counts].toSorted((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    medianBacklinks =
      sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
  }
  const linkDensity = totalNodes > 0 ? Math.round((linkedNodes / totalNodes) * 1000) / 1000 : 0;

  return Object.freeze({
    total_nodes: totalNodes,
    linked_nodes: linkedNodes,
    orphan_nodes: orphanNodes,
    mean_backlinks: meanBacklinks,
    median_backlinks: medianBacklinks,
    link_density: linkDensity,
  });
}

export function isEmpty(data: DigestData): boolean {
  return (
    data.new_unconfirmed.length === 0 &&
    data.confirmed.length === 0 &&
    data.retired.length === 0 &&
    data.confidence_shifts.length === 0 &&
    data.contradictions.length === 0 &&
    data.most_applied.entries.length === 0 &&
    data.agent_summary.length === 0
  );
}

// ----- Filesystem scan helpers ---------------------------------------------

export interface PreferenceWithPath {
  readonly pref: BrainPreference;
  readonly path: string;
}
