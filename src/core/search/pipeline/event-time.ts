/**
 * Event-time discipline for one query (t_b7191486): the single definition
 * of "event time, storage time only as fallback" shared by the hard time
 * filter, the targeted-retry coverage gate, the temporal bridge and the
 * query-side temporal layer - plus the hard filter itself.
 *
 * A document declaring `valid_from` / `valid_until` is judged by
 * validity-window OVERLAP; storage mtime is the fallback, never the
 * authority, when explicit event time exists.
 */

import { readCachedFrontmatter, type FrontmatterCache } from "../result-filters.ts";
import { eventTimeInRange, parseValidityWindow, type ValidityWindow } from "../validity.ts";
import type { HydratedChunk, KeywordHit, SemanticHit } from "../store.ts";
import type { ResolvedTimeRange } from "../time-range.ts";

export interface EventTimeResolver {
  /** The declared validity window of a path, cached per path. */
  readonly validityWindowFor: (path: string) => ValidityWindow | null;
  /**
   * Declared EVENT time for a path (unix ms), or null when the page
   * declares none: validity start, else validity end.
   */
  readonly declaredEventTimeMs: (path: string) => number | null;
}

export function createEventTimeResolver(
  vault: string,
  frontmatterCache: FrontmatterCache,
): EventTimeResolver {
  const windowCache = new Map<string, ValidityWindow | null>();
  const validityWindowFor = (path: string): ValidityWindow | null => {
    if (windowCache.has(path)) return windowCache.get(path) ?? null;
    let window: ValidityWindow | null = null;
    try {
      const meta = readCachedFrontmatter(frontmatterCache, vault, path);
      window = parseValidityWindow(meta as Record<string, unknown>);
    } catch {
      window = null;
    }
    windowCache.set(path, window);
    return window;
  };
  const declaredEventTimeMs = (path: string): number | null => {
    const window = validityWindowFor(path);
    if (window === null || window.invalid) return null;
    return window.validFromMs ?? window.validUntilMs;
  };
  return { validityWindowFor, declaredEventTimeMs };
}

export interface RangeFilterInput {
  readonly hydrated: ReadonlyMap<number, HydratedChunk>;
  readonly keywordHits: KeywordHit[];
  readonly semanticHits: SemanticHit[];
  readonly timeRange: ResolvedTimeRange;
  readonly validityWindowFor: (path: string) => ValidityWindow | null;
}

export interface RangeFilterOutcome {
  readonly keywordHits: KeywordHit[];
  readonly semanticHits: SemanticHit[];
  readonly warnings: string[];
}

/**
 * Time-aware recall (recall-trust-suite): drop out-of-range candidates
 * BEFORE ranking so every later phase (traversal seeds, MMR, relation
 * polarity) sees only in-range candidates. An unparseable declared value
 * warns once per path and falls back to mtime.
 */
export function filterCandidatesInRange(input: RangeFilterInput): RangeFilterOutcome {
  const { hydrated, timeRange, validityWindowFor } = input;
  const warnings: string[] = [];
  const warnedInvalid = new Set<string>();
  const inRange = (chunkId: number): boolean => {
    const h = hydrated.get(chunkId);
    if (h === undefined) return false;
    const window = validityWindowFor(h.path);
    if (window?.invalid === true && !warnedInvalid.has(h.path)) {
      warnedInvalid.add(h.path);
      warnings.push(`validity: unparseable valid_from/valid_until in ${h.path}; using mtime`);
    }
    return eventTimeInRange(window, h.mtime, timeRange);
  };
  return {
    keywordHits: input.keywordHits.filter((h) => inRange(h.chunkId)),
    semanticHits: input.semanticHits.filter((h) => inRange(h.chunkId)),
    warnings,
  };
}
