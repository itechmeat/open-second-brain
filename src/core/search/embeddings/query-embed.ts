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
 */

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
