/**
 * Relation-aware recall polarity (recall-trust-suite, Feature A).
 *
 * Typed relation edges (src/core/graph/relation-vocab.ts) participate in
 * ranking with explicit polarity instead of being decorative metadata:
 *
 * - `superseded_by` marks the declaring page as a stale predecessor. When
 *   the predecessor matches a query, its score is demoted and the successor
 *   is boosted — pulled into the pool when it was not already retrieved —
 *   so a stale memory cannot outrank the memory that replaced it.
 * - `contradicts` is relevant-but-not-endorsing: both endpoints gain a
 *   warning-style `why_retrieved` reason and neither score moves.
 * - `related` / `extends` / `depends_on` / `refines` grant a small bounded
 *   directional boost to a co-retrieved target — always weaker than a
 *   direct text match.
 *
 * The pass is pure (no I/O): callers (search.ts) fetch the candidate
 * documents' typed edges and a successor-chunk lookup, then hand both in.
 * A pool with zero typed edges passes through bit-identically, so vaults
 * without typed relations are unaffected.
 */

import type { BrainSearchResult } from "./types.ts";

/** Multiplier applied to a matched predecessor's score. */
export const SUPERSEDED_DEMOTION = 0.6;
/** The successor inherits this share of the predecessor's original score. */
export const SUCCESSOR_CARRY = 0.9;
/** Additive boost per positive relation edge between co-retrieved candidates. */
export const RELATION_BOOST_PER_EDGE = 0.02;
/** Cap on the total positive relation boost one result can accumulate. */
export const RELATION_BOOST_CAP = 0.04;

const POSITIVE_RELATIONS = new Set(["related", "extends", "depends_on", "refines"]);

/** One typed relation edge declared by a candidate document. */
export interface RelationEdge {
  readonly sourceDocumentId: number;
  readonly relation: string;
  /** Relation target as written in frontmatter (normalised wikilink id). */
  readonly target: string;
  /** Resolved target document id, or null when the target page is unknown. */
  readonly targetDocumentId: number | null;
}

/** Representative document head used when pulling in an absent successor. */
export interface SuccessorDoc {
  readonly documentId: number;
  readonly chunkId: number;
  readonly path: string;
  readonly title: string | null;
  readonly content: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface RelationPolarityInputs {
  readonly ranked: ReadonlyArray<BrainSearchResult>;
  /** Typed edges declared by the ranked candidates' documents. */
  readonly edges: ReadonlyArray<RelationEdge>;
  /** Lookup for a successor document absent from the pool; null = unknown. */
  readonly successorDoc: (documentId: number) => SuccessorDoc | null;
}

export interface RelationPolarityOptions {
  /**
   * History mode: keep matched predecessors undemoted and skip successor
   * pull-in. Informational reasons still land so callers can see the edge.
   */
  readonly includeSuperseded?: boolean;
}

interface Mutable {
  result: BrainSearchResult;
  score: number;
  reasons: string[];
  positiveBoost: number;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function fmt(x: number): string {
  return x.toFixed(3);
}

/**
 * Apply relation polarity over the assembled candidate pool. Returns a new
 * re-sorted array; the inputs are never mutated. With zero edges the pool
 * is returned as-is (same array contents, same order).
 */
export function applyRelationPolarity(
  inputs: RelationPolarityInputs,
  opts: RelationPolarityOptions,
): BrainSearchResult[] {
  if (inputs.edges.length === 0) return [...inputs.ranked];
  const includeSuperseded = opts.includeSuperseded === true;

  const byDoc = new Map<number, Mutable[]>();
  const pool: Mutable[] = inputs.ranked.map((result) => {
    const m: Mutable = {
      result,
      score: result.score,
      reasons: [...result.reasons],
      positiveBoost: 0,
    };
    const list = byDoc.get(result.documentId);
    if (list) list.push(m);
    else byDoc.set(result.documentId, [m]);
    return m;
  });

  const pulledIn = new Map<number, Mutable>();

  const successorEntries = (edge: RelationEdge): Mutable[] => {
    if (edge.targetDocumentId === null) return [];
    const present = byDoc.get(edge.targetDocumentId);
    if (present) return present;
    const already = pulledIn.get(edge.targetDocumentId);
    if (already) return [already];
    const doc = inputs.successorDoc(edge.targetDocumentId);
    if (!doc) return [];
    const m: Mutable = {
      result: Object.freeze({
        documentId: doc.documentId,
        chunkId: doc.chunkId,
        path: doc.path,
        title: doc.title,
        content: doc.content,
        startLine: doc.startLine,
        endLine: doc.endLine,
        score: 0,
        keywordScore: 0,
        semanticScore: 0,
        linkBoost: 0,
        recencyBoost: 0,
        searchType: "link" as const,
        reasons: Object.freeze([] as string[]),
      }),
      score: 0,
      reasons: [],
      positiveBoost: 0,
    };
    pulledIn.set(doc.documentId, m);
    return [m];
  };

  // Edges apply in stable `ORDER BY l.id` order (insertion order from
  // the indexer). For a node that is both a demoted predecessor and a
  // positive-relation target the effects compose deterministically:
  // demotion multiplies the ORIGINAL score exactly once (it reads
  // src.result.score, not the mutated value), and positive boosts are
  // additive and capped, so relative edge order cannot change the
  // final score.
  for (const edge of inputs.edges) {
    if (edge.targetDocumentId !== null && edge.targetDocumentId === edge.sourceDocumentId) {
      continue; // self-edge: inert
    }
    const sources = byDoc.get(edge.sourceDocumentId) ?? [];
    if (sources.length === 0) continue;

    if (edge.relation === "superseded_by") {
      for (const src of sources) {
        pushUnique(src.reasons, `superseded_by: ${edge.target}`);
      }
      if (includeSuperseded || edge.targetDocumentId === null) continue;
      const successors = successorEntries(edge);
      if (successors.length === 0) continue; // unresolved successor: inert
      for (const src of sources) {
        const original = src.result.score;
        src.score = clamp01(original * SUPERSEDED_DEMOTION);
        const carried = clamp01(original * SUCCESSOR_CARRY);
        for (const succ of successors) {
          if (carried > succ.score) succ.score = carried;
          pushUnique(succ.reasons, `supersedes_matched: ${src.result.path}`);
        }
      }
      continue;
    }

    if (edge.relation === "contradicts") {
      for (const src of sources) {
        pushUnique(src.reasons, `contradicts: ${edge.target}`);
      }
      if (edge.targetDocumentId === null) continue;
      const targets = byDoc.get(edge.targetDocumentId) ?? [];
      for (const tgt of targets) {
        for (const src of sources) {
          pushUnique(tgt.reasons, `contradicted_by: ${src.result.path}`);
        }
      }
      continue;
    }

    if (POSITIVE_RELATIONS.has(edge.relation)) {
      if (edge.targetDocumentId === null) continue;
      const targets = byDoc.get(edge.targetDocumentId) ?? [];
      for (const tgt of targets) {
        const head = Math.min(RELATION_BOOST_PER_EDGE, RELATION_BOOST_CAP - tgt.positiveBoost);
        if (head <= 0) continue;
        tgt.positiveBoost += head;
        tgt.score = clamp01(tgt.score + head);
        for (const src of sources) {
          pushUnique(tgt.reasons, `relation_boost: ${edge.relation} ${src.result.path}`);
          break; // one reason per edge, not per source chunk
        }
      }
    }
    // Unknown relation tokens (open vocabulary) carry no polarity: inert.
  }

  const out = [...pool, ...pulledIn.values()].map((m) => {
    if (
      m.score === m.result.score &&
      m.reasons.length === m.result.reasons.length &&
      m.positiveBoost === 0
    ) {
      return m.result;
    }
    const extras: string[] = [];
    if (m.positiveBoost > 0) extras.push(`relation_polarity: +${fmt(m.positiveBoost)}`);
    return Object.freeze({
      ...m.result,
      score: m.score,
      reasons: Object.freeze([...m.reasons, ...extras]),
    });
  });

  // Same tie-break family as the ranker: score desc, keywordScore desc,
  // chunkId asc — deterministic for equal scores.
  out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.keywordScore !== a.keywordScore) return b.keywordScore - a.keywordScore;
    return a.chunkId - b.chunkId;
  });
  return out;
}

function pushUnique(list: string[], entry: string): void {
  if (!list.includes(entry)) list.push(entry);
}
