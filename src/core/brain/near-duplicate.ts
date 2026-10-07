/**
 * Reach-aware near-duplicate kernel: one pure lookup shared by every
 * point a fact enters or leaves the vault (write-receipt hint, feedback
 * advisory, retire siblings).
 *
 * The caller projects its probe and pool into token sets with
 * `tokenise` (see `similarity.ts`); the kernel never reads the vault,
 * never sees a vector and never calls a model. The `readable`
 * predicate is required and runs before anything else, so a withheld
 * entry is neither scored nor counted: no match and no census number
 * can disclose it. Operator-reach callers pass {@link READ_ALL_REFS}
 * explicitly, so every unfiltered call site stays visible in the diff.
 */

import { jaccard } from "./similarity.ts";

export type NearDuplicateMethod = "lexical" | "embedding";
export type ReadableRef = (ref: string) => boolean;

/** Explicit operator-reach predicate; every unfiltered call site names it. */
export const READ_ALL_REFS: ReadableRef = () => true;

/**
 * The one named threshold table. `writeHint` is the shipped page-lint
 * bar, `retireSiblingLexical` the doctor lint bar and
 * `retireSiblingEmbedding` the entity semantic-dedup bar.
 */
export const NEAR_DUPLICATE_THRESHOLDS = Object.freeze({
  writeHint: 0.8,
  retireSiblingLexical: 0.7,
  retireSiblingEmbedding: 0.92,
} as const);

/** Short texts share most of their tokens by accident; below this nothing is scored. */
export const NEAR_DUPLICATE_MIN_TOKENS = 4;
/** Upper bound on the entries one lookup scores. */
export const NEAR_DUPLICATE_CANDIDATE_CAP = 200;
/** Upper bound on keyword-index chunks a write-side widening pulls. */
export const NEAR_DUPLICATE_WIDENING_TOP_K = 20;

export interface NearDuplicateProbe {
  /** Vault-relative path or preference id. */
  readonly ref: string;
  /** From `similarity.ts` `tokenise`. */
  readonly tokens: ReadonlySet<string>;
}

export interface NearDuplicatePoolEntry {
  readonly ref: string;
  readonly tokens: ReadonlySet<string>;
  /** Optional bucket; when the options carry `bucket`, entries must match it. */
  readonly bucket?: string;
}

export interface NearDuplicateOptions {
  readonly threshold: number;
  /** Required; applied before scoring and counting. */
  readonly readable: ReadableRef;
  /** Default {@link NEAR_DUPLICATE_MIN_TOKENS}. */
  readonly minTokens?: number;
  /** Default {@link NEAR_DUPLICATE_CANDIDATE_CAP}. */
  readonly cap?: number;
  readonly bucket?: string;
}

export interface NearDuplicateMatch {
  readonly ref: string;
  /** Rounded to 3 decimals. */
  readonly score: number;
  readonly method: NearDuplicateMethod;
}

export interface NearDuplicateScan {
  /** Readable entries actually scored. */
  readonly compared: number;
  /** Readable entries left out by the cap. */
  readonly capped: number;
  /** Readable entries skipped as too short. */
  readonly below_min_tokens: number;
}

export interface NearDuplicateResult {
  /** Sorted by score descending, then ref. */
  readonly matches: ReadonlyArray<NearDuplicateMatch>;
  readonly scan: NearDuplicateScan;
}

/**
 * Score `probe` against `pool` by token Jaccard. Entries are filtered in
 * this order: reach, the probe's own ref, the bucket, the minimum token
 * count, then the cap (in pool order). A probe under the minimum token
 * count scores nothing. Matches at or above `threshold` are returned.
 */
export function findNearDuplicates(
  probe: NearDuplicateProbe,
  pool: ReadonlyArray<NearDuplicatePoolEntry>,
  opts: NearDuplicateOptions,
): NearDuplicateResult {
  const minTokens = opts.minTokens ?? NEAR_DUPLICATE_MIN_TOKENS;
  const cap = opts.cap ?? NEAR_DUPLICATE_CANDIDATE_CAP;
  if (probe.tokens.size < minTokens) {
    return { matches: [], scan: { compared: 0, capped: 0, below_min_tokens: 0 } };
  }
  const matches: NearDuplicateMatch[] = [];
  let compared = 0;
  let capped = 0;
  let belowMinTokens = 0;
  for (const entry of pool) {
    if (!opts.readable(entry.ref)) continue;
    if (entry.ref === probe.ref) continue;
    if (opts.bucket !== undefined && entry.bucket !== opts.bucket) continue;
    if (entry.tokens.size < minTokens) {
      belowMinTokens++;
      continue;
    }
    if (compared >= cap) {
      capped++;
      continue;
    }
    compared++;
    const sim = jaccard(probe.tokens, entry.tokens);
    if (sim < opts.threshold) continue;
    matches.push({ ref: entry.ref, score: roundScore(sim), method: "lexical" });
  }
  matches.sort(compareMatches);
  return { matches, scan: { compared, capped, below_min_tokens: belowMinTokens } };
}

/** Round a similarity score to 3 decimals, the precision every surface reports. */
export function roundScore(score: number): number {
  return Math.round(score * 1000) / 1000;
}

/** Score descending, then ref by code unit, so the order never depends on locale. */
export function compareMatches(
  a: { readonly ref: string; readonly score: number },
  b: { readonly ref: string; readonly score: number },
): number {
  if (a.score !== b.score) return b.score - a.score;
  return a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0;
}
