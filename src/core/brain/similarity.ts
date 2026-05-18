/**
 * Shared similarity helpers — `tokenise`, `jaccard`, and the
 * bucket-and-pair walk used by both the `duplicate-preferences`
 * doctor lint and the `merge-candidates` digest detector.
 *
 * No language-specific stopword list: Brain principles are routinely
 * multilingual and an English-only list would either under-filter on
 * non-English text or skew the score against valid pairs.
 */

const TOKEN_STOPWORDS: ReadonlySet<string> = new Set();

export function tokenise(text: string): ReadonlySet<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}_-]+/u)
      .filter((t) => t.length > 1 && !TOKEN_STOPWORDS.has(t)),
  );
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
}

/**
 * Entry shape consumed by {@link findSimilarPairs}. Callers project
 * their domain object (preference, retired, signal) into this shape
 * before invoking the walker.
 */
export interface SimilarityEntry<T> {
  readonly id: string;
  readonly bucketKey: string;
  readonly tokens: ReadonlySet<string>;
  readonly source: T;
}

export interface SimilarPair<T> {
  readonly a: SimilarityEntry<T>;
  readonly b: SimilarityEntry<T>;
  readonly jaccard: number;
}

export interface FindSimilarPairsOptions {
  readonly threshold: number;
}

/**
 * Group `entries` by `bucketKey`, then return every intra-bucket
 * pair whose jaccard similarity is at or above `threshold`. Pairs
 * are emitted with `a.id < b.id`. Buckets of size 1 are skipped.
 * No upper limit on output — callers truncate when needed.
 */
export function findSimilarPairs<T>(
  entries: ReadonlyArray<SimilarityEntry<T>>,
  opts: FindSimilarPairsOptions,
): SimilarPair<T>[] {
  const out: SimilarPair<T>[] = [];
  const buckets = new Map<string, SimilarityEntry<T>[]>();
  for (const e of entries) {
    const bucket = buckets.get(e.bucketKey) ?? [];
    bucket.push(e);
    buckets.set(e.bucketKey, bucket);
  }
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    bucket.sort((x, y) => x.id.localeCompare(y.id));
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i]!;
        const b = bucket[j]!;
        const sim = jaccard(a.tokens, b.tokens);
        if (sim < opts.threshold) continue;
        out.push({ a, b, jaccard: sim });
      }
    }
  }
  return out;
}
