/**
 * The quote-check outcome vocabulary, the report shape constants and the
 * named refusal a strict distillation throws.
 */

import { describe, expect, test } from "bun:test";

import { PAGE_LINT_MAX_FINDINGS } from "../../../../src/core/brain/page-lint.ts";
import { CAPTURE_SCOPE } from "../../../../src/core/brain/provenance/capture-scope.ts";
import {
  QUOTE_CHECK_OUTCOME,
  QUOTE_FINDINGS_MAX,
  QUOTE_SPAN_PREVIEW_MAX_CHARS,
  QUOTE_UNVERIFIED_CODE,
  QUOTES_UNQUOTED_KEY,
  QUOTES_VERIFIED_KEY,
  QuoteCheckError,
  type QuoteFinding,
  VERIFIED_QUOTE_OUTCOMES,
} from "../../../../src/core/brain/distill/quote-verdict.ts";

describe("QUOTE_CHECK_OUTCOME vocabulary", () => {
  // Frozenness, membership and guard agreement are owned by
  // tests/core/architecture/verdict-vocabulary-census.test.ts; this pins the
  // wire spellings only.
  test("the outcome tokens are the pinned wire spellings", () => {
    expect(QUOTE_CHECK_OUTCOME).toEqual({
      verifiedInBlock: "verified-in-block",
      verifiedInSource: "verified-in-source",
      notInBlock: "not-in-block",
      notInSource: "not-in-source",
      blockNotFound: "block-not-found",
      blockAmbiguous: "block-ambiguous",
      sourceNotText: "source-not-text",
      urlOnly: "url-only",
    });
  });

  test("a span with no local bytes is named by the one capture-scope token", () => {
    expect(QUOTE_CHECK_OUTCOME.urlOnly).toBe(CAPTURE_SCOPE.urlOnly);
  });

  test("only the two verified outcomes count as verified", () => {
    expect([...VERIFIED_QUOTE_OUTCOMES].toSorted()).toEqual([
      "verified-in-block",
      "verified-in-source",
    ]);
  });

  test("the caps and keys are the pinned values", () => {
    expect(QUOTE_FINDINGS_MAX).toBe(PAGE_LINT_MAX_FINDINGS);
    expect(QUOTE_SPAN_PREVIEW_MAX_CHARS).toBe(120);
    expect(QUOTES_VERIFIED_KEY).toBe("quotes_verified");
    expect(QUOTES_UNQUOTED_KEY).toBe("quotes_unquoted");
  });
});

describe("QuoteCheckError", () => {
  const findings: ReadonlyArray<QuoteFinding> = [
    { claim: 0, outcome: QUOTE_CHECK_OUTCOME.notInBlock, span: "secret paraphrase" },
    { claim: 3, outcome: QUOTE_CHECK_OUTCOME.urlOnly, span: "another span" },
  ];

  test("carries the registered code and names claims and outcomes only", () => {
    const error = new QuoteCheckError(findings);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("QuoteCheckError");
    expect(error.code).toBe(QUOTE_UNVERIFIED_CODE);
    expect(QUOTE_UNVERIFIED_CODE).toBe("quote_unverified");
    expect(error.message).toBe(
      "quoted spans failed verification: claim 0: not-in-block, claim 3: url-only",
    );
    expect(error.message).not.toContain("secret");
    expect(error.findings).toEqual(findings);
  });
});
