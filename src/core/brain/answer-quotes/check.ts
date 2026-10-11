/**
 * The answer-time quote check: the verdict on each quoted span of a host
 * answer, against the evidence the turn actually had. Pure; no I/O.
 *
 * The distill lane verifies every quotation on a page it writes itself
 * (`src/core/brain/distill/quote-check.ts`). This module runs the SAME
 * helpers - `normalizeForQuoteComparison`, `quoteHaystack` and
 * `spanOccursIn`, imported in place from `quote-spans.ts`, never forked -
 * over evidence the host did not write: the note a span cites, or the
 * notes the injection ledger says entered context. It differs from the
 * distill check in the two ways its subject forces:
 *
 * - IT NEVER EDITS THE ANSWER. A failed span keeps its quotation marks;
 *   the verdict is reported and the hook annotates. `unquoteSpans` and
 *   `checkClaimQuotes` stay unextended and uncalled here.
 * - DEGRADATION NEVER UPGRADES A VERDICT. Evidence the turn had only in
 *   part is named apart: a span missing from a truncated note is
 *   `source-truncated`, never `not-in-note`, and a note that could not be
 *   read is `note-unavailable` - "we could not check" is a finding, not
 *   an all-clear.
 *
 * The verdict table, pinned by the test suite:
 *
 *   evidence                span occurs | verdict
 *   ------------------------|------------|------------------
 *   text (complete)         | yes        | verified
 *   text (complete)         | no         | not-in-note
 *   text (truncated)        | yes        | verified
 *   text (truncated)        | no         | source-truncated
 *   unavailable             | -          | note-unavailable
 *   not-text                | -          | not-text
 *
 * The vocabulary follows the census trio convention: frozen object,
 * companion member list, type guard; registered in
 * `tests/core/architecture/verdict-vocabulary-census.test.ts`.
 */

import {
  normalizeForQuoteComparison,
  quoteHaystack,
  spanOccursIn,
} from "../distill/quote-spans.ts";
import { QUOTE_SPAN_PREVIEW_MAX_CHARS } from "../distill/quote-verdict.ts";

/** The closed vocabulary of per-span verdicts. */
export const ANSWER_QUOTE_VERDICT = Object.freeze({
  /** The span occurs in the evidence the turn had. */
  verified: "verified",
  /** The evidence was fully readable, and the span is not in it. */
  notInNote: "not-in-note",
  /** The evidence reached context only in part, and the span is not in the part. */
  sourceTruncated: "source-truncated",
  /** The note the span is cited against could not be read (or none resolved). */
  noteUnavailable: "note-unavailable",
  /** The evidence bytes are not valid UTF-8 text. */
  notText: "not-text",
} as const);

/** Closed union over {@link ANSWER_QUOTE_VERDICT}. */
export type AnswerQuoteVerdict = (typeof ANSWER_QUOTE_VERDICT)[keyof typeof ANSWER_QUOTE_VERDICT];

/** Membership list, in verdict-table order. */
export const ANSWER_QUOTE_VERDICTS: ReadonlyArray<AnswerQuoteVerdict> = Object.freeze(
  Object.values(ANSWER_QUOTE_VERDICT),
);

/** Narrow a verdict read back off a payload or an annotation. */
export function isAnswerQuoteVerdict(value: unknown): value is AnswerQuoteVerdict {
  return (
    typeof value === "string" && (ANSWER_QUOTE_VERDICTS as ReadonlyArray<string>).includes(value)
  );
}

/**
 * What the turn had behind one candidate note. `truncated` marks evidence
 * the context received only in part - a `ContextPackItem.trimmed` body, a
 * receipt flagged `truncated`, or a pointer that names a line range - so
 * a miss against it can never read as `not-in-note`.
 */
export type AnswerQuoteEvidence =
  | { readonly kind: "text"; readonly text: string; readonly truncated: boolean }
  | { readonly kind: "unavailable" }
  | { readonly kind: "not-text" };

export interface AnswerQuoteCheckInput {
  /**
   * The quoted span texts (between the marks, verbatim), in answer order.
   * The caller finds them with `findQuoteSpans`; this module checks
   * verdicts, not mark pairing.
   */
  readonly spans: ReadonlyArray<string>;
  readonly evidence: AnswerQuoteEvidence;
}

/** One span's verdict, in the report's order. */
export interface AnswerQuoteSpanOutcome {
  /** 0-based position of the span in the input. */
  readonly index: number;
  /** The span's text, capped at {@link QUOTE_SPAN_PREVIEW_MAX_CHARS}. */
  readonly span: string;
  readonly verdict: AnswerQuoteVerdict;
}

export interface AnswerQuoteCheckResult {
  /** One outcome per input span, in input order. */
  readonly outcomes: ReadonlyArray<AnswerQuoteSpanOutcome>;
  /** Spans whose verdict is {@link ANSWER_QUOTE_VERDICT.verified}. */
  readonly verified: number;
  readonly unverified: number;
}

/**
 * The span's own text, cut at the preview cap without splitting a code
 * point. This is the only form a span renders in - the outcome's `span`
 * field, and anything a consumer prints about a span - so answer text is
 * bounded wherever it is echoed back.
 */
export function previewAnswerQuoteSpan(inner: string): string {
  const codePoints = Array.from(inner);
  return codePoints.length <= QUOTE_SPAN_PREVIEW_MAX_CHARS
    ? inner
    : codePoints.slice(0, QUOTE_SPAN_PREVIEW_MAX_CHARS).join("");
}

/** One span against one evidence body, both already settled. */
function textVerdict(inner: string, text: string, truncated: boolean): AnswerQuoteVerdict {
  return spanOccursIn(inner, quoteHaystack(normalizeForQuoteComparison(text)))
    ? ANSWER_QUOTE_VERDICT.verified
    : truncated
      ? ANSWER_QUOTE_VERDICT.sourceTruncated
      : ANSWER_QUOTE_VERDICT.notInNote;
}

/**
 * Check every span against one evidence body. Every span gets exactly one
 * verdict; nothing here touches the answer text.
 */
export function checkAnswerQuotes(input: AnswerQuoteCheckInput): AnswerQuoteCheckResult {
  const evidence = input.evidence;
  const outcomes = input.spans.map((span, index) => {
    const verdict =
      evidence.kind === "text"
        ? textVerdict(span, evidence.text, evidence.truncated)
        : evidence.kind === "unavailable"
          ? ANSWER_QUOTE_VERDICT.noteUnavailable
          : ANSWER_QUOTE_VERDICT.notText;
    return { index, span: previewAnswerQuoteSpan(span), verdict };
  });
  const verified = outcomes.filter((o) => o.verdict === ANSWER_QUOTE_VERDICT.verified).length;
  return { outcomes, verified, unverified: outcomes.length - verified };
}

/**
 * Merge the per-candidate verdicts of one span checked against several
 * evidence bodies (the no-citation case: every note the running phases'
 * ledger says entered context). The ladder is pinned:
 *
 *   1. a hit anywhere verifies - the evidence the turn had supports the
 *      span, however the other candidates answered;
 *   2. no candidates at all is `note-unavailable` - nothing to check
 *      against is a finding, not an all-clear;
 *   3. otherwise degradation outranks a readable miss, and the partial
 *      evidence outranks the absent: `source-truncated`, then
 *      `not-text`, then `note-unavailable`;
 *   4. readable misses only are `not-in-note`.
 */
export function mergeAnswerQuoteVerdicts(
  verdicts: ReadonlyArray<AnswerQuoteVerdict>,
): AnswerQuoteVerdict {
  if (verdicts.includes(ANSWER_QUOTE_VERDICT.verified)) return ANSWER_QUOTE_VERDICT.verified;
  const partial = verdicts.filter((verdict) => verdict !== ANSWER_QUOTE_VERDICT.notInNote);
  if (partial.length === 0) {
    return verdicts.length === 0
      ? ANSWER_QUOTE_VERDICT.noteUnavailable
      : ANSWER_QUOTE_VERDICT.notInNote;
  }
  if (partial.includes(ANSWER_QUOTE_VERDICT.sourceTruncated)) {
    return ANSWER_QUOTE_VERDICT.sourceTruncated;
  }
  if (partial.includes(ANSWER_QUOTE_VERDICT.notText)) return ANSWER_QUOTE_VERDICT.notText;
  return ANSWER_QUOTE_VERDICT.noteUnavailable;
}
