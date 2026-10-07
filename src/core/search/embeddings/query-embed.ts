/**
 * The query-embed gateway (honest-query-embed-and-safe-upgrades).
 *
 * Every paid query embed answers the same question before it spends: what
 * text goes on the wire. This module answers it once, so the search lane
 * and the semantic belief order cannot disagree about it.
 *
 * The fit cuts the query to the effective input window
 * (`effectiveInputWindowTokens` in `presets.ts`), charging the prefix the
 * backend actually sends against it. The cut uses the CEILING estimate,
 * the bound that cannot under-count, so it never sends more than the
 * window. Spend disclosure keeps the shared floor-side `estimateTokens`,
 * so a query receipt stays comparable with every other spend surface.
 * The ceiling over-cuts non-ASCII text; that is the safe direction, and
 * there is no real tokenizer here on purpose (no dependency).
 *
 * An unknown window cuts nothing, which is byte-identical to the
 * behaviour before the window was known to anyone.
 *
 * The gate decides whether the embed is sent at all. A caller that is not
 * local spends the operator's money on every request, so under a positive
 * `embedding_cost_gate_usd` a model nobody priced is refused before any
 * provider exists. That is v1.72.0's rule exactly (the unpriced arm only,
 * never an over-cap comparison for one query), and this is the one place
 * it lives. The gateway returns data rather than throwing, because its
 * callers report a refusal differently: the search lane has an explicit
 * and an implicit arm, the semantic belief order always refuses.
 */

import { resolvedTransportReach, TRANSPORT_REACH } from "../../graph/transport-reach.ts";
import type { TransportReach } from "../../graph/transport-reach.ts";
import { activeSpendQuote, COST_GATE_KEY } from "../embedding-spend.ts";
import type { ResolvedSearchConfig } from "../types.ts";
import {
  effectiveInputWindowTokens,
  INPUT_WINDOW_TOKENS_KEY,
  queryPrefixSentByProvider,
} from "./presets.ts";
import {
  EMBEDDING_PRICE_MODEL_KEY,
  EMBEDDING_PRICE_RATE_KEY,
  EMBEDDING_PRICE_SOURCE,
  type PriceQuote,
} from "./pricing.ts";
import { estimateTokens, textExtent, tokenEstimateCeiling } from "./signature.ts";

/** What a query fit decided: the text to send and what it costs. */
export interface QueryFit {
  /**
   * The query as it will be sent, without the prefix (the provider adds
   * the prefix itself). Empty when the prefix alone fills the window: the
   * caller must treat that as a degradation, never embed it.
   */
  readonly text: string;
  /** True when {@link text} is shorter than the query the caller sent. */
  readonly truncated: boolean;
  /**
   * The spend estimate (`estimateTokens`) of what goes on the wire, prefix
   * included. Zero when nothing is sent.
   */
  readonly sentTokens: number;
}

/** UTF-8 byte length of one code point. */
function utf8Length(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/**
 * The longest code-point prefix of `query` whose ceiling estimate, with
 * `prefix` in front, fits `windowTokens`. A `null` window means unknown,
 * and an unknown window cuts nothing.
 *
 * The cut is at a code-point boundary, so it never splits a surrogate
 * pair, and it is language-agnostic: no word or grapheme rule. The
 * ceiling never decreases as code points are appended (each one adds at
 * most one non-ASCII slot and at most one remainder code point), so the
 * first code point that overflows marks the cut.
 */
export function fitQueryToWindow(
  query: string,
  prefix: string,
  windowTokens: number | null,
): QueryFit {
  const whole = (): QueryFit =>
    Object.freeze({
      text: query,
      truncated: false,
      sentTokens: estimateTokens([prefix + query]),
    });
  if (windowTokens === null) return whole();

  const base = textExtent(prefix);
  const fits = (codePoints: number, utf8Bytes: number): boolean =>
    tokenEstimateCeiling({
      codePoints: base.codePoints + codePoints,
      utf8Bytes: base.utf8Bytes + utf8Bytes,
    }) <= windowTokens;

  const codePoints = [...query];
  let kept = 0;
  let bytes = 0;
  for (const ch of codePoints) {
    const next = bytes + utf8Length(ch.codePointAt(0)!);
    if (!fits(kept + 1, next)) break;
    kept++;
    bytes = next;
  }
  if (kept === codePoints.length) return whole();

  const text = codePoints.slice(0, kept).join("");
  return Object.freeze({
    text,
    truncated: true,
    sentTokens: text === "" ? 0 : estimateTokens([prefix + text]),
  });
}

/** The gateway refused: the embed must not be sent. */
export interface QueryEmbedRefused {
  readonly kind: "refused";
  readonly code: "EMBEDDING_COST_UNPRICED";
  /** The model the embed would have named, null when none is configured. */
  readonly model: string | null;
}

/** The gateway cleared the embed: send {@link text}, disclose the rest. */
interface QueryEmbedReadyBase extends QueryFit {
  readonly kind: "ready";
  /** The price quote every spend surface shares for {@link model}. */
  readonly quote: PriceQuote;
  /** The model the embed names, null when none is configured. */
  readonly model: string | null;
}

/** The query fits its window (or the window is unknown): it is sent whole. */
export interface QueryEmbedWhole extends QueryEmbedReadyBase {
  readonly truncated: false;
  readonly emptyFit: false;
  /** The effective input window the text was fitted to; null when unknown. */
  readonly windowTokens: number | null;
}

/** The query was cut to its window; only a known window cuts. */
export interface QueryEmbedCut extends QueryEmbedReadyBase {
  readonly truncated: true;
  /**
   * True when the instruction prefix alone fills the window, so nothing of
   * the query survived the cut. Every caller must treat it as a
   * degradation and never embed the prefix by itself.
   */
  readonly emptyFit: boolean;
  /** The effective input window the text was cut to. */
  readonly windowTokens: number;
}

/** A cleared embed: whole, or cut to a known window. */
export type QueryEmbedReady = QueryEmbedWhole | QueryEmbedCut;

/** What {@link prepareQueryEmbed} decided. */
export type QueryEmbedPreparation = QueryEmbedRefused | QueryEmbedReady;

/**
 * Decide whether, and with what text, a query is embedded.
 *
 * Pure over the config: no provider is constructed and nothing is sent.
 * An omitted reach resolves through `resolvedTransportReach` (remote), as
 * everywhere else in the tree. The local hashing embedder is priced at 0
 * by the builtin table, so it is never refused; a self-hosted model is
 * unpriced until the operator declares its price (0 for free).
 */
export function prepareQueryEmbed(
  config: ResolvedSearchConfig,
  query: string,
  reach: TransportReach | undefined,
): QueryEmbedPreparation {
  const { model, quote } = activeSpendQuote(config);
  if (
    resolvedTransportReach(reach) !== TRANSPORT_REACH.local &&
    config.semantic.costGateUsd > 0 &&
    quote.source === EMBEDDING_PRICE_SOURCE.unknown
  ) {
    return Object.freeze({ kind: "refused", code: "EMBEDDING_COST_UNPRICED", model });
  }
  const windowTokens = effectiveInputWindowTokens(config.semantic);
  const fit = fitQueryToWindow(
    query,
    queryPrefixSentByProvider(config.semantic.provider, config.semantic.queryPrefix),
    windowTokens,
  );
  if (fit.truncated && windowTokens !== null) {
    return Object.freeze({
      kind: "ready",
      ...fit,
      truncated: true,
      emptyFit: fit.text === "",
      windowTokens,
      quote,
      model,
    });
  }
  return Object.freeze({
    kind: "ready",
    ...fit,
    truncated: false,
    emptyFit: false,
    windowTokens,
    quote,
    model,
  });
}

/**
 * The operator-facing sentence for a refused query embed: the model, the
 * gate key, and the price pair that clears it. Shared so every caller
 * that surfaces the refusal names the same lever.
 *
 * The gate amount is the operator's budget and the gateway refuses only
 * callers that are not local, so the sentence says the gate is positive
 * and never states the amount.
 */
export function queryEmbedRefusalMessage(refused: QueryEmbedRefused): string {
  return (
    `embedding model ${refused.model ?? "(unset)"} has no known price and ` +
    `${COST_GATE_KEY} is positive, so a query embed for a caller ` +
    `that is not local is refused. Declare its price with ${EMBEDDING_PRICE_MODEL_KEY} ` +
    `and ${EMBEDDING_PRICE_RATE_KEY} (0 for a free self-hosted model).`
  );
}

/**
 * The operator-facing sentence for an empty fit: the window, and the key
 * that raises it when the model accepts more. Shared so the search lane
 * and the semantic belief order name the same lever.
 */
export function queryEmbedEmptyFitMessage(cut: QueryEmbedCut): string {
  return (
    `the ${cut.windowTokens}-token embedding input window leaves no room for the query ` +
    `after the instruction prefix; raise ${INPUT_WINDOW_TOKENS_KEY} if the model accepts ` +
    `more, or shorten the query prefix`
  );
}

/**
 * The operator-facing sentence for a query cut to its window: the window,
 * how much of `query` was embedded, and the key that raises the window.
 */
export function queryEmbedCutMessage(cut: QueryEmbedCut, query: string): string {
  return (
    `query cut to the ${cut.windowTokens}-token embedding input window: ` +
    `${[...cut.text].length} of ${[...query].length} code point(s) embedded; ` +
    `raise ${INPUT_WINDOW_TOKENS_KEY} if the model accepts more`
  );
}
