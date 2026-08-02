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
 * a note may state when it is about in its BODY, and the indexer
 * materialises that as the document's EVENT ANCHOR (see
 * `event-anchor.ts`). Frontmatter validity still wins - it is read live
 * here and is not re-implemented - and the stored anchor is consulted
 * only for a page that declares no validity window at all. A page that
 * declares nothing anywhere still falls back to mtime, byte-identically
 * to before the anchor existed.
 *
 * Only the rungs `anchorIsEventTime` admits are consulted. The anchor
 * also records a note's `created_at` / `date` frontmatter, which every
 * Brain writer stamps and which describes when the file was authored;
 * judging a document by it here would remove it from a hard `since` /
 * `until` filter it was in before this release, changing what a
 * time-ranged query means. That rung stays recorded and unconsulted.
 */

import { anchorIsEventTime, type EventAnchor, type EventAnchorSource } from "../event-anchor.ts";
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
  /**
   * The anchor rung that supplied this path's window, or null when the
   * page's own frontmatter supplied it and nothing was inferred. A
   * caller that REMOVES a candidate uses this to say so.
   */
  readonly inferredEventTimeSourceFor: (path: string) => EventAnchorSource | null;
}

/** The materialised event anchor of a path, or null when it has none. */
export type EventAnchorLookup = (path: string) => EventAnchor | null;

/** One path's resolved event-time window and where it came from. */
interface ResolvedEventTime {
  readonly window: ValidityWindow | null;
  readonly anchorSource: EventAnchorSource | null;
}

/** The answer for a page that states nothing this layer can use. */
const NO_EVENT_TIME: ResolvedEventTime = Object.freeze({ window: null, anchorSource: null });

export function createEventTimeResolver(
  vault: string,
  frontmatterCache: FrontmatterCache,
  eventAnchorFor: EventAnchorLookup,
): EventTimeResolver {
  const cache = new Map<string, ResolvedEventTime>();
  const resolve = (path: string): ResolvedEventTime => {
    const cached = cache.get(path);
    if (cached !== undefined) return cached;
    let declared: ValidityWindow | null = null;
    try {
      const meta = readCachedFrontmatter(frontmatterCache, vault, path);
      declared = parseValidityWindow(meta as Record<string, unknown>);
    } catch {
      declared = null;
    }
    // No validity fields at all is an ABSENCE, so the note's other
    // statements about its own event time get their turn. The anchor
    // lookup sits OUTSIDE the catch above on purpose: that catch answers
    // "the page could not be examined" with a fallback to mtime, and an
    // index row this binary cannot interpret is a different failure that
    // must reach the caller. Answering it from here would report "no
    // declared event time" for a document whose declaration was simply
    // unreadable - and, because the result is memoised, would do so for
    // every candidate in the call.
    const resolved =
      declared !== null
        ? { window: declared, anchorSource: null }
        : anchorEventTime(eventAnchorFor(path));
    cache.set(path, resolved);
    return resolved;
  };
  const validityWindowFor = (path: string): ValidityWindow | null => resolve(path).window;
  const declaredEventTimeMs = (path: string): number | null => {
    const window = validityWindowFor(path);
    if (window === null || window.invalid) return null;
    return window.validFromMs ?? window.validUntilMs;
  };
  const inferredEventTimeSourceFor = (path: string): EventAnchorSource | null =>
    resolve(path).anchorSource;
  return { validityWindowFor, declaredEventTimeMs, inferredEventTimeSourceFor };
}

/**
 * Present the materialised anchor in the shape every downstream time
 * filter already consumes, for the rungs that ARE event time. `invalid`
 * is always false: an anchor that could not be resolved was never
 * stored, so a stored one is by construction readable.
 */
function anchorEventTime(anchor: EventAnchor | null): ResolvedEventTime {
  if (anchor === null || !anchorIsEventTime(anchor)) return NO_EVENT_TIME;
  return Object.freeze({
    window: Object.freeze({
      validFromMs: anchor.startMs,
      validUntilMs: anchor.endMs,
      invalid: false,
    }),
    anchorSource: anchor.source,
  });
}

export interface RangeFilterInput {
  readonly hydrated: ReadonlyMap<number, HydratedChunk>;
  readonly keywordHits: KeywordHit[];
  readonly semanticHits: SemanticHit[];
  readonly timeRange: ResolvedTimeRange;
  readonly validityWindowFor: (path: string) => ValidityWindow | null;
  /** See {@link EventTimeResolver.inferredEventTimeSourceFor}. */
  readonly inferredEventTimeSourceFor: (path: string) => EventAnchorSource | null;
}

export interface RangeFilterOutcome {
  readonly keywordHits: KeywordHit[];
  readonly semanticHits: SemanticHit[];
  readonly warnings: string[];
}

/**
 * The one place the anchor-drop line is written. Names the path and the
 * registered rung token, so the reader can tell an inferred body date
 * from a declared validity window without reading this file.
 */
function anchorDropWarning(path: string, source: EventAnchorSource): string {
  return `event-anchor: ${path} is outside the requested range by its ${source}-declared event time, not its mtime`;
}

/**
 * Time-aware recall (recall-trust-suite): drop out-of-range candidates
 * BEFORE ranking so every later phase (traversal seeds, MMR, relation
 * polarity) sees only in-range candidates. An unparseable declared value
 * warns once per path and falls back to mtime.
 */
export function filterCandidatesInRange(input: RangeFilterInput): RangeFilterOutcome {
  const { hydrated, timeRange, validityWindowFor, inferredEventTimeSourceFor } = input;
  const warnings: string[] = [];
  const warnedInvalid = new Set<string>();
  const warnedDropped = new Set<string>();
  const inRange = (chunkId: number): boolean => {
    const h = hydrated.get(chunkId);
    if (h === undefined) return false;
    const window = validityWindowFor(h.path);
    if (window?.invalid === true && !warnedInvalid.has(h.path)) {
      warnedInvalid.add(h.path);
      warnings.push(`validity: unparseable valid_from/valid_until in ${h.path}; using mtime`);
    }
    const kept = eventTimeInRange(window, h.mtime, timeRange);
    // A candidate removed on the strength of a date this tool INFERRED
    // rather than one the page declared in frontmatter is the one case
    // where the filter's answer differs from what the operator wrote
    // down. It is never silent: the path and the rung are named.
    if (!kept && !warnedDropped.has(h.path)) {
      const source = inferredEventTimeSourceFor(h.path);
      if (source !== null) {
        warnedDropped.add(h.path);
        warnings.push(anchorDropWarning(h.path, source));
      }
    }
    return kept;
  };
  return {
    keywordHits: input.keywordHits.filter((h) => inRange(h.chunkId)),
    semanticHits: input.semanticHits.filter((h) => inRange(h.chunkId)),
    warnings,
  };
}
