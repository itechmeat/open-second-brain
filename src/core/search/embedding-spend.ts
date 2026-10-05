/**
 * The shared embedding spend plan (Honest Embedding Spend).
 *
 * Four places price embedding spend: the phase gate, the maintenance
 * preview, the vector-backfill dry run and the `search status` refresh
 * estimate. They all read {@link planEmbeddingSpend}, so what a run
 * announces, refuses, spends and receipts is one computation: one pending
 * census (optionally path-scoped), one model resolution, one token
 * estimate, one price quote and one gate verdict.
 *
 * The gate fails closed only under an explicit cap: a positive
 * `embedding_cost_gate_usd` refuses an unpriced model with pending work,
 * because for an operator who asked for a ceiling an unknown price is not
 * a price below it. A zero gate (the default) never blocks.
 */

import {
  EMBEDDING_PRICE_MODEL_KEY,
  EMBEDDING_PRICE_RATE_KEY,
  resolveEmbeddingPrice,
  type PriceQuote,
} from "./embeddings/pricing.ts";
import { estimateCostUsd, estimateTokens, LOCAL_EMBEDDING_MODEL } from "./embeddings/signature.ts";
import type { Store } from "./store.ts";
import type { PendingVectorScope } from "./store/chunks.ts";
import type { ResolvedSearchConfig } from "./types.ts";

/** Why a gate refused. The value leaves TypeScript in previews and JSON. */
export const EMBEDDING_GATE_REASON = Object.freeze({
  /** The known estimate strictly exceeds the positive gate. */
  overCap: "over_cap",
  /** The gate is positive and nobody stated the model's price. */
  unpriced: "unpriced",
} as const);

/** Closed union over {@link EMBEDDING_GATE_REASON}. */
export type EmbeddingGateReason =
  (typeof EMBEDDING_GATE_REASON)[keyof typeof EMBEDDING_GATE_REASON];

/** Membership list of {@link EMBEDDING_GATE_REASON}. */
export const EMBEDDING_GATE_REASONS: ReadonlyArray<EmbeddingGateReason> = Object.freeze([
  EMBEDDING_GATE_REASON.overCap,
  EMBEDDING_GATE_REASON.unpriced,
]);

/** Narrow a string read back off disk or across a tool boundary. */
export function isEmbeddingGateReason(value: unknown): value is EmbeddingGateReason {
  return (
    typeof value === "string" && (EMBEDDING_GATE_REASONS as ReadonlyArray<string>).includes(value)
  );
}

/** A gate verdict: `reason` is null exactly when the run is not blocked. */
export type EmbeddingGateVerdict =
  | { readonly blocked: false; readonly reason: null }
  | { readonly blocked: true; readonly reason: EmbeddingGateReason };

/** Outcome of a cost-gate evaluation for an embedding run. */
export type CostGateResult = EmbeddingGateVerdict & {
  readonly tokens: number;
  /** Null when the price is unknown; never 0 for an unknown price. */
  readonly estimatedUsd: number | null;
};

const PASS: EmbeddingGateVerdict = Object.freeze({ blocked: false, reason: null });

/**
 * Evaluate whether an embedding run should be blocked on estimated spend.
 * Never blocks when the gate is 0, the run is forced or nothing is
 * pending. Otherwise an unknown price blocks as `unpriced` and a known
 * estimate strictly over the gate blocks as `over_cap`.
 */
export function evaluateCostGate(opts: {
  texts: ReadonlyArray<string>;
  quote: PriceQuote;
  gateUsd: number;
  forced?: boolean;
}): CostGateResult {
  const tokens = estimateTokens(opts.texts);
  const estimatedUsd = estimateCostUsd(tokens, opts.quote);
  return { tokens, estimatedUsd, ...gateVerdict(opts, estimatedUsd) };
}

function gateVerdict(
  opts: { texts: ReadonlyArray<string>; gateUsd: number; forced?: boolean },
  estimatedUsd: number | null,
): EmbeddingGateVerdict {
  if (opts.gateUsd <= 0 || opts.forced === true || opts.texts.length === 0) return PASS;
  if (estimatedUsd === null) return { blocked: true, reason: EMBEDDING_GATE_REASON.unpriced };
  if (estimatedUsd > opts.gateUsd) return { blocked: true, reason: EMBEDDING_GATE_REASON.overCap };
  return PASS;
}

/**
 * The model an embedding request would name right now. The local
 * provider always embeds with its implicit model, whatever
 * `embedding_model` says; every other provider takes the configured
 * one, falling back to what the index recorded when the config leaves
 * it unset.
 */
export function activeEmbeddingModel(
  config: ResolvedSearchConfig,
  storedModel: string | null = null,
): string | null {
  if (config.semantic.provider === "local") return LOCAL_EMBEDDING_MODEL;
  return config.semantic.model ?? storedModel;
}

/**
 * The model a pass would name and its price quote, through the operator
 * pair. The one model resolution every spend surface shares.
 */
export function activeSpendQuote(config: ResolvedSearchConfig): {
  readonly model: string | null;
  readonly quote: PriceQuote;
} {
  const model = activeEmbeddingModel(config);
  return { model, quote: resolveEmbeddingPrice(model, config.semantic.priceOverride) };
}

/** One computation of what an embedding pass would spend. */
export interface EmbeddingSpendPlan {
  /** The scoped pending census: chunks with no vector yet. */
  readonly pending: ReadonlyArray<{ readonly chunkId: number; readonly content: string }>;
  readonly model: string | null;
  readonly tokens: number;
  readonly quote: PriceQuote;
  /** Null when the price is unknown. */
  readonly estimatedUsd: number | null;
  readonly gate: EmbeddingGateVerdict;
}

/** Options of {@link planEmbeddingSpend}. */
export interface EmbeddingSpendPlanOptions {
  /** Path scope of the pending census; vault-wide when absent. */
  readonly scope?: PendingVectorScope;
  /** A forced plan never blocks. */
  readonly forced?: boolean;
}

/**
 * Plan the spend of embedding every pending chunk in scope. Reads only:
 * the phase in `indexer.ts` remains the only spender and throws on a
 * blocked verdict.
 */
export function planEmbeddingSpend(
  store: Store,
  config: ResolvedSearchConfig,
  opts: EmbeddingSpendPlanOptions = {},
): EmbeddingSpendPlan {
  return priceSpendPlan(store.findChunksWithoutEmbeddings(opts.scope), config, opts.forced);
}

/**
 * Price `pending` under the current config: the model, the quote, the
 * estimate and the gate verdict, with no census read. The embedding
 * phase re-prices a plan a caller handed in this way, so the verdict it
 * gates on is never one the caller computed forced or under another
 * config.
 */
export function priceSpendPlan(
  pending: EmbeddingSpendPlan["pending"],
  config: ResolvedSearchConfig,
  forced?: boolean,
): EmbeddingSpendPlan {
  const { model, quote } = activeSpendQuote(config);
  const { tokens, estimatedUsd, ...gate } = evaluateCostGate({
    texts: pending.map((p) => p.content),
    quote,
    gateUsd: config.semantic.costGateUsd,
    ...(forced === undefined ? {} : { forced }),
  });
  return { pending, model, tokens, quote, estimatedUsd, gate };
}

/** What every spend surface prints in place of a dollar figure nobody can state. */
export const PRICE_UNKNOWN_LABEL = "price unknown";

/** Decimal places of every rendered USD amount, the gate's own spelling. */
export const USD_DECIMALS = 4;

/** A USD estimate as `$0.0123`, or {@link PRICE_UNKNOWN_LABEL} when null. */
export function formatEstimatedUsd(usd: number | null): string {
  return usd === null ? PRICE_UNKNOWN_LABEL : `$${usd.toFixed(USD_DECIMALS)}`;
}

/** The config key whose positive value turns an estimate into a refusal. */
export const COST_GATE_KEY = "embedding_cost_gate_usd";
/** The flag that passes a cost-gate refusal for one run. */
export const FORCE_COST_FLAG = "--force-cost";

/** The refusal text for an unpriced model under a positive gate. */
export function unpricedRefusalMessage(plan: EmbeddingSpendPlan, gateUsd: number): string {
  return (
    `embedding model ${plan.model ?? "(unset)"} has no known price, so ${plan.pending.length} ` +
    `chunk(s) cannot be checked against ${COST_GATE_KEY} ${formatEstimatedUsd(gateUsd)}. ` +
    `Declare its price with ${EMBEDDING_PRICE_MODEL_KEY} and ${EMBEDDING_PRICE_RATE_KEY}, ` +
    `or re-run with ${FORCE_COST_FLAG} to proceed.`
  );
}
