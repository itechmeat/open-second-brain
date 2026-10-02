/**
 * The pure quote check: every quoted span in a distilled claim is compared
 * with the block the claim cites (or, without a block, the whole source). A
 * failed span loses its marks and is named; nothing here touches the disk.
 */

import { describe, expect, spyOn, test } from "bun:test";

import type { DistillClaim } from "../../../../src/core/brain/distill/distill-source.ts";
import {
  checkClaimQuotes,
  type QuoteEvidence,
} from "../../../../src/core/brain/distill/quote-check.ts";
import {
  QUOTE_CHECK_OUTCOME,
  QUOTE_FINDINGS_MAX,
  QUOTE_SPAN_PREVIEW_MAX_CHARS,
} from "../../../../src/core/brain/distill/quote-verdict.ts";
import * as blockResolve from "../../../../src/core/brain/distill/block-resolve.ts";

const SOURCE = [
  "# Restaking",
  "",
  "Restaking reuses staked capital to secure additional services. ^abc",
  "",
  "It introduces correlated **slashing** risk across",
  "every    service at once. ^risk",
  "",
  'He said "stake it" twice. ^said',
  "",
  "The first step, then the second step, and the final step. ^steps",
  "",
  "Duplicate one. ^dup",
  "",
  "Duplicate two. ^dup",
  "",
  "Café prices rose.",
].join("\n");

const TEXT: QuoteEvidence = { kind: "text", text: SOURCE };

function one(claim: DistillClaim, evidence: QuoteEvidence = TEXT) {
  return checkClaimQuotes({ claims: [claim], evidence });
}

describe("checkClaimQuotes - block-cited claims", () => {
  test("a verbatim span in a claim citing an existing block verifies in the block, claim unchanged", () => {
    const claim = { text: "The article says “reuses staked capital” plainly.", block: "abc" };
    const res = one(claim);
    expect(res.claims[0]).toEqual(claim);
    expect(res.report).not.toBeNull();
    expect(res.report!.checked).toBe(1);
    expect(res.report!.verified_in_block).toBe(1);
    expect(res.report!.verified_in_source).toBe(0);
    expect(res.report!.unquoted).toBe(0);
    expect(res.report!.findings).toEqual([]);
  });

  test("a span differing in one word fails in the block: marks removed, words kept, finding named", () => {
    const res = one({ text: "The article says “reuses pooled capital” plainly.", block: "abc" });
    expect(res.claims[0]).toEqual({
      text: "The article says reuses pooled capital plainly.",
      block: "abc",
    });
    expect(res.report!.unquoted).toBe(1);
    expect(res.report!.findings).toEqual([
      { claim: 0, outcome: QUOTE_CHECK_OUTCOME.notInBlock, span: "reuses pooled capital" },
    ]);
  });

  test("a span from elsewhere in the source does not verify against the cited block", () => {
    const res = one({ text: "“correlated slashing risk”", block: "abc" });
    expect(res.report!.findings[0]!.outcome).toBe(QUOTE_CHECK_OUTCOME.notInBlock);
  });

  test("a cited block that does not resolve is block-not-found even when the span is elsewhere", () => {
    const res = one({ text: "“reuses staked capital”", block: "zzz" });
    expect(res.report!.findings).toEqual([
      { claim: 0, outcome: QUOTE_CHECK_OUTCOME.blockNotFound, span: "reuses staked capital" },
    ]);
    expect(res.claims[0]!.text).toBe("reuses staked capital");
  });

  test("a block id defined twice is block-ambiguous", () => {
    const res = one({ text: "“Duplicate one.”", block: "dup" });
    expect(res.report!.findings[0]!.outcome).toBe(QUOTE_CHECK_OUTCOME.blockAmbiguous);
  });
});

describe("checkClaimQuotes - claims without a block", () => {
  test("a span found anywhere in the source verifies in the source", () => {
    const res = one({ text: "Risk is “correlated slashing risk” here." });
    expect(res.report!.verified_in_source).toBe(1);
    expect(res.report!.verified_in_block).toBe(0);
    expect(res.report!.findings).toEqual([]);
  });

  test("a span inside a longer word of the source is not-in-source", () => {
    const res = checkClaimQuotes({
      claims: [{ text: 'It is "unsafe" here.' }, { text: 'It is "safe" here.' }],
      evidence: { kind: "text", text: "The method is unsafe." },
    });
    expect(res.report!.verified_in_source).toBe(1);
    expect(res.report!.unquoted).toBe(1);
    expect(res.report!.findings).toEqual([
      { claim: 1, outcome: QUOTE_CHECK_OUTCOME.notInSource, span: "safe" },
    ]);
    expect(res.claims[1]!.text).toBe("It is safe here.");
  });

  test("a span absent from the source is not-in-source", () => {
    const res = one({ text: "Risk is “uncorrelated slashing risk” here." });
    expect(res.report!.findings).toEqual([
      { claim: 0, outcome: QUOTE_CHECK_OUTCOME.notInSource, span: "uncorrelated slashing risk" },
    ]);
    expect(res.claims[0]!.text).toBe("Risk is uncorrelated slashing risk here.");
  });
});

describe("checkClaimQuotes - evidence without checkable text", () => {
  test("url-only evidence: every span is unquoted with the url-only outcome", () => {
    const res = one({ text: "“reuses staked capital” and “anything”" }, { kind: "url-only" });
    expect(res.claims[0]!.text).toBe("reuses staked capital and anything");
    expect(res.report!.findings.map((f) => f.outcome)).toEqual([
      QUOTE_CHECK_OUTCOME.urlOnly,
      QUOTE_CHECK_OUTCOME.urlOnly,
    ]);
    expect(res.report!.unquoted).toBe(2);
  });

  test("not-text evidence: every span is unquoted with source-not-text", () => {
    const res = one({ text: "“reuses staked capital”", block: "abc" }, { kind: "not-text" });
    expect(res.report!.findings[0]!.outcome).toBe(QUOTE_CHECK_OUTCOME.sourceNotText);
  });
});

describe("checkClaimQuotes - matching tolerance", () => {
  test("curly marks inside the span match straight marks in the source", () => {
    const res = one({ text: "«He said “stake it” twice.»", block: "said" });
    expect(res.report!.verified_in_block).toBe(1);
  });

  test("NFD in the claim matches NFC in the source", () => {
    const nfd = "Café prices rose";
    const res = one({ text: `“${nfd}”` });
    expect(res.report!.verified_in_source).toBe(1);
  });

  test("emphasis in the source and collapsed whitespace both verify", () => {
    const res = one({ text: "“correlated slashing risk across every service”", block: "risk" });
    expect(res.report!.verified_in_block).toBe(1);
  });

  test("a case difference does not verify", () => {
    const res = one({ text: "“Reuses staked capital”", block: "abc" });
    expect(res.report!.findings[0]!.outcome).toBe(QUOTE_CHECK_OUTCOME.notInBlock);
  });

  test("an ellipsis span verifies only when its fragments appear in order", () => {
    expect(
      one({ text: "“The first step … the final step.”", block: "steps" }).report!.verified_in_block,
    ).toBe(1);
    expect(
      one({ text: "“the final step … The first step”", block: "steps" }).report!.findings[0]!
        .outcome,
    ).toBe(QUOTE_CHECK_OUTCOME.notInBlock);
  });

  test("a bracketed insertion is not interpreted and fails", () => {
    const res = one({ text: "“reuses [sic] staked capital”", block: "abc" });
    expect(res.report!.findings[0]!.outcome).toBe(QUOTE_CHECK_OUTCOME.notInBlock);
  });
});

describe("checkClaimQuotes - the report", () => {
  test("no spans anywhere: report is null and claims are identical", () => {
    const claims = [{ text: "No quotes here.", block: "abc" }, { text: "Nor here." }];
    const res = checkClaimQuotes({ claims, evidence: TEXT });
    expect(res.report).toBeNull();
    expect(res.claims).toEqual(claims);
  });

  test("30 failing spans are all counted but only the cap is returned", () => {
    const claims = Array.from({ length: 30 }, (_, i) => ({ text: `“missing phrase ${i}”` }));
    const res = checkClaimQuotes({ claims, evidence: TEXT });
    expect(res.report!.unquoted).toBe(30);
    expect(res.report!.total).toBe(30);
    expect(res.report!.returned).toBe(QUOTE_FINDINGS_MAX);
    expect(res.report!.findings).toHaveLength(QUOTE_FINDINGS_MAX);
    expect(res.report!.truncated).toBe(true);
    expect(res.report!.findings[24]!.claim).toBe(24);
  });

  test("a finding's span preview is capped", () => {
    const long = "word ".repeat(60).trim();
    const res = one({ text: `“${long}”` });
    expect(res.report!.findings[0]!.span).toHaveLength(QUOTE_SPAN_PREVIEW_MAX_CHARS);
    expect(long.startsWith(res.report!.findings[0]!.span)).toBe(true);
  });

  test("unpaired marks are counted and leave the claim untouched", () => {
    const claim = { text: 'A 5" screen and “reuses staked capital”.', block: "abc" };
    const res = one(claim);
    expect(res.claims[0]).toEqual(claim);
    expect(res.report!.unpaired).toBe(1);
    expect(res.report!.verified_in_block).toBe(1);
  });

  test("a fabricated quote in CJK running text is checked and unquoted", () => {
    const res = one({ text: "他说「完全捏造」。" });
    expect(res.report!.findings).toEqual([
      { claim: 0, outcome: QUOTE_CHECK_OUTCOME.notInSource, span: "完全捏造" },
    ]);
    expect(res.claims[0]!.text).toBe("他说完全捏造。");
  });

  test("a CRLF source verifies a span that crosses its line break", () => {
    const crlf = { kind: "text", text: SOURCE.replaceAll("\n", "\r\n") } as const;
    const res = one(
      { text: "“correlated slashing risk across every service”", block: "risk" },
      crlf,
    );
    expect(res.report!.verified_in_block).toBe(1);
    const whole = one({ text: "“correlated slashing risk across every service”" }, crlf);
    expect(whole.report!.verified_in_source).toBe(1);
  });

  test("the preview cap never splits an astral code point", () => {
    // An astral LETTER (CJK Extension B): a span must hold letters or digits.
    const res = one({ text: `“${"\u{20000}".repeat(200)}”` });
    expect(res.report!.findings[0]!.span).toBe("\u{20000}".repeat(QUOTE_SPAN_PREVIEW_MAX_CHARS));
  });

  test("findings index the claim they came from", () => {
    const res = checkClaimQuotes({
      claims: [{ text: "“reuses staked capital”", block: "abc" }, { text: "“not there”" }],
      evidence: TEXT,
    });
    expect(res.report!.checked).toBe(2);
    expect(res.report!.findings).toEqual([
      { claim: 1, outcome: QUOTE_CHECK_OUTCOME.notInSource, span: "not there" },
    ]);
    expect(res.report!.total).toBe(1);
    expect(res.report!.returned).toBe(1);
    expect(res.report!.truncated).toBe(false);
  });
});

describe("checkClaimQuotes - one block index per check", () => {
  test("claims citing several blocks segment the source once", () => {
    const index = spyOn(blockResolve, "indexBlocks");
    try {
      const claims = [
        { text: `"reuses staked capital"`, block: "abc" },
        { text: `"stake it"`, block: "said" },
        { text: `"the second step"`, block: "steps" },
      ];
      const res = checkClaimQuotes({ claims, evidence: TEXT });
      expect(res.report!.unquoted).toBe(0);
      expect(index).toHaveBeenCalledTimes(1);
    } finally {
      index.mockRestore();
    }
  });
});
