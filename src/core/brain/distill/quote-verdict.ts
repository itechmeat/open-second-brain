/**
 * What the quote check decided about each quoted span of a distilled claim.
 *
 * A claim that wraps words in quotation marks asserts the source says exactly
 * those words. Each such span gets one outcome from {@link QUOTE_CHECK_OUTCOME}:
 * verified against the block the claim cites, verified against the whole
 * source (the weaker guarantee, named apart so it never reads as the
 * stronger), or one of the named reasons it could not be verified. A span
 * whose source has no local bytes is `url-only`, the same token the
 * capture-scope vocabulary uses for that fact (`CAPTURE_SCOPE.urlOnly`), so
 * "no local bytes" has one spelling across both vocabularies. It is written
 * as a literal because the verdict census reads only literal-valued
 * vocabularies; the equality is pinned by the test suite.
 *
 * This module holds the vocabulary, the report shape and the named refusal.
 * The check itself lives beside it in `quote-check.ts`.
 */

import { PAGE_LINT_MAX_FINDINGS } from "../page-lint.ts";

/** The closed vocabulary of per-span outcomes. */
export const QUOTE_CHECK_OUTCOME = Object.freeze({
  /** The span occurs in the block the claim cites. */
  verifiedInBlock: "verified-in-block",
  /** The claim cites no block, and the span occurs in the source. */
  verifiedInSource: "verified-in-source",
  /** The cited block resolved, and the span is not in it. */
  notInBlock: "not-in-block",
  /** The claim cites no block, and the span is not in the source. */
  notInSource: "not-in-source",
  /** The cited block id is not defined in the source. */
  blockNotFound: "block-not-found",
  /** The cited block id is defined more than once in the source. */
  blockAmbiguous: "block-ambiguous",
  /** The source bytes are not valid UTF-8 text. */
  sourceNotText: "source-not-text",
  /** The source has no local bytes to check against. */
  urlOnly: "url-only",
} as const);

/** Closed union over {@link QUOTE_CHECK_OUTCOME}. */
export type QuoteCheckOutcome = (typeof QUOTE_CHECK_OUTCOME)[keyof typeof QUOTE_CHECK_OUTCOME];

/** Membership list, verified outcomes first. */
export const QUOTE_CHECK_OUTCOMES: ReadonlyArray<QuoteCheckOutcome> = Object.freeze(
  Object.values(QUOTE_CHECK_OUTCOME),
);

/** Narrow an outcome read back off a payload or a fixture. */
export function isQuoteCheckOutcome(value: unknown): value is QuoteCheckOutcome {
  return (
    typeof value === "string" && (QUOTE_CHECK_OUTCOMES as ReadonlyArray<string>).includes(value)
  );
}

/** The outcomes under which a span keeps its quotation marks. */
export const VERIFIED_QUOTE_OUTCOMES: ReadonlySet<QuoteCheckOutcome> = new Set([
  QUOTE_CHECK_OUTCOME.verifiedInBlock,
  QUOTE_CHECK_OUTCOME.verifiedInSource,
]);

/** Findings returned per check: the page-lint cap, one ceiling for both reports. */
export const QUOTE_FINDINGS_MAX = PAGE_LINT_MAX_FINDINGS;

/** Longest span preview a finding carries, in characters. */
export const QUOTE_SPAN_PREVIEW_MAX_CHARS = 120;

/** One span that failed verification and was unquoted. */
export interface QuoteFinding {
  /** 0-based index of the claim the span sits in. */
  readonly claim: number;
  readonly outcome: QuoteCheckOutcome;
  /** The span's text, capped at {@link QUOTE_SPAN_PREVIEW_MAX_CHARS}. */
  readonly span: string;
}

/** The quote check's account of one distillation. */
export interface QuoteCheckReport {
  /** Spans checked across every claim. */
  readonly checked: number;
  readonly verified_in_block: number;
  readonly verified_in_source: number;
  /** Spans that failed and lost their quotation marks. */
  readonly unquoted: number;
  /** Marks that paired with nothing; counted, never edited. */
  readonly unpaired: number;
  /** Failed spans, capped at {@link QUOTE_FINDINGS_MAX}. */
  readonly findings: ReadonlyArray<QuoteFinding>;
  /** Failed spans before the cap. */
  readonly total: number;
  /** Failed spans after the cap. */
  readonly returned: number;
  readonly truncated: boolean;
}

/** Wire code of a strict refusal; registered in the MCP error registry. */
export const QUOTE_UNVERIFIED_CODE = "quote_unverified";

/** Frontmatter key: spans that verified on this page. */
export const QUOTES_VERIFIED_KEY = "quotes_verified";

/** Frontmatter key: spans that failed and were unquoted on this page. */
export const QUOTES_UNQUOTED_KEY = "quotes_unquoted";

/**
 * A strict distillation refused its write because a quoted span did not
 * verify. The message names claim indices and outcomes only, never span text
 * or paths, because it reaches an MCP caller.
 */
export class QuoteCheckError extends Error {
  readonly code = QUOTE_UNVERIFIED_CODE;
  readonly findings: ReadonlyArray<QuoteFinding>;

  constructor(findings: ReadonlyArray<QuoteFinding>) {
    const named = findings.map((finding) => `claim ${finding.claim}: ${finding.outcome}`);
    super(`quoted spans failed verification: ${named.join(", ")}`);
    this.name = "QuoteCheckError";
    this.findings = findings;
  }
}
