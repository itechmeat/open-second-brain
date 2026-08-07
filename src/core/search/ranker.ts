/**
 * Pure ranking function. Combines normalised BM25, cosine semantic
 * similarity, link-graph boost, and recency boost into the final score.
 *
 * Anchored in docs/plans/2026-05-16-brain-search-design.md §7.
 *
 * The ranker imports no I/O modules. Callers (search.ts) gather the
 * inputs from the store and pass them in. This makes it trivially
 * testable and substitutable.
 */

import { clamp01 } from "../math.ts";
import { PAGE_TIER_DEFAULT, tierWeight, type PageTier } from "../brain/page-meta/tier.ts";
import { weibullDecay, DEFAULT_RECENCY, type WeibullRecencyOptions } from "./recency.ts";
import { scoreSessionFocusTarget } from "./session-focus.ts";
import { rrfFuse, DEFAULT_RRF_K, type FusionMode } from "./fusion.ts";
import { temporalProximity, DEFAULT_WINDOW_PAD_DAYS } from "./temporal-bridge.ts";
import type { TemporalIntent } from "./temporal-intent.ts";
import type { KeywordHit, SemanticHit, HydratedChunk } from "./store.ts";
import type {
  BrainSearchResult,
  ScoreBreakdown,
  SearchSessionFocus,
  WeightProfile,
} from "./types.ts";

export interface RankerInputs {
  readonly keyword: ReadonlyArray<KeywordHit>;
  readonly semantic: ReadonlyArray<SemanticHit>;
  readonly hydrated: ReadonlyMap<number, HydratedChunk>;
  /** For each chunkId: set of OTHER document ids linking to its document. */
  readonly inboundLinkSources: ReadonlyMap<number, ReadonlySet<number>>;
  /** For each chunkId: the tag set of its document. */
  readonly tagsByDoc: ReadonlyMap<number, ReadonlySet<string>>;
  /**
   * Optional importance tier per documentId. Missing entries (and
   * the absent map entirely) resolve to `supporting`, whose tier
   * weight is `1.0` - so a vault without any tier tags ranks
   * bit-identically to pre-tier behaviour.
   */
  readonly tierByDoc?: ReadonlyMap<number, PageTier>;
  /**
   * Optional per-chunk count of query entities the chunk also carries
   * (v0.13.0). Missing entries (and the absent map) contribute zero
   * boost, so the entity layer adds nothing until the index is
   * populated by a reindex.
   */
  readonly entityMatchByChunk?: ReadonlyMap<number, number>;
  /**
   * Optional per-chunk effective activation in [0, 1] (Time-Aware
   * Recall & Activation Suite): access-reinforced strength already
   * decayed by the content-type half-life. Missing entries (and the
   * absent map) contribute zero boost, so a vault without recorded
   * accesses ranks bit-identically to pre-activation behaviour.
   */
  readonly activationByChunk?: ReadonlyMap<number, number>;
  /**
   * Optional co-access companions per chunk (t_c5ef25a3): for each
   * chunkId, the OTHER document ids habitually co-retrieved with its
   * document, with the recorded pair count. Only companions that are
   * also in the current candidate pool contribute (the same
   * pool-membership rule the link boost uses), so the boost re-ranks a
   * working set without floating unrelated documents.
   */
  readonly coAccessByChunk?: ReadonlyMap<number, ReadonlyMap<number, number>>;
  /**
   * Optional freshness trend per documentId (t_ee09a6ce), read from
   * the `freshness_trend` frontmatter the dream refresh stamps on
   * preference pages. Maps to a bounded multiplier on the relevance
   * portion (strengthening 1.05, weakening 0.93, stale 0.85); absent
   * entries (and the absent map) stay neutral.
   */
  readonly trendByDoc?: ReadonlyMap<number, string>;
  /**
   * Optional observed-reuse score per chunk in [0, 1] (t_65588d8b): the
   * folded USED-vs-CONTRADICTED rate of the chunk's document, the preferred
   * outcome signal over predicted importance. Missing entries (and the
   * absent map) contribute zero boost, so a vault with no observed-use
   * verdicts ranks bit-identically.
   */
  readonly reuseRateByChunk?: ReadonlyMap<number, number>;
  /**
   * Optional relational RRF arm (t_09b7ccea): chunk ids from typed-edge
   * fan-out, best-first. Only consulted in `rrf` fusion. A relational-only
   * chunk (not already a keyword/semantic candidate) is admitted as a
   * candidate so a genuinely related node can surface. Absent or empty
   * leaves ranking byte-identical.
   */
  readonly relationalRankedChunkIds?: ReadonlyArray<number>;
  /**
   * Optional DECLARED event time per chunk in unix ms (t_58fc4720): the
   * validity-window start the document states in its frontmatter. Read
   * only by the query-side temporal layer, and only for chunks that
   * actually declare one - a missing entry (and the absent map) falls
   * back to the chunk's storage mtime, the same "validity start, else
   * mtime" rule `temporal-bridge.ts` applies.
   */
  readonly eventTimeMsByChunk?: ReadonlyMap<number, number>;
}

/**
 * Bounded additive-boost caps. Every one of these layers is a re-ranker
 * over an already-relevant candidate set: large enough to reorder it,
 * never large enough to float an irrelevant chunk. They are named here,
 * together, because their PROPORTION to each other is the calibration -
 * a cap is only meaningful relative to its siblings.
 */
/** Inbound links plus shared tags, combined. */
export const LINK_BOOST_CAP = 0.05;
/** The inbound-link half of {@link LINK_BOOST_CAP}. */
const LINK_ONLY_BOOST_CAP = 0.03;
/** The shared-tag half of {@link LINK_BOOST_CAP}. */
const TAG_ONLY_BOOST_CAP = 0.02;
/** Query entities the chunk also carries. */
export const ENTITY_BOOST_CAP = 0.04;
/** Access-reinforced, type-decayed activation. */
export const ACTIVATION_BOOST_CAP = 0.04;
/** Habitual co-retrieval companions inside the candidate pool. */
export const CO_ACCESS_BOOST_CAP = 0.03;
/** Folded USED-vs-CONTRADICTED outcome rate: the strongest evidence layer. */
export const REUSE_BOOST_CAP = 0.06;
/**
 * Query-declared temporal window (t_58fc4720). Set level with the reuse
 * cap - the top of the band - because it corrects a prior that is itself
 * worth up to the full recency amplitude (0.05) in the WRONG direction:
 * a smaller cap could not overcome the freshness prior it exists to
 * offset, and the layer would be decorative.
 */
export const TEMPORAL_INTENT_BOOST_CAP = 0.06;

/** Freshness-trend multipliers on the relevance portion. */
const TREND_MULTIPLIERS: ReadonlyMap<string, number> = new Map([
  ["strengthening", 1.05],
  ["weakening", 0.93],
  ["stale", 0.85],
]);

/**
 * Relation-only supersede fade (t_c4a9cef8), applied through kernel 1 by
 * the supersede-fade adjuster - NOT inside `rankResults`. It lives here,
 * beside the freshness multipliers, because it is the same family of
 * bounded score-scaling constant: a candidate a surfaced `superseded_by`
 * relation marks superseded is faded to this share of its score so a
 * stale memory that survived the tombstone drop cannot outrank the memory
 * that replaced it. A pool with no such relation ranks byte-identically.
 */
export const SUPERSEDE_FADE_MULTIPLIER = 0.5;

export interface RankerOptions {
  readonly keywordWeight: number;
  readonly semanticWeight: number;
  readonly limit: number;
  /** Unix-ms reference time for recency. Defaults to Date.now(). */
  readonly nowMs?: number;
  /** When false, semantic_score is ignored regardless of inputs. */
  readonly semanticEnabled?: boolean;
  /**
   * Weibull recency curve parameters. Absent uses {@link DEFAULT_RECENCY},
   * which approximates the legacy step function. Callers (search.ts)
   * thread the resolved config here.
   */
  readonly recency?: WeibullRecencyOptions;
  /**
   * Per-query ranking multipliers from the query plan (v0.20.0). Absent
   * (or an all-1.0 neutral profile) leaves every layer at its configured
   * weight, so ranking is bit-identical to pre-intent behaviour.
   */
  readonly weightProfile?: WeightProfile;
  readonly sessionFocus?: SearchSessionFocus | null;
  /**
   * Rank-fusion mode (Embedding Provider Suite). `linear` (default) is
   * the weighted sum of normalised BM25 and cosine; `rrf` fuses the two
   * lanes by reciprocal rank. Absent or `linear` keeps ranking
   * bit-identical to pre-suite behaviour.
   */
  readonly fusionMode?: FusionMode;
  /** RRF damping constant; defaults to {@link DEFAULT_RRF_K}. */
  readonly rrfK?: number;
  /**
   * The time window the query declares (t_58fc4720), resolved by
   * `temporal-intent.ts` at the query-plan seam. When present it adds a
   * capped proximity boost for candidates whose event time falls in (or
   * near) the window, and damps the query-independent freshness prior
   * when that window is historical. Absent or null leaves ranking
   * byte-identical, including the `temporal` breakdown key, which is
   * then omitted rather than reported as zero.
   */
  readonly temporalIntent?: TemporalIntent | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Min-max normalise BM25 within the candidate set. Lower BM25 is better. */
function normalizeBm25(hits: ReadonlyArray<KeywordHit>): Map<number, number> {
  const out = new Map<number, number>();
  if (hits.length === 0) return out;
  // FTS5 bm25() returns smaller-is-better values (often negative). We invert
  // to "larger is better" by negating, then min-max.
  const scores = hits.map((h) => -h.bm25);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  if (max === min) {
    for (const h of hits) out.set(h.chunkId, 1);
    return out;
  }
  hits.forEach((h, i) => {
    out.set(h.chunkId, (scores[i]! - min) / (max - min));
  });
  return out;
}

/** Map L2-on-unit-vectors distance → cosine similarity in [0, 1]. */
function semanticFromDistance(distance: number): number {
  const sim = 1 - (distance * distance) / 2;
  return clamp01(sim);
}

function recencyBoost(mtime: number, nowMs: number, opts: WeibullRecencyOptions): number {
  const ageMs = Math.max(0, nowMs - mtime * 1000);
  const ageDays = ageMs / DAY_MS;
  return weibullDecay(ageDays, opts);
}

interface Candidate {
  chunkId: number;
  documentId: number;
  keywordScore: number;
  semanticScore: number;
  searchType: "keyword" | "semantic" | "hybrid" | "link";
  mtime: number;
}

/** Fixed-precision so the same vault yields the same reason strings. */
function fmt(x: number): string {
  return x.toFixed(3);
}

/**
 * Assemble the explainable-recall `reasons` array from the per-layer
 * values the ranker already computed. One entry per layer that fired;
 * a layer contributing exactly zero is omitted so the array stays
 * meaningful. The tier layer is reported only when it is not the
 * neutral 1.0 multiplier.
 */
function buildReasons(parts: {
  keywordScore: number;
  semanticScore: number;
  linkBoost: number;
  recency: number;
  tierMul: number;
  entityBoost?: number;
  activationBoost?: number;
  coAccessBoost?: number;
  reuseBoost?: number;
  trend?: string;
  trendMul?: number;
  sessionFocus?: number;
  rrf?: number;
  temporalBoost?: number;
  temporalDamping?: number;
}): ReadonlyArray<string> {
  const reasons: string[] = [];
  if (parts.keywordScore > 0) reasons.push(`fts5_bm25: ${fmt(parts.keywordScore)}`);
  if (parts.semanticScore > 0) reasons.push(`semantic_cos: ${fmt(parts.semanticScore)}`);
  if (parts.rrf && parts.rrf > 0) reasons.push(`rrf: ${fmt(parts.rrf)}`);
  if (parts.entityBoost && parts.entityBoost > 0) {
    reasons.push(`entity_match: ${fmt(parts.entityBoost)}`);
  }
  if (parts.activationBoost && parts.activationBoost > 0) {
    reasons.push(`activation: ${fmt(parts.activationBoost)}`);
  }
  if (parts.coAccessBoost && parts.coAccessBoost > 0) {
    reasons.push(`co_access: ${fmt(parts.coAccessBoost)}`);
  }
  if (parts.reuseBoost && parts.reuseBoost > 0) {
    reasons.push(`observed_reuse: ${fmt(parts.reuseBoost)}`);
  }
  if (parts.trend !== undefined && parts.trendMul !== undefined && parts.trendMul !== 1) {
    reasons.push(`freshness_trend: ${parts.trend} x${fmt(parts.trendMul)}`);
  }
  if (parts.linkBoost > 0) reasons.push(`link_boost: ${fmt(parts.linkBoost)}`);
  if (parts.recency > 0) reasons.push(`recency: ${fmt(parts.recency)}`);
  // Query-side temporal intent, kept SEPARATE from the `recency` entry
  // above so a ranking change is attributable to one layer or the other.
  // Reported whenever the layer had an effect - a zero boost still
  // matters when the window damped the freshness prior, which is exactly
  // the case for an out-of-window recent document.
  if (
    parts.temporalBoost !== undefined &&
    (parts.temporalBoost > 0 || (parts.temporalDamping ?? 1) !== 1)
  ) {
    const damping = parts.temporalDamping ?? 1;
    const suffix = damping === 1 ? "" : ` recency x${fmt(damping)}`;
    reasons.push(`temporal_intent: ${fmt(parts.temporalBoost)}${suffix}`);
  }
  if (parts.tierMul !== 1) reasons.push(`tier: ${fmt(parts.tierMul)}`);
  if (parts.sessionFocus && parts.sessionFocus !== 0) {
    reasons.push(`session_focus: ${parts.sessionFocus >= 0 ? "+" : ""}${fmt(parts.sessionFocus)}`);
  }
  return Object.freeze(reasons);
}

/**
 * Structured sibling of {@link buildReasons} over the same per-layer
 * values. Every component is a number: zero for an additive layer that
 * did not fire, 1 for a neutral multiplier. No omission and no
 * formatting, so callers (the MCP `explain` projection, `feedback.ts`)
 * read the contributions without re-parsing the reason strings.
 */
function buildBreakdown(parts: {
  keywordScore: number;
  semanticScore: number;
  linkBoost: number;
  recency: number;
  tierMul: number;
  entityBoost?: number;
  activationBoost?: number;
  coAccessBoost?: number;
  reuseBoost?: number;
  trendMul?: number;
  sessionFocus?: number;
  rrf?: number;
  temporalBoost?: number;
}): ScoreBreakdown {
  return Object.freeze({
    keyword: parts.keywordScore,
    semantic: parts.semanticScore,
    rrf: parts.rrf ?? 0,
    entity: parts.entityBoost ?? 0,
    activation: parts.activationBoost ?? 0,
    coAccess: parts.coAccessBoost ?? 0,
    reuse: parts.reuseBoost ?? 0,
    link: parts.linkBoost,
    recency: parts.recency,
    tier: parts.tierMul,
    trend: parts.trendMul ?? 1,
    sessionFocus: parts.sessionFocus ?? 0,
    // The one layer reported by ABSENCE rather than by zero: a query
    // that declared no window has no temporal component at all, and a
    // consumer must be able to tell that from a window the candidate
    // simply fell outside of.
    ...(parts.temporalBoost !== undefined ? { temporal: parts.temporalBoost } : {}),
  });
}

export function rankResults(inputs: RankerInputs, opts: RankerOptions): BrainSearchResult[] {
  const nowMs = opts.nowMs ?? Date.now();
  const semanticEnabled = opts.semanticEnabled !== false;
  const recencyOpts = opts.recency ?? DEFAULT_RECENCY;
  // Per-query intent multipliers. Absent or neutral (all 1.0) leaves the
  // score bit-identical to pre-intent behaviour.
  const kwMul = opts.weightProfile?.keywordMul ?? 1;
  const semMul = opts.weightProfile?.semanticMul ?? 1;
  const entMul = opts.weightProfile?.entityMul ?? 1;
  const recMul = opts.weightProfile?.recencyMul ?? 1;
  // Query-side temporal intent (t_58fc4720). Null (the default) keeps
  // the damping neutral and leaves the layer entirely unreported.
  const temporalIntent = opts.temporalIntent ?? null;
  const temporalDamping = temporalIntent?.recencyDamping ?? 1;

  const kwNorm = normalizeBm25(inputs.keyword);

  const semNorm = new Map<number, number>();
  if (semanticEnabled) {
    for (const h of inputs.semantic) {
      semNorm.set(h.chunkId, semanticFromDistance(h.distance));
    }
  }

  // Reciprocal Rank Fusion (Embedding Provider Suite): fuse the lanes by
  // rank position instead of weighted magnitude. Off by default; when on,
  // it replaces the linear relevance term while every boost still applies.
  const fusionMode: FusionMode = opts.fusionMode ?? "linear";
  let rrfByChunk: Map<number, number> | null = null;
  if (fusionMode === "rrf") {
    const keywordRanked = inputs.keyword
      .toSorted((a, b) => a.bm25 - b.bm25) // lower BM25 = better
      .map((h) => h.chunkId);
    const semanticRanked = semanticEnabled
      ? inputs.semantic.toSorted((a, b) => a.distance - b.distance).map((h) => h.chunkId)
      : [];
    rrfByChunk = rrfFuse({
      keywordRankedChunkIds: keywordRanked,
      semanticRankedChunkIds: semanticRanked,
      relationalRankedChunkIds: inputs.relationalRankedChunkIds ?? [],
      k: opts.rrfK ?? DEFAULT_RRF_K,
      // The intent profile weights the per-lane CONTRIBUTIONS, not the
      // fused score: a post-fusion multiplier is a constant factor on
      // every candidate and could not express a lane preference at all.
      // A neutral profile passes 1 on both lanes, which is the classic
      // weightless term bit for bit.
      laneWeights: { keyword: kwMul, semantic: semMul },
    });
  }

  const candidates = new Map<number, Candidate>();
  for (const h of inputs.keyword) {
    candidates.set(h.chunkId, {
      chunkId: h.chunkId,
      documentId: h.documentId,
      keywordScore: kwNorm.get(h.chunkId) ?? 0,
      semanticScore: 0,
      searchType: "keyword",
      mtime: inputs.hydrated.get(h.chunkId)?.mtime ?? 0,
    });
  }
  if (semanticEnabled) {
    for (const h of inputs.semantic) {
      const existing = candidates.get(h.chunkId);
      if (existing) {
        existing.semanticScore = semNorm.get(h.chunkId) ?? 0;
        existing.searchType = "hybrid";
      } else {
        candidates.set(h.chunkId, {
          chunkId: h.chunkId,
          documentId: h.documentId,
          keywordScore: 0,
          semanticScore: semNorm.get(h.chunkId) ?? 0,
          searchType: "semantic",
          mtime: inputs.hydrated.get(h.chunkId)?.mtime ?? 0,
        });
      }
    }
  }

  // Relational arm candidates (t_09b7ccea): admit relational-only chunks
  // (surfaced via the typed-edge fan-out lane but not matched by keyword or
  // semantic) so a genuinely related node can enter the fused ranking. Only
  // in rrf mode, where the lane above already contributes their score.
  // searchType "link" - a typed-graph traversal hit. Empty lane = no
  // additions, so ranking stays byte-identical.
  if (rrfByChunk !== null && inputs.relationalRankedChunkIds) {
    for (const chunkId of inputs.relationalRankedChunkIds) {
      if (candidates.has(chunkId)) continue;
      const hyd = inputs.hydrated.get(chunkId);
      if (hyd === undefined) continue;
      candidates.set(chunkId, {
        chunkId,
        documentId: hyd.documentId,
        keywordScore: 0,
        semanticScore: 0,
        searchType: "link",
        mtime: hyd.mtime,
      });
    }
  }

  // Cross-result tables for boosts.
  const candidateChunks = Array.from(candidates.values());
  const candidateDocIds = new Set(candidateChunks.map((c) => c.documentId));

  // Build a per-document tag map so the tag boost counts distinct docs,
  // not chunks. Without this dedup a doc with K candidate chunks would
  // inflate every other candidate's tag count K-fold.
  const tagsByDocId = new Map<number, ReadonlySet<string>>();
  for (const c of candidateChunks) {
    if (tagsByDocId.has(c.documentId)) continue;
    const t = inputs.tagsByDoc.get(c.chunkId);
    if (t && t.size > 0) tagsByDocId.set(c.documentId, t);
  }

  function linkBoostFor(c: Candidate): number {
    const sources = inputs.inboundLinkSources.get(c.chunkId);
    if (!sources || sources.size === 0) return 0;
    let count = 0;
    for (const s of sources) {
      if (s === c.documentId) continue;
      if (candidateDocIds.has(s)) count++;
    }
    const raw = count * 0.02;
    return Math.min(LINK_ONLY_BOOST_CAP, raw);
  }

  function tagBoostFor(c: Candidate): number {
    const mine = tagsByDocId.get(c.documentId);
    if (!mine || mine.size === 0) return 0;
    let count = 0;
    for (const [otherDocId, theirs] of tagsByDocId) {
      if (otherDocId === c.documentId) continue;
      for (const tag of mine) {
        if (theirs.has(tag)) {
          count++;
          break;
        }
      }
    }
    const raw = count * 0.01;
    return Math.min(TAG_ONLY_BOOST_CAP, raw);
  }

  const ranked: BrainSearchResult[] = [];
  for (const c of candidateChunks) {
    const hyd = inputs.hydrated.get(c.chunkId);
    if (!hyd) continue;
    const link = linkBoostFor(c);
    const tag = tagBoostFor(c);
    const linkBoost = Math.min(LINK_BOOST_CAP, link + tag);
    // Freshness prior, damped when the query named a historical window:
    // the prior points at "now" and the query points at the past, so
    // leaving it undamped would fight the layer below. Damped, never
    // removed - `recencyAmplitude: 0` stays the only off switch.
    const recency = recencyBoost(c.mtime, nowMs, recencyOpts) * recMul * temporalDamping;
    // Relevance term: reciprocal-rank-fused when in rrf mode, otherwise
    // the weighted sum of the normalised lanes. The fused value already
    // carries the intent multipliers (applied per lane, above); the
    // CONFIGURED lane weights stay out of it, because they calibrate two
    // score magnitudes and rank fusion reads no magnitudes.
    const rrf = rrfByChunk?.get(c.chunkId) ?? 0;
    const weighted =
      rrfByChunk !== null
        ? rrf
        : opts.keywordWeight * kwMul * c.keywordScore +
          (semanticEnabled ? opts.semanticWeight * semMul : 0) * c.semanticScore;
    // Tier multiplier applied to the relevance portion only so the
    // tag / link / recency boosts stay tier-neutral. Default
    // `supporting` → 1.0 keeps untagged vaults bit-identical.
    const tier = inputs.tierByDoc?.get(c.documentId) ?? PAGE_TIER_DEFAULT;
    const tierMul = tierWeight(tier);
    // Freshness-trend multiplier (t_ee09a6ce): like tier, it scales the
    // relevance portion only. Unstamped documents (and unknown labels)
    // stay at the neutral 1.0.
    const trend = inputs.trendByDoc?.get(c.documentId);
    const trendMul = trend !== undefined ? (TREND_MULTIPLIERS.get(trend) ?? 1) : 1;
    // Entity boost: capped contribution from shared query entities.
    // Per-match 0.02, capped at 0.04 so it only re-ranks an already
    // relevant set - never enough to float an irrelevant chunk.
    const entityMatches = inputs.entityMatchByChunk?.get(c.chunkId) ?? 0;
    const entityBoost = Math.min(ENTITY_BOOST_CAP, entityMatches * 0.02 * entMul);
    // Activation boost (Time-Aware Recall & Activation Suite): the
    // effective (type-decayed) activation scales into a capped 0.04
    // contribution - a re-ranker for habitually-recalled memories,
    // never enough to float an irrelevant chunk.
    const activation = clamp01(inputs.activationByChunk?.get(c.chunkId) ?? 0);
    const activationBoost = Math.min(ACTIVATION_BOOST_CAP, activation * ACTIVATION_BOOST_CAP);
    // Co-access companion boost (t_c5ef25a3): per habitual companion
    // that is ALSO in the candidate pool, 0.005 per recorded pair
    // count, capped at 0.03 - surfaces the rest of a recurring working
    // set without floating unrelated documents.
    let coAccessRaw = 0;
    const companions = inputs.coAccessByChunk?.get(c.chunkId);
    if (companions !== undefined) {
      for (const [docId, count] of companions) {
        if (docId === c.documentId) continue;
        if (candidateDocIds.has(docId)) coAccessRaw += count * 0.005;
      }
    }
    const coAccessBoost = Math.min(CO_ACCESS_BOOST_CAP, coAccessRaw);
    // Observed-reuse boost (t_65588d8b): the folded USED-vs-CONTRADICTED
    // rate of the chunk's document. Capped at 0.06 - larger than the
    // activation / co-access caps so a memory the agent demonstrably reused
    // outranks one merely predicted-important, yet still a bounded re-ranker
    // that never floats an irrelevant chunk. Zero (byte-identical) when no
    // observed-use verdicts exist.
    const reuseRate = clamp01(inputs.reuseRateByChunk?.get(c.chunkId) ?? 0);
    const reuseBoost = Math.min(REUSE_BOOST_CAP, reuseRate * REUSE_BOOST_CAP);
    // Query-side temporal intent (t_58fc4720): proximity of the
    // candidate's EVENT time (declared validity start, else storage
    // mtime) to the window the query named, scaled into a capped
    // contribution. Undefined - not zero - when the query named no
    // window, so the layer stays absent from `reasons` and `breakdown`.
    let temporalBoost: number | undefined;
    if (temporalIntent !== null) {
      const eventMs = inputs.eventTimeMsByChunk?.get(c.chunkId) ?? c.mtime * 1000;
      const proximity = temporalProximity(eventMs, temporalIntent.range, DEFAULT_WINDOW_PAD_DAYS);
      temporalBoost = Math.min(TEMPORAL_INTENT_BOOST_CAP, proximity * TEMPORAL_INTENT_BOOST_CAP);
    }
    const sessionFocus = scoreSessionFocusTarget(hyd, opts.sessionFocus, nowMs);
    const score = clamp01(
      weighted * tierMul * trendMul +
        linkBoost +
        recency +
        entityBoost +
        activationBoost +
        coAccessBoost +
        reuseBoost +
        (temporalBoost ?? 0) +
        sessionFocus,
    );

    ranked.push(
      Object.freeze({
        documentId: c.documentId,
        chunkId: c.chunkId,
        path: hyd.path,
        title: hyd.title,
        content: hyd.content,
        startLine: hyd.startLine,
        endLine: hyd.endLine,
        score,
        keywordScore: c.keywordScore,
        semanticScore: c.semanticScore,
        linkBoost,
        recencyBoost: recency,
        // Conversation chronology (S1): expose the authoring instant only
        // when the note carries one, so a note with no turn instant keeps
        // the byte-identical result shape.
        ...(hyd.authoredAt != null ? { authoredAt: hyd.authoredAt } : {}),
        searchType: c.searchType,
        reasons: buildReasons({
          reuseBoost,
          keywordScore: c.keywordScore,
          semanticScore: semanticEnabled ? c.semanticScore : 0,
          linkBoost,
          recency,
          tierMul,
          entityBoost,
          activationBoost,
          coAccessBoost,
          ...(trend !== undefined ? { trend, trendMul } : {}),
          sessionFocus,
          rrf: rrfByChunk !== null ? rrf : 0,
          ...(temporalBoost !== undefined ? { temporalBoost, temporalDamping } : {}),
        }),
        breakdown: buildBreakdown({
          reuseBoost,
          keywordScore: c.keywordScore,
          semanticScore: semanticEnabled ? c.semanticScore : 0,
          linkBoost,
          recency,
          tierMul,
          entityBoost,
          activationBoost,
          coAccessBoost,
          trendMul,
          sessionFocus,
          rrf: rrfByChunk !== null ? rrf : 0,
          ...(temporalBoost !== undefined ? { temporalBoost } : {}),
        }),
      }),
    );
  }

  // Tie-break ladder, top to bottom: final_score desc, then (under an
  // active window only) temporal desc, then authoring instant desc, then
  // keywordScore desc, mtime desc, chunkId asc. The last four are design
  // §7 plus the conversation-chronology rung; the temporal rung sits
  // above all of them - see below for why that is one step higher than a
  // purely freshness-facing correction would place it.
  // Conversation chronology (S1): on an EXACT hybrid-score tie, order by
  // more recent authoring instant FIRST - but only when BOTH results carry
  // an `authored_at`. A pair where either side has none falls through to
  // the historical tie-break, so any non-tied pair (and every pair without
  // turn instants) keeps today's order byte-identically.
  // Query-side temporal intent (t_58fc4720): under an active window the
  // temporal layer separates the tie FIRST - above the whole ladder
  // below, `keywordScore` included, not only above the two freshness
  // rungs.
  //
  // Two reasons, and the second is why the rung sits one step higher than
  // a freshness-only correction would need:
  //
  //   - the authoring instant and `mtime` both order NEWER first, which
  //     is the very bias a declared historical window contradicts, and a
  //     saturating `clamp01` can hide a candidate's larger temporal
  //     contribution behind an exact score tie;
  //   - `keywordScore` is already a COMPONENT of `score`. On an exact
  //     tie it re-applies a signal the composite has already counted,
  //     which cannot separate what that composite could not. The window
  //     is an axis the query stated and the score may have saturated
  //     away, so it is the one that still carries information here.
  //
  // Equal contributions (including both zero) and an absent window fall
  // straight through to the historical ladder, byte-identically.
  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (temporalIntent !== null) {
      const aTemporal = a.breakdown?.temporal ?? 0;
      const bTemporal = b.breakdown?.temporal ?? 0;
      if (aTemporal !== bTemporal) return bTemporal - aTemporal;
    }
    const aAuthored = inputs.hydrated.get(a.chunkId)?.authoredAt ?? null;
    const bAuthored = inputs.hydrated.get(b.chunkId)?.authoredAt ?? null;
    if (aAuthored !== null && bAuthored !== null && aAuthored !== bAuthored) {
      return bAuthored - aAuthored;
    }
    if (b.keywordScore !== a.keywordScore) return b.keywordScore - a.keywordScore;
    const am = inputs.hydrated.get(a.chunkId)?.mtime ?? 0;
    const bm = inputs.hydrated.get(b.chunkId)?.mtime ?? 0;
    if (bm !== am) return bm - am;
    return a.chunkId - b.chunkId;
  });

  return ranked.slice(0, Math.max(1, opts.limit));
}
