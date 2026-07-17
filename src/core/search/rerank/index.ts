/**
 * Cross-encoder rerank stage - the final reader step
 * (retrieval-precision-quality-loop, card A / t_110867f5).
 *
 * {@link applyCrossEncoderRerank} re-scores the top-K fused candidates
 * jointly against the query using a learned cross-encoder, then re-orders
 * that block by the returned relevance scores. It is appended AFTER the
 * heuristic reranks (relevance rerank, entity boost, MMR, usage decay) in
 * the reader tail, so it is the last word on ordering.
 *
 * Three invariants, mirroring the embedding-provider discipline:
 *   1. Disabled (the default) -> the input is returned unchanged, with no
 *      HTTP call, no allocation of a new array, and no telemetry. The
 *      reader tail is byte-identical to the pre-feature baseline.
 *   2. Enabled but unconfigured -> fail closed. Endpoint resolution
 *      (`resolveOpenAiCompatEndpoint`) throws a typed `SearchError`, the
 *      same discipline `openai-compat.ts` applies when semantic is
 *      enabled without a base_url/model/key. This is a configuration
 *      error the operator must fix, not a hot-path degrade.
 *   3. Enabled and configured but the endpoint errors at request time ->
 *      degrade gracefully to the heuristic-ordered input (never throw
 *      into the hot path) and emit one fail-open telemetry event.
 */

import { resolveOpenAiCompatEndpoint } from "../embeddings/provider-resolve.ts";
import type { BrainSearchResult, ResolvedRerankConfig } from "../types.ts";
import { makeRerankProvider } from "./provider.ts";
import type { RerankProvider } from "./contract.ts";

/** Fixed-precision so the reason string is stable for a given score. */
function fmtScore(x: number): string {
  return x.toFixed(4);
}

export interface RerankTelemetryEvent {
  readonly status: "applied" | "error";
  /** Present on `error`: the provider-shaped failure message. */
  readonly reason?: string;
  /** Number of top candidates handed to the cross-encoder. */
  readonly candidateCount: number;
}

export interface ApplyCrossEncoderRerankOptions {
  /** Inject a provider (tests / alternate backends). Defaults to the HTTP one. */
  readonly provider?: RerankProvider;
  /** Environment map for env-key resolution; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Per-request timeout override for the default provider. */
  readonly timeoutMs?: number;
  /**
   * Fail-open telemetry sink. Invoked at most once per call - on success
   * (`applied`) or on a request-time degrade (`error`). Never invoked on
   * the disabled path. The caller wraps this so a throwing sink can never
   * fail the search.
   */
  readonly onTelemetry?: (event: RerankTelemetryEvent) => void;
}

interface Scored {
  readonly result: BrainSearchResult;
  readonly index: number;
  readonly score: number;
}

/**
 * Re-order the top-K block by cross-encoder score, honouring the
 * `minScore` floor. Deterministic given the scores: qualifying candidates
 * (score >= floor) sort by score descending, ties broken by original
 * index; below-floor candidates keep their original relative order and
 * sit below the qualifying ones. Each reranked hit gains a
 * `cross_encoder:` reason so explainability shows the stage fired.
 */
function reorderTopK(
  head: ReadonlyArray<BrainSearchResult>,
  scores: ReadonlyArray<number>,
  minScore: number,
): BrainSearchResult[] {
  const scored: Scored[] = head.map((result, index) => ({
    result,
    index,
    score: scores[index] ?? Number.NEGATIVE_INFINITY,
  }));
  const qualifying = scored.filter((s) => s.score >= minScore);
  const belowFloor = scored.filter((s) => s.score < minScore);
  qualifying.sort((a, b) => b.score - a.score || a.index - b.index);
  return [...qualifying, ...belowFloor].map((s) =>
    Object.freeze({
      ...s.result,
      reasons: Object.freeze([...s.result.reasons, `cross_encoder: ${fmtScore(s.score)}`]),
    }),
  );
}

/**
 * Apply the optional cross-encoder rerank stage. Returns the input
 * unchanged when disabled or on a request-time endpoint error; throws a
 * typed `SearchError` when enabled but the endpoint is unconfigured.
 */
export async function applyCrossEncoderRerank(
  results: ReadonlyArray<BrainSearchResult>,
  query: string,
  config: ResolvedRerankConfig,
  opts: ApplyCrossEncoderRerankOptions = {},
): Promise<ReadonlyArray<BrainSearchResult>> {
  // Invariant 1: disabled -> zero-cost no-op, byte-identical input.
  if (!config.enabled) return results;

  // Resolve the provider. The bundled offline reranker ("local") needs no
  // endpoint - it is deterministic and network-free. The remote
  // "openai-compat" path resolves fail-closed (Invariant 2): a misconfigured
  // endpoint throws a typed SearchError (an operator error, not a hot-path
  // degrade). An injected provider (tests) bypasses both.
  let provider = opts.provider;
  if (!provider) {
    if (config.kind === "local") {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { LocalRerankProvider } = require("./local.ts") as typeof import("./local.ts");
      provider = new LocalRerankProvider();
    } else {
      const endpoint = resolveOpenAiCompatEndpoint(
        {
          enabled: true,
          baseUrl: config.baseUrl,
          model: config.model,
          envKey: config.envKey,
          apiKey: config.apiKey,
          env: opts.env,
        },
        "search_rerank",
      );
      // resolveOpenAiCompatEndpoint only returns null when `enabled` is
      // false, which we ruled out above; the narrowing keeps TS honest.
      if (endpoint === null) return results;
      provider = makeRerankProvider(endpoint, { timeoutMs: opts.timeoutMs });
    }
  }

  if (results.length === 0) return results;

  const topK = Math.min(Math.max(1, config.topK), results.length);
  const head = results.slice(0, topK);
  const tail = results.slice(topK);
  const documents = head.map((r) => r.content);

  let scores: number[];
  try {
    scores = await provider.rerank(query, documents);
    if (scores.length !== documents.length) {
      throw new Error(`expected ${documents.length} scores, got ${scores.length}`);
    }
  } catch (e) {
    // Invariant 3: request-time degrade. Return the heuristic ordering
    // untouched and emit one fail-open telemetry event.
    opts.onTelemetry?.({
      status: "error",
      reason: e instanceof Error ? e.message : String(e),
      candidateCount: topK,
    });
    return results;
  }

  const reordered = reorderTopK(head, scores, config.minScore);
  opts.onTelemetry?.({ status: "applied", candidateCount: topK });
  return [...reordered, ...tail];
}
