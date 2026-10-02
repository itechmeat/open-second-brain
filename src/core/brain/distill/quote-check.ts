/**
 * The quote check of a distillation: every quoted span in a claim is compared
 * with the evidence the claim rests on. Pure; no I/O.
 *
 * - A claim that cites a block is compared with that block only. A block that
 *   does not resolve is `block-not-found` (a duplicate id `block-ambiguous`),
 *   never a silent fall-back to the whole source: the citation is part of what
 *   the page asserts.
 * - A claim without a block is compared with the whole evidence text and, when
 *   it matches, is `verified-in-source`, a weaker outcome than
 *   `verified-in-block` that never reads as the stronger one.
 * - Evidence with no checkable text (`url-only`, or bytes that are not UTF-8)
 *   verifies nothing.
 *
 * A failed span loses exactly its two quotation marks; its words stay, and the
 * failure is named in the report. Unpaired marks are counted and left alone.
 * Matching runs over {@link normalizeForQuoteComparison} on both sides, so the
 * claim and source bytes themselves are never normalised.
 */

import { indexBlocks, lookupBlock, type BlockIndex } from "./block-resolve.ts";
import type { DistillClaim } from "./claim.ts";
import {
  findQuoteSpans,
  normalizeForQuoteComparison,
  quoteHaystack,
  spanOccursIn,
  unquoteSpans,
  type QuoteHaystack,
  type QuoteSpan,
} from "./quote-spans.ts";
import {
  QUOTE_CHECK_OUTCOME,
  QUOTE_FINDINGS_MAX,
  QUOTE_SPAN_PREVIEW_MAX_CHARS,
  VERIFIED_QUOTE_OUTCOMES,
  type QuoteCheckOutcome,
  type QuoteCheckReport,
  type QuoteFinding,
} from "./quote-verdict.ts";

/** What the claims are checked against. */
export type QuoteEvidence =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "not-text" }
  | { readonly kind: typeof QUOTE_CHECK_OUTCOME.urlOnly };

export interface QuoteCheckInput {
  readonly claims: ReadonlyArray<DistillClaim>;
  readonly evidence: QuoteEvidence;
}

export interface QuoteCheckResult {
  /** The claims as they may be written: every failed span unquoted. */
  readonly claims: ReadonlyArray<DistillClaim>;
  /** `null` when no claim contains a quoted span. */
  readonly report: QuoteCheckReport | null;
}

/** The outcome every span gets when the evidence holds no checkable text. */
const TEXTLESS_OUTCOME: Readonly<
  Record<Exclude<QuoteEvidence["kind"], "text">, QuoteCheckOutcome>
> = Object.freeze({
  "not-text": QUOTE_CHECK_OUTCOME.sourceNotText,
  [QUOTE_CHECK_OUTCOME.urlOnly]: QUOTE_CHECK_OUTCOME.urlOnly,
});

/**
 * The comparison target of one claim: normalised text to search, or an
 * outcome that settles every span of the claim without a search.
 */
type Target =
  | {
      readonly kind: "haystack";
      readonly haystack: QuoteHaystack;
      readonly verified: QuoteCheckOutcome;
      readonly failed: QuoteCheckOutcome;
    }
  | { readonly kind: "settled"; readonly outcome: QuoteCheckOutcome };

/**
 * Builds each claim's target. The whole source is normalised at most once,
 * its blocks are indexed at most once, and each cited block is resolved and
 * normalised at most once however many claims cite it.
 */
function targetResolver(evidence: QuoteEvidence): (claim: DistillClaim) => Target {
  if (evidence.kind !== "text") {
    const settled: Target = { kind: "settled", outcome: TEXTLESS_OUTCOME[evidence.kind] };
    return () => settled;
  }
  let wholeSource: Target | undefined;
  let blocks: BlockIndex | undefined;
  const byBlock = new Map<string, Target>();
  const blockTarget = (blockId: string): Target => {
    blocks ??= indexBlocks(evidence.text);
    const block = lookupBlock(blocks, blockId);
    switch (block.kind) {
      case "found":
        return {
          kind: "haystack",
          haystack: quoteHaystack(normalizeForQuoteComparison(block.text)),
          verified: QUOTE_CHECK_OUTCOME.verifiedInBlock,
          failed: QUOTE_CHECK_OUTCOME.notInBlock,
        };
      case "not-found":
        return { kind: "settled", outcome: QUOTE_CHECK_OUTCOME.blockNotFound };
      case "ambiguous":
        return { kind: "settled", outcome: QUOTE_CHECK_OUTCOME.blockAmbiguous };
    }
  };
  return (claim) => {
    if (claim.block === undefined) {
      wholeSource ??= {
        kind: "haystack",
        haystack: quoteHaystack(normalizeForQuoteComparison(evidence.text)),
        verified: QUOTE_CHECK_OUTCOME.verifiedInSource,
        failed: QUOTE_CHECK_OUTCOME.notInSource,
      };
      return wholeSource;
    }
    let target = byBlock.get(claim.block);
    if (target === undefined) {
      target = blockTarget(claim.block);
      byBlock.set(claim.block, target);
    }
    return target;
  };
}

function spanOutcome(span: QuoteSpan, target: Target): QuoteCheckOutcome {
  if (target.kind === "settled") return target.outcome;
  return spanOccursIn(span.inner, target.haystack) ? target.verified : target.failed;
}

/** The span's own text, cut at the preview cap without splitting a code point. */
function preview(inner: string): string {
  const codePoints = Array.from(inner);
  return codePoints.length <= QUOTE_SPAN_PREVIEW_MAX_CHARS
    ? inner
    : codePoints.slice(0, QUOTE_SPAN_PREVIEW_MAX_CHARS).join("");
}

/**
 * Check every quoted span of every claim against the evidence. Returns the
 * claims as they may be written (failed spans unquoted) and the report, or a
 * `null` report when no claim contains a span.
 */
export function checkClaimQuotes(input: QuoteCheckInput): QuoteCheckResult {
  const targetFor = targetResolver(input.evidence);
  const findings: QuoteFinding[] = [];
  let checked = 0;
  let verifiedInBlock = 0;
  let verifiedInSource = 0;
  let unpaired = 0;

  const claims = input.claims.map((claim, index) => {
    const scan = findQuoteSpans(claim.text);
    unpaired += scan.unpaired;
    if (scan.spans.length === 0) return claim;
    const target = targetFor(claim);
    const failed: QuoteSpan[] = [];
    for (const span of scan.spans) {
      checked++;
      const outcome = spanOutcome(span, target);
      if (!VERIFIED_QUOTE_OUTCOMES.has(outcome)) {
        failed.push(span);
        findings.push({ claim: index, outcome, span: preview(span.inner) });
      } else if (outcome === QUOTE_CHECK_OUTCOME.verifiedInBlock) verifiedInBlock++;
      else verifiedInSource++;
    }
    return failed.length === 0 ? claim : { ...claim, text: unquoteSpans(claim.text, failed) };
  });

  if (checked === 0) return { claims: input.claims, report: null };
  const returned = findings.slice(0, QUOTE_FINDINGS_MAX);
  return {
    claims,
    report: {
      checked,
      verified_in_block: verifiedInBlock,
      verified_in_source: verifiedInSource,
      unquoted: findings.length,
      unpaired,
      findings: returned,
      total: findings.length,
      returned: returned.length,
      truncated: returned.length < findings.length,
    },
  };
}
