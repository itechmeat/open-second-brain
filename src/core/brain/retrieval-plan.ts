/**
 * Shadow-only retrieval_plan advisor (R3, t_3ffb021c).
 *
 * A strictly read-only advisor that composes four EXISTING deterministic
 * signals into one per-question retrieval plan, without changing any of
 * them:
 *   - the query plan ({@link ../search/query-plan.ts}): structural intent,
 *     the bounded weight profile, and the summary-surface route (R1);
 *   - the context-pack density allocation ({@link ./context-pack.ts} +
 *     {@link ./context-density.ts}): the impact-per-token ranking and the
 *     token budget the packer would actually spend;
 *   - the calibrated token-impact ledger ({@link ./token-impact.ts}): the
 *     first-pass rate that tells us how reliable recalled memory has been;
 *   - observed route latency ({@link ./mcp-route-metrics.ts}): the search
 *     route's success rate and p95 latency.
 *
 * From those it emits: source/query strategy, the token-budget allocation
 * matching what the packer would spend, graph-expansion advice, observed
 * reliability with p95 latency, and a marginal-value stop derived from the
 * density curve plus p95 latency (each extra low-density page costs more when
 * the route is slow, so the stop tightens as p95 rises).
 *
 * SHADOW-ONLY INVARIANT: this module reads signals and returns advice. It
 * writes no config and no store rows (the context pack runs without a
 * receipt, telemetry, or metric), and it exposes no handle that could mutate
 * ranking or weight policy. The advisor is pure with respect to the vault.
 */

import { buildQueryPlan } from "../search/query-plan.ts";
import type { QueryIntent, QuerySurface, WeightProfile } from "../search/types.ts";
import { packContext, type ContextPackReport } from "./context-pack.ts";
import { summarizeTokenImpact, type TokenImpactSummary } from "./token-impact.ts";
import { summarizeMcpRouteLatency, type McpRouteLatencySummary } from "./mcp-route-metrics.ts";
import { loadSchemaPack } from "./schema-pack.ts";

// ----- Tunables -------------------------------------------------------------

/** Default context-pack token budget the advisor models when none is given. */
export const DEFAULT_PLAN_TOKEN_BUDGET = 2000;
/** The MCP route whose observed latency drives the reliability read. */
export const RETRIEVAL_PLAN_ROUTE = "brain_search";
/**
 * Marginal-value stop: a page is worth including only while its density is at
 * least this fraction of the top page's density. The fraction is the base
 * plus a p95-scaled surcharge, so a slow route demands denser pages.
 */
export const STOP_BASE_FRACTION = 0.25;
/** p95 latency (ms) that adds the full {@link STOP_MAX_EXTRA_FRACTION} surcharge. */
export const STOP_P95_SCALE_MS = 4000;
/** Cap on the p95-driven surcharge added to {@link STOP_BASE_FRACTION}. */
export const STOP_MAX_EXTRA_FRACTION = 0.5;
/** Graph-expansion hop suggestions per structural intent. */
const HOPS_BY_INTENT: Readonly<Record<QueryIntent, number>> = Object.freeze({
  broad: 2,
  entity: 1,
  exact: 0,
  neutral: 0,
});

// ----- Types ----------------------------------------------------------------

export interface RetrievalPlanStrategy {
  readonly intent: QueryIntent;
  readonly surface: QuerySurface;
  readonly weights: WeightProfile;
}

export interface RetrievalPlanAllocation {
  readonly tokenBudget: number;
  readonly tokensUsed: number;
  readonly itemCount: number;
  /** Per-item density, best-first: the density curve the stop reads off. */
  readonly densityCurve: ReadonlyArray<number>;
}

export interface RetrievalPlanGraphExpansion {
  readonly advised: boolean;
  readonly suggestedHops: number;
  readonly reason: string;
}

export interface RetrievalPlanReliability {
  readonly routeSamples: number;
  /** Route success rate in [0,1], or null when no route samples exist. */
  readonly successRate: number | null;
  /** Observed p95 latency (ms) for the route, or null when unobserved. */
  readonly p95LatencyMs: number | null;
  /** Calibrated token-impact first-pass rate, or null when uncalibrated. */
  readonly firstPassRate: number | null;
}

export interface RetrievalPlanMarginalStop {
  /** Include this many leading pages; beyond it marginal value < cost. */
  readonly stopRank: number;
  /** Cumulative tokens of the leading pages up to the stop. */
  readonly stopTokens: number;
  readonly reason: string;
}

export interface RetrievalPlanAdvice {
  readonly question: string;
  readonly strategy: RetrievalPlanStrategy;
  readonly allocation: RetrievalPlanAllocation;
  readonly graphExpansion: RetrievalPlanGraphExpansion;
  readonly reliability: RetrievalPlanReliability;
  readonly marginalStop: RetrievalPlanMarginalStop;
}

export interface RetrievalPlanDeps {
  /** Context pack producer; defaults to a read-only {@link packContext}. */
  readonly pack?: (vault: string, budget: number) => ContextPackReport;
  /** Token-impact summary; defaults to {@link summarizeTokenImpact}. */
  readonly tokenImpact?: (vault: string) => TokenImpactSummary;
  /** Route latency summary; defaults to {@link summarizeMcpRouteLatency}. */
  readonly routeLatency?: (vault: string) => McpRouteLatencySummary;
  /** Summary-surface vocabulary; defaults to the schema pack's page types. */
  readonly surfaceVocabulary?: ReadonlySet<string>;
  /** Context-pack token budget; defaults to {@link DEFAULT_PLAN_TOKEN_BUDGET}. */
  readonly tokenBudget?: number;
}

// ----- Composition ----------------------------------------------------------

function summarySurfaceVocabulary(vault: string): ReadonlySet<string> {
  try {
    return new Set(loadSchemaPack(vault).vocabulary.page_types.map((t) => t.toLowerCase()));
  } catch {
    return new Set<string>();
  }
}

/** Read-only default pack: no receipt, telemetry, or metric, so nothing is written. */
function defaultPack(vault: string, budget: number): ContextPackReport {
  return packContext(vault, { maxTokens: budget, densityRanking: true });
}

function graphExpansionFor(intent: QueryIntent): RetrievalPlanGraphExpansion {
  const suggestedHops = HOPS_BY_INTENT[intent];
  if (suggestedHops === 0) {
    return Object.freeze({
      advised: false,
      suggestedHops: 0,
      reason: `intent '${intent}' is a direct lookup; graph expansion adds noise`,
    });
  }
  return Object.freeze({
    advised: true,
    suggestedHops,
    reason: `intent '${intent}' benefits from ${suggestedHops}-hop link expansion`,
  });
}

function reliabilityFrom(
  routes: McpRouteLatencySummary,
  impact: TokenImpactSummary,
): RetrievalPlanReliability {
  const route = routes.routes.find((r) => r.tool === RETRIEVAL_PLAN_ROUTE);
  const successRate =
    route && route.count > 0 ? (route.count - route.error_count) / route.count : null;
  return Object.freeze({
    routeSamples: route?.count ?? 0,
    successRate,
    p95LatencyMs: route ? route.p95_ms : null,
    firstPassRate: impact.modeled_inference_avoidance.calibration.first_pass_rate,
  });
}

/**
 * The marginal-value stop over the density curve. A page is worth its tokens
 * while its density is at least `effectiveFraction * topDensity`, where the
 * fraction climbs with p95 latency. At least one page is always included when
 * any exist. A flat (zero-density) curve keeps the whole allocation.
 */
function marginalStop(
  densityCurve: ReadonlyArray<number>,
  tokens: ReadonlyArray<number>,
  p95LatencyMs: number | null,
): RetrievalPlanMarginalStop {
  if (densityCurve.length === 0) {
    return Object.freeze({ stopRank: 0, stopTokens: 0, reason: "no candidates to allocate" });
  }
  const top = densityCurve[0]!;
  const surcharge = Math.min(
    STOP_MAX_EXTRA_FRACTION,
    (Math.max(0, p95LatencyMs ?? 0) / STOP_P95_SCALE_MS) * STOP_MAX_EXTRA_FRACTION,
  );
  const fraction = STOP_BASE_FRACTION + surcharge;
  const floor = top * fraction;
  let stopRank = 0;
  let stopTokens = 0;
  for (let i = 0; i < densityCurve.length; i++) {
    if (densityCurve[i]! < floor && stopRank >= 1) break;
    stopRank += 1;
    stopTokens += tokens[i] ?? 0;
  }
  return Object.freeze({
    stopRank,
    stopTokens,
    reason:
      `stop after ${stopRank} page(s): density floor ${floor.toFixed(4)} ` +
      `(${(fraction * 100).toFixed(0)}% of top) given p95 ${p95LatencyMs ?? 0}ms`,
  });
}

/**
 * Build the read-only retrieval plan for one question. Pure with respect to
 * the vault: it composes existing signals and writes nothing.
 */
export function buildRetrievalPlan(
  vault: string,
  question: string,
  deps: RetrievalPlanDeps = {},
): RetrievalPlanAdvice {
  const budget = Math.max(1, Math.floor(deps.tokenBudget ?? DEFAULT_PLAN_TOKEN_BUDGET));
  const vocab = deps.surfaceVocabulary ?? summarySurfaceVocabulary(vault);
  const queryPlan = buildQueryPlan(question, [], null, vocab);

  const pack = (deps.pack ?? defaultPack)(vault, budget);
  const items = pack.items;
  const densityCurve = items.map((i) => i.density ?? 0);
  const tokens = items.map((i) => i.tokens);

  const routes = (deps.routeLatency ?? summarizeMcpRouteLatency)(vault);
  const impact = (deps.tokenImpact ?? summarizeTokenImpact)(vault);
  const reliability = reliabilityFrom(routes, impact);

  return Object.freeze({
    question,
    strategy: Object.freeze({
      intent: queryPlan.intent,
      surface: queryPlan.surface,
      weights: queryPlan.weightProfile,
    }),
    allocation: Object.freeze({
      tokenBudget: pack.maxTokens,
      tokensUsed: pack.tokensUsed,
      itemCount: items.length,
      densityCurve: Object.freeze(densityCurve),
    }),
    graphExpansion: graphExpansionFor(queryPlan.intent),
    reliability,
    marginalStop: marginalStop(densityCurve, tokens, reliability.p95LatencyMs),
  });
}

/** Snake_case JSON projection for the MCP tool and any --json surface. */
export function serializeRetrievalPlan(plan: RetrievalPlanAdvice): Record<string, unknown> {
  return {
    question: plan.question,
    strategy: {
      intent: plan.strategy.intent,
      surface: plan.strategy.surface,
      weights: plan.strategy.weights,
    },
    allocation: {
      token_budget: plan.allocation.tokenBudget,
      tokens_used: plan.allocation.tokensUsed,
      item_count: plan.allocation.itemCount,
      density_curve: plan.allocation.densityCurve,
    },
    graph_expansion: {
      advised: plan.graphExpansion.advised,
      suggested_hops: plan.graphExpansion.suggestedHops,
      reason: plan.graphExpansion.reason,
    },
    reliability: {
      route_samples: plan.reliability.routeSamples,
      success_rate: plan.reliability.successRate,
      p95_latency_ms: plan.reliability.p95LatencyMs,
      first_pass_rate: plan.reliability.firstPassRate,
    },
    marginal_stop: {
      stop_rank: plan.marginalStop.stopRank,
      stop_tokens: plan.marginalStop.stopTokens,
      reason: plan.marginalStop.reason,
    },
  };
}
