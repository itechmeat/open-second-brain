/**
 * Embedding price quotes (Honest Embedding Spend).
 *
 * One resolver answers "what does this model cost per million input
 * tokens, and who said so". The order is: the operator's declared price
 * pair when its model matches, then the frozen builtin table, then
 * unknown. An unknown price is reported as unknown (`usdPerMtok: null`),
 * never as 0, so a paid model nobody priced cannot read as free.
 */

import { canonicalToken, EMBEDDING_PRICING } from "./signature.ts";

/** Who stated an embedding price. The value leaves TypeScript in receipts and JSON. */
export const EMBEDDING_PRICE_SOURCE = Object.freeze({
  /** The frozen table shipped with this release stated the price. */
  builtin: "builtin",
  /** The operator declared the price through the config price pair. */
  operator: "operator",
  /** Nobody stated a price for the model. */
  unknown: "unknown",
} as const);

/** Closed union over {@link EMBEDDING_PRICE_SOURCE}. */
export type EmbeddingPriceSource =
  (typeof EMBEDDING_PRICE_SOURCE)[keyof typeof EMBEDDING_PRICE_SOURCE];

/** Membership list, in resolution order. */
export const EMBEDDING_PRICE_SOURCES: ReadonlyArray<EmbeddingPriceSource> = Object.freeze([
  EMBEDDING_PRICE_SOURCE.operator,
  EMBEDDING_PRICE_SOURCE.builtin,
  EMBEDDING_PRICE_SOURCE.unknown,
]);

/** Narrow a string read back off disk or across a tool boundary. */
export function isEmbeddingPriceSource(value: unknown): value is EmbeddingPriceSource {
  return (
    typeof value === "string" && (EMBEDDING_PRICE_SOURCES as ReadonlyArray<string>).includes(value)
  );
}

/** Config key naming the model the operator's declared price applies to. */
export const EMBEDDING_PRICE_MODEL_KEY = "embedding_price_model";
/** Config key carrying the operator's declared USD per million input tokens. */
export const EMBEDDING_PRICE_RATE_KEY = "embedding_price_usd_per_mtok";
/** Env twin of {@link EMBEDDING_PRICE_MODEL_KEY}. */
export const EMBEDDING_PRICE_MODEL_ENV = "OPEN_SECOND_BRAIN_EMBEDDING_PRICE_MODEL";
/** Env twin of {@link EMBEDDING_PRICE_RATE_KEY}. */
export const EMBEDDING_PRICE_RATE_ENV = "OPEN_SECOND_BRAIN_EMBEDDING_PRICE_USD_PER_MTOK";

/** The operator's declared price, bound to one model name. */
export interface EmbeddingPriceOverride {
  readonly model: string;
  readonly usdPerMtok: number;
}

/**
 * A resolved price. `usdPerMtok` is null exactly when `source` is
 * `unknown`; a known rate of 0 is a statement that the model is free.
 */
export type PriceQuote = KnownPriceQuote | UnknownPriceQuote;

/** A quote whose rate somebody stated. */
export interface KnownPriceQuote {
  readonly usdPerMtok: number;
  readonly source: typeof EMBEDDING_PRICE_SOURCE.builtin | typeof EMBEDDING_PRICE_SOURCE.operator;
}

/** A quote for a model nobody priced. */
export interface UnknownPriceQuote {
  readonly usdPerMtok: null;
  readonly source: typeof EMBEDDING_PRICE_SOURCE.unknown;
}

const UNKNOWN_QUOTE: PriceQuote = Object.freeze({
  usdPerMtok: null,
  source: EMBEDDING_PRICE_SOURCE.unknown,
});

/**
 * Resolve the price of `model`. The operator declaration wins when its
 * model equals `model` after the same canonicalisation the table uses,
 * so a vendor price change can be declared over a table rate. A
 * declaration for another model is ignored: the pair binds the price to
 * one name, so switching models never re-targets it.
 */
export function resolveEmbeddingPrice(
  model: string | null,
  override?: EmbeddingPriceOverride,
): PriceQuote {
  if (model === null) return UNKNOWN_QUOTE;
  const key = canonicalToken(model);
  if (override !== undefined && canonicalToken(override.model) === key) {
    return { usdPerMtok: override.usdPerMtok, source: EMBEDDING_PRICE_SOURCE.operator };
  }
  const rate = EMBEDDING_PRICING[key];
  if (typeof rate === "number" && Number.isFinite(rate) && rate >= 0) {
    return { usdPerMtok: rate, source: EMBEDDING_PRICE_SOURCE.builtin };
  }
  return UNKNOWN_QUOTE;
}
