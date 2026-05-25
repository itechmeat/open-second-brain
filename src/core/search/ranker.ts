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

import {
  PAGE_TIER_DEFAULT,
  tierWeight,
  type PageTier,
} from "../brain/page-meta/tier.ts";
import type { KeywordHit, SemanticHit, HydratedChunk } from "./store.ts";
import type { BrainSearchResult } from "./types.ts";

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
}

export interface RankerOptions {
  readonly keywordWeight: number;
  readonly semanticWeight: number;
  readonly limit: number;
  /** Unix-ms reference time for recency. Defaults to Date.now(). */
  readonly nowMs?: number;
  /** When false, semantic_score is ignored regardless of inputs. */
  readonly semanticEnabled?: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

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

function recencyBoost(mtime: number, nowMs: number): number {
  const ageMs = Math.max(0, nowMs - mtime * 1000);
  const ageDays = ageMs / DAY_MS;
  if (ageDays <= 7) return 0.05;
  if (ageDays <= 30) return 0.025;
  if (ageDays <= 90) return 0.01;
  return 0;
}

interface Candidate {
  chunkId: number;
  documentId: number;
  keywordScore: number;
  semanticScore: number;
  searchType: "keyword" | "semantic" | "hybrid";
  mtime: number;
}

export function rankResults(inputs: RankerInputs, opts: RankerOptions): BrainSearchResult[] {
  const nowMs = opts.nowMs ?? Date.now();
  const semanticEnabled = opts.semanticEnabled !== false;

  const kwNorm = normalizeBm25(inputs.keyword);

  const semNorm = new Map<number, number>();
  if (semanticEnabled) {
    for (const h of inputs.semantic) {
      semNorm.set(h.chunkId, semanticFromDistance(h.distance));
    }
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
    return Math.min(0.03, raw);
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
    return Math.min(0.02, raw);
  }

  const ranked: BrainSearchResult[] = [];
  for (const c of candidateChunks) {
    const hyd = inputs.hydrated.get(c.chunkId);
    if (!hyd) continue;
    const link = linkBoostFor(c);
    const tag = tagBoostFor(c);
    const linkBoost = Math.min(0.05, link + tag);
    const recency = recencyBoost(c.mtime, nowMs);
    const weighted =
      opts.keywordWeight * c.keywordScore +
      (semanticEnabled ? opts.semanticWeight : 0) * c.semanticScore;
    // Tier multiplier applied to the relevance portion only so the
    // tag / link / recency boosts stay tier-neutral. Default
    // `supporting` → 1.0 keeps untagged vaults bit-identical.
    const tier = inputs.tierByDoc?.get(c.documentId) ?? PAGE_TIER_DEFAULT;
    const tierMul = tierWeight(tier);
    const score = clamp01(weighted * tierMul + linkBoost + recency);

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
        searchType: c.searchType,
      }),
    );
  }

  // Tie-break per design §7: final_score desc, keywordScore desc, mtime desc, chunkId asc.
  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.keywordScore !== a.keywordScore) return b.keywordScore - a.keywordScore;
    const am = inputs.hydrated.get(a.chunkId)?.mtime ?? 0;
    const bm = inputs.hydrated.get(b.chunkId)?.mtime ?? 0;
    if (bm !== am) return bm - am;
    return a.chunkId - b.chunkId;
  });

  return ranked.slice(0, Math.max(1, opts.limit));
}
