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
  /**
   * Optional expected answer text. When present, the query also scores
   * answer-containment@k: whether this substring appears (folded) in the
   * retrieved content within the top k. Absent leaves the query measuring
   * hit@k / MRR only, so existing datasets stay valid.
   */
  readonly answer?: string;
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
  /**
   * Whether the declared answer appeared (folded) in the retrieved
   * content within the top k. `null` when the query declares no answer.
   */
  readonly answerContained: boolean | null;
  /** Expected paths that surfaced in the top k for this query. */
  readonly expectedFound: number;
  /** Total expected paths declared for this query. */
  readonly expectedTotal: number;
}

export interface RecallBenchmarkReport {
  readonly total: number;
  readonly k: number;
  readonly expand: boolean;
  /** Fraction of queries with an expected path in the top k. */
  readonly hitAtK: number;
  /** Mean reciprocal rank over all queries (misses contribute 0). */
  readonly mrr: number;
  /**
   * Number of queries that declared an answer (the answer-containment
   * denominator). 0 when the dataset uses no answers.
   */
  readonly answerQueries: number;
  /**
   * Fraction of answer-bearing queries whose answer appeared in the
   * top-k content. Vacuously 1 when no query declares an answer, so a CI
   * floor never fails a dataset that does not use the metric.
   */
  readonly answerContainmentAtK: number;
  /**
   * Source utilization: fraction of all declared expected paths (summed
   * across queries) that surfaced in their query's top k. Measures source
   * coverage rather than per-query hit; equals hitAtK when every query
   * declares exactly one expected path.
   */
  readonly sourceUtilizationAtK: number;
  /**
   * Citation depth: mean 1-based rank of the first expected hit over the
   * queries that hit (lower is better). 0 when no query hit.
   */
  readonly citationDepth: number;
  /**
   * Source warnings: queries where NO expected path surfaced in the top
   * k - an expected source the retrieval failed to use. The CI gate caps
   * this with `source_warnings_max`.
   */
  readonly sourceWarnings: number;
  readonly perQuery: ReadonlyArray<RecallBenchmarkQueryResult>;
}

/** Folded substring containment, language-agnostic (no word lists). */
function answerContainedIn(answer: string, contents: ReadonlyArray<string>): boolean {
  const needle = answer.replace(/\s+/gu, " ").trim().toLowerCase();
  if (needle.length === 0) return false;
  return contents.some((c) => c.replace(/\s+/gu, " ").toLowerCase().includes(needle));
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
    const q = entry as {
      id?: unknown;
      query?: unknown;
      expected?: unknown;
      k?: unknown;
      answer?: unknown;
    };
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
    if (q.answer !== undefined && (typeof q.answer !== "string" || q.answer.trim().length === 0)) {
      throw new SearchError(
        "INVALID_INPUT",
        `benchmark query '${q.id}' answer must be a non-empty string when present`,
      );
    }
    return Object.freeze({
      id: q.id,
      query: q.query,
      expected: Object.freeze([...(q.expected as string[])]) as ReadonlyArray<string>,
      ...(q.k !== undefined ? { k: q.k as number } : {}),
      ...(q.answer !== undefined ? { answer: q.answer as string } : {}),
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
  if (dataset.queries.length === 0) {
    throw new SearchError("INVALID_INPUT", "benchmark dataset needs a non-empty `queries` array");
  }
  if (opts.k !== undefined && (!Number.isInteger(opts.k) || opts.k < 1)) {
    throw new SearchError("INVALID_INPUT", "benchmark k must be a positive integer");
  }
  const k = opts.k ?? BENCHMARK_DEFAULT_K;
  const expand = opts.expand === true;

  const perQuery = await Promise.all(
    dataset.queries.map(async (q): Promise<RecallBenchmarkQueryResult> => {
      const depth = q.k ?? k;
      const outcome = await search(config, {
        query: q.query,
        limit: depth,
        ...(expand ? { expand: true } : {}),
      });
      const expected = new Set(q.expected);
      const topK = outcome.results.slice(0, depth);
      const topKPaths = new Set(topK.map((r) => r.path));
      const expectedFound = [...expected].filter((p) => topKPaths.has(p)).length;
      let rank: number | null = null;
      for (let i = 0; i < topK.length; i++) {
        if (expected.has(topK[i]!.path)) {
          rank = i + 1;
          break;
        }
      }
      const answerContained =
        q.answer === undefined
          ? null
          : answerContainedIn(
              q.answer,
              topK.map((r) => r.content),
            );
      return Object.freeze({
        id: q.id,
        query: q.query,
        hit: rank !== null,
        rank,
        reciprocalRank: rank === null ? 0 : 1 / rank,
        answerContained,
        expectedFound,
        expectedTotal: expected.size,
      });
    }),
  );

  const hits = perQuery.filter((r) => r.hit).length;
  const mrr = perQuery.reduce((sum, r) => sum + r.reciprocalRank, 0) / perQuery.length;
  const answerScored = perQuery.filter((r) => r.answerContained !== null);
  const answerHits = answerScored.filter((r) => r.answerContained === true).length;
  const expectedFoundTotal = perQuery.reduce((sum, r) => sum + r.expectedFound, 0);
  const expectedDeclaredTotal = perQuery.reduce((sum, r) => sum + r.expectedTotal, 0);
  const hitRanks = perQuery.filter((r) => r.rank !== null).map((r) => r.rank!);
  return Object.freeze({
    total: perQuery.length,
    k,
    expand,
    hitAtK: hits / perQuery.length,
    mrr,
    answerQueries: answerScored.length,
    answerContainmentAtK: answerScored.length === 0 ? 1 : answerHits / answerScored.length,
    sourceUtilizationAtK:
      expectedDeclaredTotal === 0 ? 1 : expectedFoundTotal / expectedDeclaredTotal,
    citationDepth:
      hitRanks.length === 0 ? 0 : hitRanks.reduce((sum, r) => sum + r, 0) / hitRanks.length,
    sourceWarnings: perQuery.length - hits,
    perQuery: Object.freeze(perQuery),
  });
}
