/**
 * Write-route discrimination (signals-that-survive, unit 3).
 *
 * The extracted-fact router used to classify a captured span in a single
 * shot: the first family in the table that claimed the span won, and the
 * runner-up, the margin and the reason were dropped on the floor. This
 * module splits that decision in two, so an ambiguous capture is both
 * resolved and RECORDED:
 *
 *   - {@link scoreRouteCandidates} turns a captured span into a frozen,
 *     deterministically ordered candidate list. Every feature it reads is a
 *     character COUNT, a character OFFSET, or a SET MEMBERSHIP - never a
 *     natural-language token list, in any language (the same rule the
 *     extractor itself follows, see `fact-extract.ts`).
 *   - {@link discriminate} fires ONLY when the top two candidates sit
 *     within {@link ROUTE_DISCRIMINATION_MARGIN}. Inside that band a fixed,
 *     ordered ladder of pure structural rules separates them, and the id of
 *     the rule that decided is carried out with the decision. The terminal
 *     rule is family-table order, so a band with no earlier separator routes
 *     exactly where the single-shot classifier routed.
 *
 * The route table itself stays owned by the router (`FAMILY_PATTERNS`) and
 * is threaded in through the scoring context: one table, no second copy to
 * drift, and no import cycle back into `fact-extract.ts`.
 *
 * Recording is gated and payload-safe: {@link emitRouteDiscrimination}
 * routes through `emitGatedTelemetry`, so with the gate off no payload is
 * built and no write happens, and a throwing write never fails the capture
 * it is measuring. Only route names, numeric scores, the margin and the
 * rule id land on disk - never the fact text, and never a hash of it.
 *
 * Calibration note: the weights below have no ground truth yet. The band is
 * narrow on purpose and early records will mostly show the terminal rule
 * firing; that is the expected shape of a measurement surface before data
 * accumulates, and the records are what a later calibration reads.
 */

import { emitGatedTelemetry } from "../continuity/emit.ts";
import { appendContinuityRecord } from "../continuity/store.ts";
import type { ContinuityRecord } from "../continuity/types.ts";
import { normalizeEntityName } from "../entities/canonical.ts";
import { classifyDurability } from "../gates/durability.ts";
import type { ExtractedFact, FactFamily } from "../fact-extract.ts";

/** A write destination. Today's destinations are the extractor's families. */
export type RouteId = FactFamily;

/** A registry entity reduced to its normalised, matchable label forms. */
export interface RouteAnchor {
  readonly id: string;
  readonly forms: ReadonlyArray<string>;
}

export interface RouteScoringContext {
  /** The router's own route table, in its authoritative order. */
  readonly routes: ReadonlyArray<readonly [RouteId, RegExp]>;
  /** Anchorable registry entities, already reduced to normalised forms. */
  readonly anchors?: ReadonlyArray<RouteAnchor>;
  /** Compiled operator durability denylist, threaded through unchanged. */
  readonly durabilityDenylist?: ReadonlyArray<RegExp>;
  /** Routes whose dedup hash for THIS span is already in the caller's index. */
  readonly dedupedRoutes?: ReadonlySet<RouteId>;
}

/** Raw structural features behind a candidate's score. All are integers. */
export interface RouteFeatures {
  /** Length of the captured span, in characters. */
  readonly spanChars: number;
  /** Characters of the span this route's pattern matches. */
  readonly coveredChars: number;
  /** Length of this route's single longest match. */
  readonly longestMatchChars: number;
  /** Number of matches this route's pattern makes in the span. */
  readonly matchCount: number;
  /** Matches lying strictly inside another candidate's longer match. */
  readonly containedMatchCount: number;
  /** Registry anchors resolvable inside the characters this route covers. */
  readonly anchorCount: number;
  /** Registry anchors resolvable anywhere in the span. */
  readonly anchorTotal: number;
  /** 1 when this route's dedup hash for the span is already indexed. */
  readonly dedupHit: number;
  /** 1 when every character range this route covers is durable. */
  readonly durableSpan: number;
}

export interface RouteCandidate {
  readonly route: RouteId;
  /** The route's offset in the caller's route table - the terminal rule's key. */
  readonly order: number;
  readonly score: number;
  readonly features: RouteFeatures;
}

export type RouteRuleId =
  | "overlap-containment"
  | "anchor-majority"
  | "span-coverage"
  | "durable-span"
  | "dedup-continuity"
  | "family-table-order";

export interface RouteDiscrimination {
  readonly route: RouteId;
  readonly rule: RouteRuleId;
  /** Score distance between the top two candidates that opened the band. */
  readonly margin: number;
  /** The full scored candidate set, in candidate order. */
  readonly candidates: ReadonlyArray<RouteCandidate>;
}

/**
 * Feature weights. Each is a point contribution over a feature normalised
 * into [0,1] by a count already in {@link RouteFeatures}, so a score is a
 * plain point total on the same scale as {@link ROUTE_DISCRIMINATION_MARGIN}.
 */
export const ROUTE_SCORE_WEIGHTS = Object.freeze({
  /** Explaining most of the captured span is the strongest claim to it. */
  spanCoverage: 60,
  /** One contiguous match claims a span more strongly than several fragments. */
  longestMatch: 25,
  /** A match nested inside a longer one is a sub-reading, not a destination. */
  containmentPenalty: -20,
  /** Covering the span's canonical entities is weak corroboration, not proof. */
  entityAnchor: 4,
  /** Repeating an earlier capture's route keeps one topic on one route. */
  dedupHistory: 3,
  /** A destination whose covered text reads as transient is the worse home. */
  durableSpan: 3,
});

/**
 * Band width, in score points, inside which two candidates count as
 * near-equal and the ladder - not the raw score - decides.
 *
 * Bounded from below by the three corroborating weights above
 * (`entityAnchor + dedupHistory + durableSpan`): a route captured for its
 * own span always attains full coverage, the longest match and no
 * containment, so no rival can overtake it on the corroborating weights
 * without landing inside this band. Every route change is therefore a
 * RECORDED one.
 */
export const ROUTE_DISCRIMINATION_MARGIN = 10;

/**
 * Score precision, in decimal places. Rounding the point total keeps the
 * persisted score short and turns a float sum that differs only in its last
 * bits into an exact tie the ladder can recognise.
 */
const ROUTE_SCORE_DECIMALS = 3;

/** Continuity record kind carrying one discrimination decision. */
export const ROUTE_DISCRIMINATION_RECORD_KIND = "route_discrimination";

interface RouteRange {
  readonly start: number;
  readonly end: number;
}

/** One route's claim on the span: where its pattern matched, and its offset. */
interface RouteScan {
  readonly route: RouteId;
  readonly order: number;
  readonly ranges: ReadonlyArray<RouteRange>;
}

/** Everything the per-candidate feature pass shares across one span. */
interface SpanScan {
  readonly text: string;
  readonly scanned: ReadonlyArray<RouteScan>;
  readonly anchors: ReadonlyArray<RouteAnchor>;
  readonly anchorTotal: number;
  readonly durability: { readonly denylist?: ReadonlyArray<RegExp> };
  readonly dedupedRoutes: ReadonlySet<RouteId> | undefined;
}

/**
 * One ladder rung: a pure structural rank over a candidate. The rung fires
 * when exactly one tied candidate attains the maximum rank.
 */
interface RouteRule {
  readonly id: RouteRuleId;
  readonly rank: (candidate: RouteCandidate) => number;
}

/**
 * The ladder, in fixed order. The last rung ranks by table offset, which is
 * unique per candidate, so it always decides - and it decides exactly as the
 * single-shot family table did.
 */
const ROUTE_RULES: ReadonlyArray<RouteRule> = Object.freeze([
  { id: "overlap-containment", rank: (c) => (c.features.containedMatchCount === 0 ? 1 : 0) },
  { id: "anchor-majority", rank: (c) => c.features.anchorCount },
  { id: "span-coverage", rank: (c) => c.features.coveredChars },
  { id: "durable-span", rank: (c) => c.features.durableSpan },
  { id: "dedup-continuity", rank: (c) => c.features.dedupHit },
  { id: "family-table-order", rank: (c) => -c.order },
]);

/** The ladder's rule ids, in ladder order. */
export const ROUTE_RULE_IDS: ReadonlyArray<RouteRuleId> = Object.freeze(
  ROUTE_RULES.map((rule) => rule.id),
);

/**
 * Registry anchors resolvable in `text`: every anchorable entity whose
 * normalised label form appears in the normalised text. The canonicalization
 * kernel is the comparison boundary, so text and registry compare like with
 * like - and the forms come from the vault, never from a word list.
 */
export function anchorsWithin(
  anchors: ReadonlyArray<RouteAnchor>,
  text: string,
): ReadonlyArray<string> {
  if (anchors.length === 0) return [];
  const haystack = normalizeEntityName(text);
  const ids: string[] = [];
  for (const anchor of anchors) {
    if (anchor.forms.some((form) => haystack.includes(form))) ids.push(anchor.id);
  }
  return ids;
}

/**
 * Score every route that could claim this span, plus the route the span was
 * captured for (always a candidate, even when its own pattern no longer
 * re-matches the collapsed text). Pure: same span and same context, same
 * frozen array, ordered by score descending then by table offset.
 */
export function scoreRouteCandidates(
  fact: Pick<ExtractedFact, "family" | "text">,
  ctx: RouteScoringContext,
): ReadonlyArray<RouteCandidate> {
  const text = fact.text;
  const anchors = ctx.anchors ?? [];

  const scanned: RouteScan[] = [];
  for (const [order, entry] of ctx.routes.entries()) {
    const [route, pattern] = entry;
    const ranges = matchRanges(text, pattern, route);
    if (ranges.length > 0 || route === fact.family) scanned.push({ route, order, ranges });
  }
  // The captured route is a candidate by construction: a span the extractor
  // already assigned must be able to keep its destination.
  if (!scanned.some((s) => s.route === fact.family)) {
    scanned.push({ route: fact.family, order: ctx.routes.length, ranges: [] });
  }

  const span: SpanScan = {
    text,
    scanned,
    anchors,
    anchorTotal: anchorsWithin(anchors, text).length,
    durability: ctx.durabilityDenylist === undefined ? {} : { denylist: ctx.durabilityDenylist },
    dedupedRoutes: ctx.dedupedRoutes,
  };
  const candidates = scanned.map((scan) => {
    const features = buildFeatures(scan, span);
    return Object.freeze({
      route: scan.route,
      order: scan.order,
      score: scoreOf(features),
      features,
    });
  });
  candidates.sort((a, b) => b.score - a.score || a.order - b.order);
  return Object.freeze(candidates);
}

/**
 * Separate near-equal candidates. Returns `null` - no discrimination
 * happened - when fewer than two candidates sit within the margin of the
 * top one; the caller then keeps the destination the extractor assigned.
 */
export function discriminate(
  candidates: ReadonlyArray<RouteCandidate>,
): RouteDiscrimination | null {
  const top = candidates[0];
  const second = candidates[1];
  if (top === undefined || second === undefined) return null;
  const margin = round(top.score - second.score);
  if (margin > ROUTE_DISCRIMINATION_MARGIN) return null;

  const tied = candidates.filter((c) => round(top.score - c.score) <= ROUTE_DISCRIMINATION_MARGIN);
  for (const rule of ROUTE_RULES) {
    const winner = uniqueMaximum(tied, rule.rank);
    if (winner === null) continue;
    return Object.freeze({ route: winner.route, rule: rule.id, margin, candidates });
  }
  // The terminal rung ranks by table offset, which is unique per candidate,
  // so reaching here means the caller supplied a route table with a repeated
  // offset. That is a wiring defect, not a routing outcome.
  throw new Error(
    "route discrimination: the terminal rule did not separate the candidates; route table offsets must be unique",
  );
}

export interface RouteDiscriminationRecordInput {
  /** Canonical UTC timestamp of the capture the decision belongs to. */
  readonly createdAt: string;
  /** The destination the extractor assigned before discrimination. */
  readonly origin: RouteId;
  readonly decision: RouteDiscrimination;
}

/**
 * Emit one `route_discrimination` continuity record, gated and fail-open.
 *
 * `gate` doubles as the opt-in switch: with `false | null | undefined` the
 * build thunk never runs (no payload, no write) and the function returns
 * `null`. A throwing build is swallowed and reported as `null`, so a
 * telemetry failure can never abort the capture being recorded.
 *
 * Payload-safe by construction: route names, numeric scores, the margin and
 * the rule id only. The fact text never reaches this payload, and neither
 * does its dedup hash - a short hash over a low-entropy span (an address, a
 * price) is recoverable by search, which would put the text back.
 */
export function emitRouteDiscrimination<G>(
  vault: string,
  input: RouteDiscriminationRecordInput,
  gate: G | false | null | undefined,
): ContinuityRecord | null {
  return emitGatedTelemetry(gate, () => {
    const { origin, decision } = input;
    return appendContinuityRecord(vault, {
      kind: ROUTE_DISCRIMINATION_RECORD_KIND,
      createdAt: input.createdAt,
      sourceRefs: [],
      payload: {
        origin,
        route: decision.route,
        rule: decision.rule,
        margin: decision.margin,
        candidates: decision.candidates.map((c) => ({ route: c.route, score: c.score })),
      },
    });
  });
}

// ----- Feature extraction ----------------------------------------------------

function matchRanges(text: string, pattern: RegExp, route: RouteId): ReadonlyArray<RouteRange> {
  if (!pattern.global) {
    throw new TypeError(`route discrimination: route pattern for '${route}' must be global`);
  }
  // `matchAll` clones the regex, so the shared table pattern keeps no state;
  // the reset mirrors the extractor's own defensive reset.
  pattern.lastIndex = 0;
  const ranges: RouteRange[] = [];
  for (const match of text.matchAll(pattern)) {
    const matched = match[0] ?? "";
    if (matched.length === 0) continue;
    const start = match.index ?? 0;
    ranges.push({ start, end: start + matched.length });
  }
  return ranges;
}

function buildFeatures(scan: RouteScan, span: SpanScan): RouteFeatures {
  let coveredChars = 0;
  let longestMatchChars = 0;
  let containedMatchCount = 0;
  let durable = scan.ranges.length > 0;
  const anchorIds = new Set<string>();

  for (const range of scan.ranges) {
    const length = range.end - range.start;
    coveredChars += length;
    if (length > longestMatchChars) longestMatchChars = length;
    if (isContained(range, span.scanned, scan.route)) containedMatchCount++;
    const covered = span.text.slice(range.start, range.end);
    for (const id of anchorsWithin(span.anchors, covered)) anchorIds.add(id);
    if (durable && !classifyDurability(covered, span.durability).durable) durable = false;
  }

  return Object.freeze({
    spanChars: span.text.length,
    coveredChars,
    longestMatchChars,
    matchCount: scan.ranges.length,
    containedMatchCount,
    anchorCount: anchorIds.size,
    anchorTotal: span.anchorTotal,
    dedupHit: span.dedupedRoutes?.has(scan.route) === true ? 1 : 0,
    durableSpan: durable ? 1 : 0,
  });
}

/** True when a strictly longer match of ANOTHER candidate encloses `range`. */
function isContained(
  range: RouteRange,
  scanned: ReadonlyArray<RouteScan>,
  route: RouteId,
): boolean {
  const length = range.end - range.start;
  return scanned.some(
    (other) =>
      other.route !== route &&
      other.ranges.some(
        (o) => o.start <= range.start && o.end >= range.end && o.end - o.start > length,
      ),
  );
}

function scoreOf(f: RouteFeatures): number {
  const w = ROUTE_SCORE_WEIGHTS;
  const coverage = ratio(f.coveredChars, f.spanChars);
  const longest = ratio(f.longestMatchChars, f.spanChars);
  const contained = ratio(f.containedMatchCount, f.matchCount);
  const anchored = ratio(f.anchorCount, f.anchorTotal);
  return round(
    w.spanCoverage * coverage +
      w.longestMatch * longest +
      w.containmentPenalty * contained +
      w.entityAnchor * anchored +
      w.dedupHistory * f.dedupHit +
      w.durableSpan * f.durableSpan,
  );
}

function ratio(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

function round(value: number): number {
  const scale = 10 ** ROUTE_SCORE_DECIMALS;
  return Math.round(value * scale) / scale;
}

/** The single candidate holding the maximum rank, or `null` when it is shared. */
function uniqueMaximum(
  candidates: ReadonlyArray<RouteCandidate>,
  rank: (candidate: RouteCandidate) => number,
): RouteCandidate | null {
  let best: RouteCandidate | null = null;
  let bestRank = Number.NEGATIVE_INFINITY;
  let shared = false;
  for (const candidate of candidates) {
    const value = rank(candidate);
    if (value > bestRank) {
      best = candidate;
      bestRank = value;
      shared = false;
    } else if (value === bestRank) {
      shared = true;
    }
  }
  return shared ? null : best;
}
