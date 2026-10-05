/**
 * `search check` hints about the embedding price (Honest Embedding Spend).
 *
 * Two findings, each one line, each silent when there is nothing to say:
 *
 *   - The active model has no known price. The line names the price pair
 *     the operator can declare and what the cost gate does meanwhile: a
 *     gate of 0 never blocks, so the line says a positive gate would
 *     refuse; a positive gate refuses unpriced embedding work now, so the
 *     line says that it does.
 *   - The declared price pair names a model other than the active one. A
 *     stale declaration prices nothing, and nothing else would say so.
 *
 * A table-priced model, an operator-priced model and the local embedder
 * (priced at 0 by the table) produce no line, so their check output stays
 * byte-identical.
 */

import {
  activeSpendQuote,
  COST_GATE_KEY,
  FORCE_COST_FLAG,
  formatEstimatedUsd,
} from "./embedding-spend.ts";
import {
  EMBEDDING_PRICE_MODEL_KEY,
  EMBEDDING_PRICE_RATE_KEY,
  EMBEDDING_PRICE_SOURCE,
} from "./embeddings/pricing.ts";
import { canonicalToken } from "./embeddings/signature.ts";
import type { ResolvedSearchConfig } from "./types.ts";

/** What the cost gate does with an unpriced model under `gateUsd`. */
function gateConsequence(gateUsd: number): string {
  if (gateUsd > 0) {
    return (
      `${COST_GATE_KEY} is ${formatEstimatedUsd(gateUsd)}, so embedding reindexes and ` +
      `vector backfills refuse until the price is declared or the run passes ${FORCE_COST_FLAG}.`
    );
  }
  return (
    `${COST_GATE_KEY} is 0, so nothing is refused; a positive gate would refuse embedding ` +
    `reindexes and vector backfills on this model until its price is declared.`
  );
}

/**
 * The price hints for the model an embedding pass would name right now.
 * The model and its quote come from `activeSpendQuote`, the resolution
 * the spend plan uses, so the hint prices the model the gate prices. A
 * configuration that names no model has nothing to price.
 */
export function embeddingPriceRecommendations(config: ResolvedSearchConfig): string[] {
  const { model, quote } = activeSpendQuote(config);
  if (model === null) return [];
  const recs: string[] = [];
  if (quote.source === EMBEDDING_PRICE_SOURCE.unknown) {
    recs.push(
      `No price is known for embedding model "${model}", so its spend is reported as unknown. ` +
        `Declare it with ${EMBEDDING_PRICE_MODEL_KEY}: ${model} and ` +
        `${EMBEDDING_PRICE_RATE_KEY}: <USD per million tokens> (0 declares the model free). ` +
        `Meanwhile ${gateConsequence(config.semantic.costGateUsd)}`,
    );
  }
  const declared = config.semantic.priceOverride;
  if (declared !== undefined && canonicalToken(declared.model) !== canonicalToken(model)) {
    recs.push(
      `The declared embedding price names model "${declared.model}", but the active embedding ` +
        `model is "${model}", so the declaration prices nothing. Point ` +
        `${EMBEDDING_PRICE_MODEL_KEY} at the active model or remove both ` +
        `${EMBEDDING_PRICE_MODEL_KEY} and ${EMBEDDING_PRICE_RATE_KEY}.`,
    );
  }
  return recs;
}
