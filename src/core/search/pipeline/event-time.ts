/**
 * Event-time discipline for one query (t_b7191486): the single definition
 * of "event time, storage time only as fallback" shared by the hard time
 * filter, the targeted-retry coverage gate, the temporal bridge and the
 * query-side temporal layer - plus the hard filter itself.
 *
 * A document declaring `valid_from` / `valid_until` is judged by
 * validity-window OVERLAP; storage mtime is the fallback, never the
 * authority, when explicit event time exists.
 *
 * Provenance at the boundary (t_ac1c4176) widened what "declared" means:
 * a note may state when it is about in its `created_at` / `date`
 * frontmatter or in its BODY, and the indexer materialises that as the
 * document's EVENT ANCHOR (see `event-anchor.ts`). Frontmatter validity
 * still wins - it is read live here and is not re-implemented - and the
 * stored anchor is consulted only for a page that declares no validity
 * window at all. A page that declares nothing anywhere still falls back
 * to mtime, byte-identically to before the anchor existed.
 */

import type { EventAnchor } from "../event-anchor.ts";
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

/** The materialised event anchor of a path, or null when it has none. */
export type EventAnchorLookup = (path: string) => EventAnchor | null;

export function createEventTimeResolver(
  vault: string,
  frontmatterCache: FrontmatterCache,
  eventAnchorFor: EventAnchorLookup,
): EventTimeResolver {
  const windowCache = new Map<string, ValidityWindow | null>();
  const validityWindowFor = (path: string): ValidityWindow | null => {
    if (windowCache.has(path)) return windowCache.get(path) ?? null;
    let window: ValidityWindow | null = null;
    try {
      const meta = readCachedFrontmatter(frontmatterCache, vault, path);
      window = parseValidityWindow(meta as Record<string, unknown>);
      // No validity fields at all is an ABSENCE, so the note's other
      // statements about its own event time get their turn. A frontmatter
      // read that THREW is a different answer - the page could not be
      // examined - and must not be answered from the index instead, so
      // the catch below deliberately does not reach here.
      if (window === null) window = anchorWindow(eventAnchorFor(path));
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

/**
 * Present the materialised anchor in the shape every downstream time
 * filter already consumes. `invalid` is always false: an anchor that
 * could not be resolved was never stored, so a stored one is by
 * construction readable.
 */
function anchorWindow(anchor: EventAnchor | null): ValidityWindow | null {
  if (anchor === null) return null;
  return Object.freeze({
    validFromMs: anchor.startMs,
    validUntilMs: anchor.endMs,
    invalid: false,
  });
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
