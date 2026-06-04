/**
 * Temporal-bridge traversal (Time-Aware Recall & Activation Suite,
 * t_c3871f0c).
 *
 * Link-graph traversal and time-range filtering used to be separate
 * concerns: candidates were filtered to the window BEFORE ranking, but
 * traversal expansions were fetched fresh and never time-checked, so a
 * time-scoped query could leak arbitrarily old linked documents. This
 * module makes the composition intentional: an expansion document is
 * kept only when its EVENT time (validity start, else mtime) falls
 * within a padded neighbourhood of the query window, and its score
 * decays linearly with the distance - "what happened around X" pulls
 * in causes and consequences, not the whole link neighbourhood.
 *
 * Pure function: `search.ts` supplies the resolved range and an
 * event-time resolver; relevance hits (non-`link` results) are never
 * touched.
 */

import type { ResolvedTimeRange } from "./time-range.ts";
import type { BrainSearchResult } from "./types.ts";

/** Default event-time pad around the query window, in days. */
export const DEFAULT_WINDOW_PAD_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Temporal proximity of an event time to a window, in [0, 1]. Inside
 * the window (or past an open edge) is 1; outside, the proximity falls
 * linearly to `1 / (pad + 1)` at exactly `pad` days out and 0 beyond.
 */
export function temporalProximity(
  eventMs: number,
  range: ResolvedTimeRange,
  windowPadDays: number,
): number {
  let distanceMs = 0;
  if (range.sinceMs !== null && eventMs < range.sinceMs) {
    distanceMs = range.sinceMs - eventMs;
  } else if (range.untilMs !== null && eventMs > range.untilMs) {
    distanceMs = eventMs - range.untilMs;
  }
  if (distanceMs === 0) return 1;
  const deltaDays = distanceMs / DAY_MS;
  if (deltaDays > windowPadDays) return 0;
  return (windowPadDays + 1 - deltaDays) / (windowPadDays + 1);
}

export interface TemporalBridgeOptions {
  readonly range: ResolvedTimeRange;
  /** Pad in days; defaults to {@link DEFAULT_WINDOW_PAD_DAYS}. */
  readonly windowPadDays?: number;
  /** Event time (unix ms) for a path: validity start, else mtime. */
  readonly eventTimeMs: (path: string) => number;
}

/**
 * Apply the bridge to a traversal-expanded result list: drop link
 * expansions beyond the pad, decay the rest by temporal proximity with
 * an explainable `temporal_bridge` reason, and re-sort by score.
 */
export function applyTemporalBridge(
  results: ReadonlyArray<BrainSearchResult>,
  opts: TemporalBridgeOptions,
): BrainSearchResult[] {
  const pad = opts.windowPadDays ?? DEFAULT_WINDOW_PAD_DAYS;
  const out: BrainSearchResult[] = [];
  for (const r of results) {
    if (r.searchType !== "link") {
      out.push(r);
      continue;
    }
    const eventMs = opts.eventTimeMs(r.path);
    const proximity = temporalProximity(eventMs, opts.range, pad);
    if (proximity === 0) continue;
    if (proximity === 1) {
      out.push(r);
      continue;
    }
    let distanceMs = 0;
    if (opts.range.sinceMs !== null && eventMs < opts.range.sinceMs) {
      distanceMs = opts.range.sinceMs - eventMs;
    } else if (opts.range.untilMs !== null && eventMs > opts.range.untilMs) {
      distanceMs = eventMs - opts.range.untilMs;
    }
    const deltaDays = distanceMs / DAY_MS;
    out.push(
      Object.freeze({
        ...r,
        score: r.score * proximity,
        reasons: Object.freeze([
          ...r.reasons,
          `temporal_bridge: ${deltaDays.toFixed(1)}d x${proximity.toFixed(3)}`,
        ]),
      }),
    );
  }
  out.sort((a, b) => b.score - a.score || a.chunkId - b.chunkId);
  return out;
}
