/**
 * Reproducible recall benchmark (link-recall-intelligence,
 * t_e2215d49).
 *
 * A fixed query/expected-result dataset scored against the live
 * hybrid pipeline (`search()`): hit@k and MRR per query and in
 * aggregate. Three consumers share this runner:
 *
 *   - the CI regression gate (`tests/core/search/recall-benchmark
 *     .test.ts`) pins thresholds over the committed fixture vault, so
 *     a ranking regression fails the suite deterministically;
 *   - `o2b brain benchmark run` scores an operator vault on demand and
 *     records the run in `Brain/metrics/recall_benchmark.jsonl`;
 *   - `tuneRecall` (t_ae973491) uses the report as the objective
 *     function when grid-evaluating retrieval parameters.
 *
 * The runner itself is read-only and emits nothing - metric emission
 * belongs to the CLI/MCP callers, so library use stays side-effect
 * free.
 */

import { search } from "./search.ts";
import { SearchError } from "./types.ts";
import type { ResolvedSearchConfig } from "./types.ts";

/** Default rank depth for hit@k / reciprocal rank. */
export const BENCHMARK_DEFAULT_K = 5;

export interface RecallBenchmarkQuery {
  readonly id: string;
  readonly query: string;
  /** Vault-relative paths counted as a hit, any-of. */
  readonly expected: ReadonlyArray<string>;
  /** Per-query rank depth override. */
  readonly k?: number;
}

export interface RecallBenchmarkDataset {
  readonly queries: ReadonlyArray<RecallBenchmarkQuery>;
}

export interface RecallBenchmarkOptions {
  /** Rank depth, default {@link BENCHMARK_DEFAULT_K}. */
  readonly k?: number;
  /** Route every query through deterministic expansion (t_2fa95db1). */
  readonly expand?: boolean;
}

export interface RecallBenchmarkQueryResult {
  readonly id: string;
  readonly query: string;
  readonly hit: boolean;
  /** 1-based rank of the first expected path, null on a miss. */
  readonly rank: number | null;
  readonly reciprocalRank: number;
}

export interface RecallBenchmarkReport {
  readonly total: number;
  readonly k: number;
  readonly expand: boolean;
  /** Fraction of queries with an expected path in the top k. */
  readonly hitAtK: number;
  /** Mean reciprocal rank over all queries (misses contribute 0). */
  readonly mrr: number;
  readonly perQuery: ReadonlyArray<RecallBenchmarkQueryResult>;
}

/**
 * Validate a parsed dataset JSON value. Throws `SearchError`
 * (INVALID_INPUT) naming the first offending entry.
 */
export function parseRecallBenchmarkDataset(raw: unknown): RecallBenchmarkDataset {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SearchError("INVALID_INPUT", "benchmark dataset must be a JSON object");
  }
  const queries = (raw as { queries?: unknown }).queries;
  if (!Array.isArray(queries) || queries.length === 0) {
    throw new SearchError("INVALID_INPUT", "benchmark dataset needs a non-empty `queries` array");
  }
  const seen = new Set<string>();
  const parsed = queries.map((entry, i) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new SearchError("INVALID_INPUT", `benchmark query #${i} must be an object`);
    }
    const q = entry as { id?: unknown; query?: unknown; expected?: unknown; k?: unknown };
    if (typeof q.id !== "string" || q.id.trim().length === 0) {
      throw new SearchError("INVALID_INPUT", `benchmark query #${i} needs a non-empty string id`);
    }
    if (seen.has(q.id)) {
      throw new SearchError("INVALID_INPUT", `benchmark query id '${q.id}' is duplicated`);
    }
    seen.add(q.id);
    if (typeof q.query !== "string" || q.query.trim().length === 0) {
      throw new SearchError("INVALID_INPUT", `benchmark query '${q.id}' needs a query string`);
    }
    if (
      !Array.isArray(q.expected) ||
      q.expected.length === 0 ||
      q.expected.some((p) => typeof p !== "string" || p.length === 0)
    ) {
      throw new SearchError(
        "INVALID_INPUT",
        `benchmark query '${q.id}' needs a non-empty expected path array`,
      );
    }
    if (q.k !== undefined && (!Number.isInteger(q.k) || (q.k as number) < 1)) {
      throw new SearchError("INVALID_INPUT", `benchmark query '${q.id}' k must be a positive int`);
    }
    return Object.freeze({
      id: q.id,
      query: q.query,
      expected: Object.freeze([...(q.expected as string[])]) as ReadonlyArray<string>,
      ...(q.k !== undefined ? { k: q.k as number } : {}),
    });
  });
  return Object.freeze({ queries: Object.freeze(parsed) });
}

/**
 * Score the dataset against the vault behind `config`. Queries run
 * concurrently (read-only); the report order follows the dataset.
 */
export async function runRecallBenchmark(
  config: ResolvedSearchConfig,
  dataset: RecallBenchmarkDataset,
  opts: RecallBenchmarkOptions = {},
): Promise<RecallBenchmarkReport> {
  const k = Math.max(1, opts.k ?? BENCHMARK_DEFAULT_K);
  const expand = opts.expand === true;

  const perQuery = await Promise.all(
    dataset.queries.map(async (q): Promise<RecallBenchmarkQueryResult> => {
      const depth = Math.max(1, q.k ?? k);
      const outcome = await search(config, {
        query: q.query,
        limit: depth,
        ...(expand ? { expand: true } : {}),
      });
      const expected = new Set(q.expected);
      let rank: number | null = null;
      for (let i = 0; i < outcome.results.length && i < depth; i++) {
        if (expected.has(outcome.results[i]!.path)) {
          rank = i + 1;
          break;
        }
      }
      return Object.freeze({
        id: q.id,
        query: q.query,
        hit: rank !== null,
        rank,
        reciprocalRank: rank === null ? 0 : 1 / rank,
      });
    }),
  );

  const hits = perQuery.filter((r) => r.hit).length;
  const mrr = perQuery.reduce((sum, r) => sum + r.reciprocalRank, 0) / perQuery.length;
  return Object.freeze({
    total: perQuery.length,
    k,
    expand,
    hitAtK: hits / perQuery.length,
    mrr,
    perQuery: Object.freeze(perQuery),
  });
}
