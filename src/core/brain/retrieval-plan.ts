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
import { marginalValueStop, type RetrievalPlanMarginalStop } from "./marginal-value-stop.ts";

// ----- Tunables -------------------------------------------------------------

/** Default context-pack token budget the advisor models when none is given. */
export const DEFAULT_PLAN_TOKEN_BUDGET = 2000;
/** The MCP route whose observed latency drives the reliability read. */
export const RETRIEVAL_PLAN_ROUTE = "brain_search";
// The stop predicate is a pure leaf (see ./marginal-value-stop.ts); its
// tunables, verdict type and function are re-exported here unchanged, so
// the advisor's public surface and every existing consumer are untouched.
export {
  STOP_BASE_FRACTION,
  STOP_MAX_EXTRA_FRACTION,
  STOP_P95_SCALE_MS,
  marginalValueStop,
  type RetrievalPlanMarginalStop,
} from "./marginal-value-stop.ts";
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
  readonly pack?: (
    vault: string,
    budget: number,
    agentScope: string | undefined,
  ) => ContextPackReport;
  /** Token-impact summary; defaults to {@link summarizeTokenImpact}. */
  readonly tokenImpact?: (vault: string) => TokenImpactSummary;
  /** Route latency summary; defaults to {@link summarizeMcpRouteLatency}. */
  readonly routeLatency?: (vault: string) => McpRouteLatencySummary;
  /** Summary-surface vocabulary; defaults to the schema pack's page types. */
  readonly surfaceVocabulary?: ReadonlySet<string>;
  /** Context-pack token budget; defaults to {@link DEFAULT_PLAN_TOKEN_BUDGET}. */
  readonly tokenBudget?: number;
  /**
   * Owner scope for the pack the advice is computed over
   * (context-integrity-gates, Unit A). The plan returns no memory
   * bodies, but its item count and density curve are derived from them,
   * so advice built over memories the caller may not see would describe
   * a pack it can never receive. Gated like every other
   * preference-backed surface; omitted filters nothing.
   */
  readonly agentScope?: string;
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
function defaultPack(
  vault: string,
  budget: number,
  agentScope: string | undefined,
): ContextPackReport {
  return packContext(vault, {
    maxTokens: budget,
    densityRanking: true,
    ...(agentScope !== undefined ? { agentScope } : {}),
  });
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

  const pack = (deps.pack ?? defaultPack)(vault, budget, deps.agentScope);
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
    marginalStop: marginalValueStop(densityCurve, tokens, reliability.p95LatencyMs),
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
