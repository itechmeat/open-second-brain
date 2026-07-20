/**
 * Per-store reranker fit check diagnostic (R2, t_267f3b4c).
 *
 * A read-only diagnostic that answers one operator question: does the
 * configured reranker actually fit THIS vault's queries, or is it hurting
 * recall? Unlike the labelled reranker eval gate ({@link ./rerank-eval-gate.ts}),
 * which needs a ground-truth dataset, this check is unsupervised: it samples
 * REAL recorded queries from the cross-query demand log, runs the base
 * (pre-rerank) retrieval for each, then re-scores the same candidates with
 * the reranker and measures the Spearman rank correlation between the two
 * signals.
 *
 * A reranker that fits tracks the base relevance signal (positive
 * correlation) - it refines an ordering it broadly agrees with. Two failure
 * modes are worth an operator's attention:
 *   - INVERTED (negative correlation): the reranker systematically fights the
 *     base signal, so it is actively demoting the more relevant candidates.
 *   - OUT-OF-DOMAIN (near-zero correlation): the reranker's scores are noise
 *     relative to base relevance, a strong sign the model was trained on a
 *     different domain than this vault.
 *
 * The check stays quiet when the reranker fits, reports an explicit
 * INAPPLICABLE verdict for a rerankerless vault (or one with too little
 * recorded signal), and is strictly read-only: it disables the query cache
 * and self-heal on its probe searches and records no access, so no config
 * or store write happens on its path.
 */

import { search } from "./search.ts";
import { readQueryDemand } from "../brain/query-demand.ts";
import type { ResolvedSearchConfig } from "./types.ts";
import { resolveOpenAiCompatEndpoint } from "./embeddings/provider-resolve.ts";
import { makeRerankProvider } from "./rerank/provider.ts";
import type { RerankProvider } from "./rerank/contract.ts";

// ----- Tunables -------------------------------------------------------------

/** Spearman correlation at/above which the reranker is considered a fit. */
export const FIT_MIN_CORRELATION = 0.15;
/** Correlation at/below which the reranker is considered inverted (harmful). */
export const INVERTED_MAX_CORRELATION = -0.15;
/** Default cap on how many distinct recorded queries to sample. */
export const DEFAULT_FIT_MAX_QUERIES = 12;
/** Default candidate depth re-scored per sampled query. */
export const DEFAULT_FIT_TOP_K = 10;
/** A query needs at least this many candidates to yield a correlation. */
const MIN_CANDIDATES_PER_QUERY = 2;

// ----- Types ----------------------------------------------------------------

export type RerankFitVerdict = "fits" | "out_of_domain" | "inverted" | "inapplicable";

/** Base retrieval candidates for one sampled query. */
export interface RerankFitCandidateSet {
  readonly query: string;
  /** Candidate document texts, best-first by the base retrieval signal. */
  readonly documents: ReadonlyArray<string>;
  /** The base (pre-rerank) relevance score per document, aligned to order. */
  readonly baseScores: ReadonlyArray<number>;
}

export interface RerankFitReport {
  /** False for a rerankerless vault or one with too little recorded signal. */
  readonly applicable: boolean;
  readonly verdict: RerankFitVerdict;
  /** Mean per-query Spearman correlation, or null when inapplicable. */
  readonly correlation: number | null;
  /** Distinct queries that contributed a correlation. */
  readonly sampledQueries: number;
  /** Concrete operator action (disable / swap / none / fix config). */
  readonly recommendation: string;
  /** Human-readable explanation of the verdict. */
  readonly reason: string;
}

export interface RerankFitCheckDeps {
  /** Inject a reranker (tests / alternate backends). Defaults to the config's. */
  readonly provider?: RerankProvider;
  /** Environment map for env-key resolution; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Sampled queries; defaults to the distinct recorded demand-log queries. */
  readonly queries?: ReadonlyArray<string>;
  /** Fetch base candidates for a query; defaults to a read-only search. */
  readonly fetchCandidates?: (query: string) => Promise<RerankFitCandidateSet>;
  /** Cap on distinct queries sampled. Defaults to {@link DEFAULT_FIT_MAX_QUERIES}. */
  readonly maxQueries?: number;
  /** Candidate depth re-scored per query. Defaults to {@link DEFAULT_FIT_TOP_K}. */
  readonly topK?: number;
}

// ----- Correlation ----------------------------------------------------------

/** Fractional (tie-averaged) ranks of `values`, ascending. */
function ranks(values: ReadonlyArray<number>): number[] {
  const order = values.map((v, i) => ({ v, i })).toSorted((a, b) => a.v - b.v);
  const out = Array.from<number>({ length: values.length });
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]!.v === order[i]!.v) j++;
    // Average rank (1-based) for the tie group [i, j].
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[order[k]!.i] = avg;
    i = j + 1;
  }
  return out;
}

/**
 * Spearman rank correlation, or null when either input has no rank variance
 * (all-equal values), which carries no directional signal.
 */
export function spearman(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number | null {
  if (a.length !== b.length || a.length < MIN_CANDIDATES_PER_QUERY) return null;
  const ra = ranks(a);
  const rb = ranks(b);
  const n = ra.length;
  const meanA = ra.reduce((s, x) => s + x, 0) / n;
  const meanB = rb.reduce((s, x) => s + x, 0) / n;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i++) {
    const da = ra[i]! - meanA;
    const db = rb[i]! - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA === 0 || varB === 0) return null;
  return cov / Math.sqrt(varA * varB);
}

// ----- Sampling & probe search ----------------------------------------------

/** Distinct recorded queries from the demand log, most recent first. */
function sampleRecordedQueries(vault: string, max: number): string[] {
  const records = readQueryDemand(vault);
  const seen = new Set<string>();
  const out: string[] = [];
  // Most recent first: the demand log is ascending by ts.
  for (let i = records.length - 1; i >= 0 && out.length < max; i--) {
    const query = records[i]!.terms.join(" ").trim();
    if (query.length === 0 || seen.has(query)) continue;
    seen.add(query);
    out.push(query);
  }
  return out;
}

/**
 * A read-only base-retrieval config: the query cache and self-heal are off so
 * a probe search never writes a cache row or rebuilds the index, and the
 * cross-encoder is off so the returned scores are the BASE signal, not a
 * reranked one.
 */
function baseSearchConfig(config: ResolvedSearchConfig): ResolvedSearchConfig {
  return Object.freeze({
    ...config,
    recall: Object.freeze({ ...config.recall, cacheEnabled: false }),
    rerank: Object.freeze({ ...config.rerank, enabled: false }),
  });
}

async function defaultFetchCandidates(
  config: ResolvedSearchConfig,
  query: string,
  topK: number,
): Promise<RerankFitCandidateSet> {
  const outcome = await search(baseSearchConfig(config), {
    query,
    limit: topK,
    selfHeal: false,
  });
  return {
    query,
    documents: outcome.results.map((r) => r.content),
    baseScores: outcome.results.map((r) => r.score),
  };
}

// ----- Provider resolution --------------------------------------------------

/** Resolve the reranker to probe, or null when it cannot be constructed. */
function resolveProbeProvider(
  config: ResolvedSearchConfig,
  deps: RerankFitCheckDeps,
): RerankProvider | null {
  if (deps.provider) return deps.provider;
  if (config.rerank.kind === "local") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { LocalRerankProvider } =
      require("./rerank/local.ts") as typeof import("./rerank/local.ts");
    return new LocalRerankProvider();
  }
  try {
    const endpoint = resolveOpenAiCompatEndpoint(
      {
        enabled: true,
        baseUrl: config.rerank.baseUrl,
        model: config.rerank.model,
        envKey: config.rerank.envKey,
        apiKey: config.rerank.apiKey,
        env: deps.env,
      },
      "search_rerank",
    );
    if (endpoint === null) return null;
    return makeRerankProvider(endpoint);
  } catch {
    return null;
  }
}

// ----- Verdicts -------------------------------------------------------------

function inapplicable(reason: string): RerankFitReport {
  return Object.freeze({
    applicable: false,
    verdict: "inapplicable",
    correlation: null,
    sampledQueries: 0,
    recommendation: "no action; the reranker fit check does not apply to this vault",
    reason,
  });
}

function verdictFor(correlation: number, sampledQueries: number): RerankFitReport {
  if (correlation <= INVERTED_MAX_CORRELATION) {
    return Object.freeze({
      applicable: true,
      verdict: "inverted",
      correlation,
      sampledQueries,
      recommendation:
        "disable the reranker (search rerank enabled=false); its scores are " +
        "anti-correlated with base retrieval for this vault's queries",
      reason: `reranker scores are inverted versus base retrieval (Spearman ${correlation.toFixed(3)})`,
    });
  }
  if (correlation < FIT_MIN_CORRELATION) {
    return Object.freeze({
      applicable: true,
      verdict: "out_of_domain",
      correlation,
      sampledQueries,
      recommendation:
        "swap the reranker model or disable it; its scores are uncorrelated " +
        "with base retrieval (likely out-of-domain for this vault)",
      reason: `reranker scores are uncorrelated with base retrieval (Spearman ${correlation.toFixed(3)})`,
    });
  }
  return Object.freeze({
    applicable: true,
    verdict: "fits",
    correlation,
    sampledQueries,
    recommendation: "no action; the reranker tracks base retrieval on this vault",
    reason: `reranker scores track base retrieval (Spearman ${correlation.toFixed(3)})`,
  });
}

/**
 * The reranker-vs-base Spearman correlation for one sampled query, or null
 * when the query carried no rank signal (too few or all-tied candidates, or
 * a provider score-count mismatch).
 */
async function correlateQuery(
  query: string,
  fetchCandidates: (query: string) => Promise<RerankFitCandidateSet>,
  provider: RerankProvider,
): Promise<number | null> {
  const set = await fetchCandidates(query);
  if (set.documents.length < MIN_CANDIDATES_PER_QUERY) return null;
  const rerankScores = await provider.rerank(query, set.documents);
  if (rerankScores.length !== set.documents.length) return null;
  return spearman(set.baseScores, rerankScores);
}

// ----- Entry point ----------------------------------------------------------

/**
 * Run the reranker fit check. Read-only and deterministic given the sampled
 * queries and the reranker: it writes no config and no store rows.
 */
export async function rerankFitCheck(
  config: ResolvedSearchConfig,
  deps: RerankFitCheckDeps = {},
): Promise<RerankFitReport> {
  if (!config.rerank.enabled) {
    return inapplicable("reranker is disabled for this vault (search rerank enabled=false)");
  }
  const provider = resolveProbeProvider(config, deps);
  if (provider === null) {
    return inapplicable(
      "reranker is enabled but not configured (no reachable endpoint); nothing to fit-check",
    );
  }

  const maxQueries = Math.max(1, Math.floor(deps.maxQueries ?? DEFAULT_FIT_MAX_QUERIES));
  const topK = Math.max(MIN_CANDIDATES_PER_QUERY, Math.floor(deps.topK ?? DEFAULT_FIT_TOP_K));
  const queries = deps.queries ?? sampleRecordedQueries(config.vault, maxQueries);
  if (queries.length === 0) {
    return inapplicable("no recorded queries to sample; run some searches first");
  }

  const fetchCandidates =
    deps.fetchCandidates ?? ((query: string) => defaultFetchCandidates(config, query, topK));

  // One sampled query yields at most one correlation; the queries are
  // independent (each probe search opens and closes its own read-only store),
  // so they run concurrently and the per-query order does not matter - the
  // verdict is the mean over all queries that carried a rank signal. A single
  // flaky provider/probe rejection must NOT sink the whole diagnostic, so each
  // query is isolated: a rejection degrades to null (no signal), exactly like a
  // query that carried too few candidates. If every query fails or yields no
  // signal, the empty-correlations guard below reports inapplicable/
  // insufficient-signal - never a silent "fits".
  const perQuery = await Promise.all(
    queries
      .slice(0, maxQueries)
      .map((query) => correlateQuery(query, fetchCandidates, provider).catch(() => null)),
  );
  const correlations = perQuery.filter((c): c is number => c !== null);

  if (correlations.length === 0) {
    return inapplicable(
      "not enough candidate signal to correlate (queries returned too few or tied results)",
    );
  }
  const mean = correlations.reduce((s, x) => s + x, 0) / correlations.length;
  return verdictFor(mean, correlations.length);
}
