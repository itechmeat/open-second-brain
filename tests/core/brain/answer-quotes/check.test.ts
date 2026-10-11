/**
 * The answer-time quote check: every quoted span of a host answer is
 * compared with the evidence the turn actually had - the note the span
 * cites, or the notes the injection ledger says entered context. Pure;
 * no I/O.
 *
 * The false-positive bar is the distill lane's own suite
 * (`tests/core/brain/distill/quote-check.test.ts`): every span that suite
 * verifies must verify here under the same evidence, because both lanes
 * run the same distill helpers (`findQuoteSpans`, `normalizeForQuoteComparison`,
 * `quoteHaystack`, `spanOccursIn`) imported in place.
 */

import { describe, expect, test } from "bun:test";

import {
  ANSWER_QUOTE_VERDICT,
  ANSWER_QUOTE_VERDICTS,
  checkAnswerQuotes,
  isAnswerQuoteVerdict,
  mergeAnswerQuoteVerdicts,
  type AnswerQuoteEvidence,
  type AnswerQuoteVerdict,
} from "../../../../src/core/brain/answer-quotes/check.ts";
import { QUOTE_SPAN_PREVIEW_MAX_CHARS } from "../../../../src/core/brain/distill/quote-verdict.ts";
import { findQuoteSpans } from "../../../../src/core/brain/distill/quote-spans.ts";

/**
 * The distill suite's source, verbatim, so its verified spans are the
 * mirror cases below under identical evidence.
 */
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

const TEXT: AnswerQuoteEvidence = { kind: "text", text: SOURCE, truncated: false };

function verdictOf(answer: string, evidence: AnswerQuoteEvidence = TEXT): string {
  const spans = findQuoteSpans(answer).spans.map((span) => span.inner);
  expect(spans.length).toBe(1);
  return checkAnswerQuotes({ spans, evidence }).outcomes[0]!.verdict;
}

describe("ANSWER_QUOTE_VERDICT vocabulary", () => {
  test("carries exactly the five pinned verdicts, in order", () => {
    expect(ANSWER_QUOTE_VERDICT).toEqual({
      verified: "verified",
      notInNote: "not-in-note",
      sourceTruncated: "source-truncated",
      noteUnavailable: "note-unavailable",
      notText: "not-text",
    });
    expect(ANSWER_QUOTE_VERDICTS).toEqual([
      "verified",
      "not-in-note",
      "source-truncated",
      "note-unavailable",
      "not-text",
    ]);
  });

  test("the object is frozen and the guard accepts only its members", () => {
    expect(Object.isFrozen(ANSWER_QUOTE_VERDICT)).toBe(true);
    expect(Object.isFrozen(ANSWER_QUOTE_VERDICTS)).toBe(true);
    for (const member of ANSWER_QUOTE_VERDICTS) {
      expect(isAnswerQuoteVerdict(member)).toBe(true);
    }
    for (const outsider of ["", "verified ", "Verified", "unverified", null, undefined, 42, {}]) {
      expect(isAnswerQuoteVerdict(outsider)).toBe(false);
    }
  });
});

describe("checkAnswerQuotes - the verdict table", () => {
  test("a span in the note text is verified", () => {
    expect(verdictOf("The note says “reuses staked capital” plainly.")).toBe(
      ANSWER_QUOTE_VERDICT.verified,
    );
  });

  test("a span absent from the note text is not-in-note", () => {
    expect(verdictOf("The note says “reuses pooled capital” plainly.")).toBe(
      ANSWER_QUOTE_VERDICT.notInNote,
    );
  });

  test("truncated text evidence: a hit verifies, a miss is source-truncated", () => {
    // `text` IS the available prefix - the part of the note that reached
    // context. The tail the pack cut away holds "Café prices rose."
    const truncated: AnswerQuoteEvidence = {
      kind: "text",
      text: SOURCE.split("\n").slice(0, 8).join("\n"),
      truncated: true,
    };
    expect(verdictOf("The note says “reuses staked capital”.", truncated)).toBe(
      ANSWER_QUOTE_VERDICT.verified,
    );
    expect(verdictOf("The note says “Café prices rose.”", truncated)).toBe(
      ANSWER_QUOTE_VERDICT.sourceTruncated,
    );
  });

  test("unavailable evidence is note-unavailable, whatever the span says", () => {
    expect(verdictOf("“anything at all”", { kind: "unavailable" })).toBe(
      ANSWER_QUOTE_VERDICT.noteUnavailable,
    );
    expect(verdictOf("“reuses staked capital”", { kind: "unavailable" })).toBe(
      ANSWER_QUOTE_VERDICT.noteUnavailable,
    );
  });

  test("non-text evidence is not-text", () => {
    expect(verdictOf("“reuses staked capital”", { kind: "not-text" })).toBe(
      ANSWER_QUOTE_VERDICT.notText,
    );
  });
});

describe("checkAnswerQuotes - the report shape", () => {
  test("outcomes carry the input index, the preview-capped span and the verdict, in input order", () => {
    const long = "word ".repeat(60).trim();
    const res = checkAnswerQuotes({
      spans: ["reuses staked capital", long, "reuses pooled capital"],
      evidence: TEXT,
    });
    expect(res.verified).toBe(1);
    expect(res.unverified).toBe(2);
    expect(res.outcomes).toEqual([
      { index: 0, span: "reuses staked capital", verdict: "verified" },
      { index: 1, span: long.slice(0, QUOTE_SPAN_PREVIEW_MAX_CHARS), verdict: "not-in-note" },
      { index: 2, span: "reuses pooled capital", verdict: "not-in-note" },
    ]);
  });

  test("no spans: an empty report with zero counters", () => {
    expect(checkAnswerQuotes({ spans: [], evidence: TEXT })).toEqual({
      outcomes: [],
      verified: 0,
      unverified: 0,
    });
  });
});

describe("checkAnswerQuotes - the distill suite's verified spans verify here", () => {
  // Mirror cases from tests/core/brain/distill/quote-check.test.ts: each
  // span that suite verifies must verify under the same evidence.
  test("a verbatim span verifies", () => {
    expect(verdictOf("“reuses staked capital”", TEXT)).toBe(ANSWER_QUOTE_VERDICT.verified);
  });

  test("curly marks inside the span match straight marks in the source", () => {
    expect(verdictOf("«He said “stake it” twice.»", TEXT)).toBe(ANSWER_QUOTE_VERDICT.verified);
  });

  test("NFD in the answer matches NFC in the source", () => {
    const nfd = "Café prices rose".normalize("NFD");
    expect(verdictOf(`“${nfd}”`, TEXT)).toBe(ANSWER_QUOTE_VERDICT.verified);
  });

  test("emphasis in the source and collapsed whitespace both verify", () => {
    expect(verdictOf("“correlated slashing risk across every service”", TEXT)).toBe(
      ANSWER_QUOTE_VERDICT.verified,
    );
  });

  test("an ellipsis span verifies when its fragments appear in order", () => {
    expect(verdictOf("“The first step … the final step.”", TEXT)).toBe(
      ANSWER_QUOTE_VERDICT.verified,
    );
  });

  test("a CRLF source verifies a span that crosses its line break", () => {
    const crlf: AnswerQuoteEvidence = {
      kind: "text",
      text: SOURCE.replaceAll("\n", "\r\n"),
      truncated: false,
    };
    expect(verdictOf("“correlated slashing risk across every service”", crlf)).toBe(
      ANSWER_QUOTE_VERDICT.verified,
    );
  });

  test("a span inside a longer word of the source does not verify", () => {
    const unsafe: AnswerQuoteEvidence = {
      kind: "text",
      text: "The method is unsafe.",
      truncated: false,
    };
    expect(verdictOf("It is “safe” here.", unsafe)).toBe(ANSWER_QUOTE_VERDICT.notInNote);
  });

  test("a case difference does not verify", () => {
    expect(verdictOf("“Reuses staked capital”", TEXT)).toBe(ANSWER_QUOTE_VERDICT.notInNote);
  });

  test("a fabricated quote in CJK running text does not verify", () => {
    expect(verdictOf("他说「完全捏造」。", TEXT)).toBe(ANSWER_QUOTE_VERDICT.notInNote);
  });
});

describe("checkAnswerQuotes - the degradation matrix, table-style", () => {
  // The matrix end-to-end: each evidence state with a span that occurs
  // and one that does not. Degradation never upgrades a verdict - a
  // truncated source can under-deliver evidence but never acquits a
  // span, and "we could not check" is a finding, not an all-clear.
  const tail = SOURCE.split("\n").slice(0, 8).join("\n");
  const table: ReadonlyArray<
    readonly [
      string,
      AnswerQuoteEvidence,
      readonly [string, AnswerQuoteVerdict],
      readonly [string, AnswerQuoteVerdict],
    ]
  > = [
    [
      "complete text",
      { kind: "text", text: SOURCE, truncated: false },
      ["reuses staked capital", ANSWER_QUOTE_VERDICT.verified],
      ["reuses pooled capital", ANSWER_QUOTE_VERDICT.notInNote],
    ],
    [
      "truncated prefix",
      { kind: "text", text: tail, truncated: true },
      ["reuses staked capital", ANSWER_QUOTE_VERDICT.verified],
      ["Café prices", ANSWER_QUOTE_VERDICT.sourceTruncated],
    ],
    [
      "unavailable",
      { kind: "unavailable" },
      ["reuses staked capital", ANSWER_QUOTE_VERDICT.noteUnavailable],
      ["nothing of this", ANSWER_QUOTE_VERDICT.noteUnavailable],
    ],
    [
      "not-text",
      { kind: "not-text" },
      ["reuses staked capital", ANSWER_QUOTE_VERDICT.notText],
      ["nothing of this", ANSWER_QUOTE_VERDICT.notText],
    ],
  ];
  for (const [name, evidence, hit, miss] of table) {
    test(`${name}: a hit is ${hit[1]}, a miss is ${miss[1]}`, () => {
      const res = checkAnswerQuotes({ spans: [hit[0], miss[0]], evidence });
      expect(res.outcomes.map((o) => o.verdict)).toEqual([hit[1], miss[1]]);
      expect(res.verified).toBe(hit[1] === ANSWER_QUOTE_VERDICT.verified ? 1 : 0);
      expect(res.unverified).toBe(hit[1] === ANSWER_QUOTE_VERDICT.verified ? 1 : 2);
    });
  }
});

describe("mergeAnswerQuoteVerdicts - the no-citation candidate ladder", () => {
  test("a hit anywhere verifies", () => {
    expect(
      mergeAnswerQuoteVerdicts([
        ANSWER_QUOTE_VERDICT.notInNote,
        ANSWER_QUOTE_VERDICT.verified,
        ANSWER_QUOTE_VERDICT.sourceTruncated,
      ]),
    ).toBe(ANSWER_QUOTE_VERDICT.verified);
  });

  test("no candidates at all is note-unavailable - nothing to check is a finding, not an all-clear", () => {
    expect(mergeAnswerQuoteVerdicts([])).toBe(ANSWER_QUOTE_VERDICT.noteUnavailable);
  });

  test("any truncated miss outranks readable misses and unreachable evidence", () => {
    expect(
      mergeAnswerQuoteVerdicts([ANSWER_QUOTE_VERDICT.notInNote, ANSWER_QUOTE_VERDICT.notText]),
    ).toBe(ANSWER_QUOTE_VERDICT.notText);
    expect(
      mergeAnswerQuoteVerdicts([
        ANSWER_QUOTE_VERDICT.notInNote,
        ANSWER_QUOTE_VERDICT.noteUnavailable,
      ]),
    ).toBe(ANSWER_QUOTE_VERDICT.noteUnavailable);
    expect(
      mergeAnswerQuoteVerdicts([
        ANSWER_QUOTE_VERDICT.notInNote,
        ANSWER_QUOTE_VERDICT.noteUnavailable,
        ANSWER_QUOTE_VERDICT.notText,
        ANSWER_QUOTE_VERDICT.sourceTruncated,
      ]),
    ).toBe(ANSWER_QUOTE_VERDICT.sourceTruncated);
  });

  test("readable misses only are not-in-note", () => {
    expect(mergeAnswerQuoteVerdicts([ANSWER_QUOTE_VERDICT.notInNote])).toBe(
      ANSWER_QUOTE_VERDICT.notInNote,
    );
    expect(
      mergeAnswerQuoteVerdicts([ANSWER_QUOTE_VERDICT.notInNote, ANSWER_QUOTE_VERDICT.notInNote]),
    ).toBe(ANSWER_QUOTE_VERDICT.notInNote);
  });
});
