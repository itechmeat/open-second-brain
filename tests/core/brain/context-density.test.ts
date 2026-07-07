import { describe, expect, test } from "bun:test";

import {
  countWikilinks,
  densityScore,
  signalWeight,
} from "../../../src/core/brain/context-density.ts";
import { EPISTEMIC_STATUS } from "../../../src/core/brain/provenance/epistemic.ts";

describe("countWikilinks", () => {
  test("counts internal [[...]] markers, ignoring plain text", () => {
    expect(countWikilinks("see [[a]] and [[b/c]] here")).toBe(2);
    expect(countWikilinks("no links at all")).toBe(0);
  });

  test("is language-agnostic (no wordlist) - counts markers in any script", () => {
    expect(countWikilinks("[[テスト]] и [[тема]]")).toBe(2);
  });
});

describe("signalWeight", () => {
  test("sums evidence grounding, connectivity, and epistemic weight", () => {
    // 2 evidence refs (x2) + 1 body link (x1) + observed (3) = 4 + 1 + 3 = 8
    expect(
      signalWeight({
        body: "grounded rule referencing [[premise]]",
        evidenceRefs: ["[[sig-1]]", "[[sig-2]]"],
        epistemic: EPISTEMIC_STATUS.observed,
      }),
    ).toBe(8);
  });

  test("a bare, contested page carries no signal", () => {
    expect(
      signalWeight({
        body: "plain contested body",
        evidenceRefs: [],
        epistemic: EPISTEMIC_STATUS.unknown,
      }),
    ).toBe(0);
  });

  test("a grounded observed fact outweighs an equally-linked hypothesis", () => {
    const observed = signalWeight({
      body: "x",
      evidenceRefs: [],
      epistemic: EPISTEMIC_STATUS.observed,
    });
    const hypothesis = signalWeight({
      body: "x",
      evidenceRefs: [],
      epistemic: EPISTEMIC_STATUS.hypothesis,
    });
    expect(observed).toBeGreaterThan(hypothesis);
  });
});

describe("densityScore", () => {
  test("is signal per estimated token - denser wins for equal signal, fewer tokens", () => {
    const source = {
      body: "[[a]]",
      evidenceRefs: ["[[sig]]"],
      epistemic: EPISTEMIC_STATUS.observed,
    };
    expect(densityScore(source, 4)).toBeGreaterThan(densityScore(source, 40));
  });

  test("non-positive or non-finite tokens yield 0 (cannot displace a real page)", () => {
    const source = {
      body: "[[a]]",
      evidenceRefs: ["[[sig]]"],
      epistemic: EPISTEMIC_STATUS.observed,
    };
    expect(densityScore(source, 0)).toBe(0);
    expect(densityScore(source, -5)).toBe(0);
    expect(densityScore(source, Number.NaN)).toBe(0);
  });

  test("deterministic - identical inputs yield the identical score", () => {
    const source = {
      body: "[[a]] [[b]]",
      evidenceRefs: ["[[sig]]"],
      epistemic: EPISTEMIC_STATUS.derived,
    };
    expect(densityScore(source, 10)).toBe(densityScore(source, 10));
  });
});
