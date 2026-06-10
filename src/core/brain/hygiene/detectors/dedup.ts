/**
 * Dedup detector (continuity-hygiene-freshness suite; kanban
 * t_da3f138f).
 *
 * Near-duplicate memories surface as merge findings. Two layers:
 *
 *   - Embedding similarity when vectors are available in the search
 *     index (cosine over stored chunk embeddings, threshold default
 *     0.97) - see `embeddingDuplicatePairs`.
 *   - Deterministic lexical fallback otherwise: the shared
 *     `findMergeCandidates` jaccard detector over preference
 *     principles, clearly labeled `method: "lexical"` so a report
 *     never passes lexical similarity off as semantic.
 *
 * The detector only nominates pairs; merging happens through the
 * hygiene apply plan (which routes to the existing merge machinery).
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { resolveSearchConfig } from "../../../search/index.ts";
import { makeProvider, type EmbeddingProvider } from "../../../search/embeddings/provider.ts";
import { findMergeCandidates } from "../../merge-candidates.ts";
import { brainDirs } from "../../paths.ts";
import { parsePreference } from "../../preference.ts";
import { hygieneFindingId } from "./id.ts";
import type { HygieneDetectorContext, HygieneFinding } from "../types.ts";

/** Cosine-similarity threshold for the embedding layer (upstream default). */
export const DEDUP_EMBEDDING_THRESHOLD = 0.97;
/** Jaccard threshold for the lexical fallback - above merge-suggest level. */
export const DEDUP_LEXICAL_THRESHOLD = 0.8;

export interface DedupDetectorOptions {
  readonly lexicalThreshold?: number;
}

/** Bound on how many preferences enter pairwise comparison. */
const DEDUP_CANDIDATE_CAP = 200;

export type DedupMethod = "embedding" | "lexical";

export interface SemanticDedupOptions {
  /**
   * Embedding provider override. `undefined` resolves the vault's
   * configured provider; `null` (or an unusable provider) falls back
   * to the lexical layer.
   */
  readonly provider?: EmbeddingProvider | null;
  readonly threshold?: number;
  readonly lexicalThreshold?: number;
}

export interface SemanticDedupResult {
  readonly method: DedupMethod;
  readonly findings: ReadonlyArray<HygieneFinding>;
}

interface PrefCandidate {
  readonly id: string;
  readonly topic: string;
  readonly scope: string | null;
  readonly principle: string;
}

function listPreferenceCandidates(vault: string): PrefCandidate[] {
  const dir = brainDirs(vault).preferences;
  if (!existsSync(dir)) return [];
  const out: PrefCandidate[] = [];
  for (const name of readdirSync(dir).toSorted()) {
    if (!name.endsWith(".md")) continue;
    try {
      const pref = parsePreference(join(dir, name));
      out.push({
        id: pref.id,
        topic: pref.topic,
        scope: pref.scope ?? null,
        principle: pref.principle,
      });
    } catch {
      continue;
    }
    if (out.length >= DEDUP_CANDIDATE_CAP) break;
  }
  return out;
}

function cosine(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function resolveConfiguredProvider(vault: string): EmbeddingProvider | null {
  try {
    const provider = makeProvider(resolveSearchConfig({ vault }).semantic);
    return provider.name === "null" ? null : provider;
  } catch {
    return null;
  }
}

/**
 * Semantic dedup layer: embed every preference principle (bounded) and
 * nominate pairs whose cosine similarity reaches the threshold -
 * across topic buckets, which is exactly where the lexical layer is
 * blind. Any provider problem falls back to the deterministic lexical
 * layer, labeled as such.
 */
export async function detectSemanticDedup(
  vault: string,
  opts: SemanticDedupOptions = {},
): Promise<SemanticDedupResult> {
  const provider = opts.provider === undefined ? resolveConfiguredProvider(vault) : opts.provider;
  const lexical = (): SemanticDedupResult =>
    Object.freeze({
      method: "lexical" as const,
      findings: detectDedup(
        vault,
        { now: new Date(0) },
        opts.lexicalThreshold !== undefined ? { lexicalThreshold: opts.lexicalThreshold } : {},
      ),
    });
  if (provider === null || provider.name === "null") return lexical();

  const candidates = listPreferenceCandidates(vault);
  if (candidates.length < 2) return lexical();
  const threshold = opts.threshold ?? DEDUP_EMBEDDING_THRESHOLD;

  let vectors: number[][];
  try {
    vectors = await provider.embed(candidates.map((candidate) => candidate.principle));
  } catch {
    return lexical();
  }
  if (vectors.length !== candidates.length) return lexical();

  const findings: HygieneFinding[] = [];
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const similarity = cosine(vectors[i]!, vectors[j]!);
      if (similarity < threshold) continue;
      const a = candidates[i]!;
      const b = candidates[j]!;
      findings.push(
        Object.freeze({
          id: hygieneFindingId("dedup", [a.id, b.id]),
          detector: "dedup" as const,
          severity: "warning" as const,
          title: `Near-duplicate preferences ${a.id} and ${b.id} (cosine ${similarity.toFixed(3)})`,
          targets: Object.freeze([a.id, b.id].toSorted()),
          proposed_action: "merge" as const,
          evidence: Object.freeze({
            method: "embedding",
            model: provider.model,
            cosine: Number(similarity.toFixed(4)),
            principle_a: a.principle,
            principle_b: b.principle,
          }),
        }),
      );
    }
  }
  return Object.freeze({ method: "embedding" as const, findings: Object.freeze(findings) });
}

export function detectDedup(
  vault: string,
  _ctx: HygieneDetectorContext,
  opts: DedupDetectorOptions = {},
): ReadonlyArray<HygieneFinding> {
  const threshold = opts.lexicalThreshold ?? DEDUP_LEXICAL_THRESHOLD;
  const candidates = findMergeCandidates(vault, { threshold, limit: 50 });
  return Object.freeze(
    candidates.map((pair) =>
      Object.freeze({
        id: hygieneFindingId("dedup", [pair.a, pair.b]),
        detector: "dedup" as const,
        severity: "warning" as const,
        title: `Near-duplicate preferences ${pair.a} and ${pair.b} (jaccard ${pair.jaccard})`,
        targets: Object.freeze([pair.a, pair.b]),
        proposed_action: "merge" as const,
        evidence: Object.freeze({
          method: "lexical",
          jaccard: pair.jaccard,
          topic: pair.topic,
          scope: pair.scope,
          principle_a: pair.principle_a,
          principle_b: pair.principle_b,
        }),
      }),
    ),
  );
}
