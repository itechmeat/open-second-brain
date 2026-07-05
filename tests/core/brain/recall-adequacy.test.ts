import { expect, test } from "bun:test";

import {
  assessRecallAdequacy,
  DEFAULT_RECALL_ADEQUACY_THRESHOLDS,
} from "../../../src/core/brain/recall-adequacy.ts";

test("a strong top hit is sufficient and proceeds", () => {
  const verdict = assessRecallAdequacy([0.82, 0.5, 0.31]);
  expect(verdict.level).toBe("sufficient");
  expect(verdict.action).toBe("proceed");
  expect(verdict.escalate).toBe(false);
  expect(verdict.topScore).toBeCloseTo(0.82);
  expect(verdict.resultCount).toBe(3);
});

test("a middling top hit is weak and triggers re-recall", () => {
  const verdict = assessRecallAdequacy([0.42, 0.3]);
  expect(verdict.level).toBe("weak");
  expect(verdict.action).toBe("re_recall");
  expect(verdict.escalate).toBe(false);
});

test("a poor top hit is insufficient, abstains, and escalates", () => {
  const verdict = assessRecallAdequacy([0.12, 0.08]);
  expect(verdict.level).toBe("insufficient");
  expect(verdict.action).toBe("abstain");
  expect(verdict.escalate).toBe(true);
});

test("no results is insufficient with zero scores and escalates", () => {
  const verdict = assessRecallAdequacy([]);
  expect(verdict.level).toBe("insufficient");
  expect(verdict.action).toBe("abstain");
  expect(verdict.escalate).toBe(true);
  expect(verdict.topScore).toBe(0);
  expect(verdict.meanScore).toBe(0);
  expect(verdict.resultCount).toBe(0);
});

test("min_results downgrades a strong-but-lonely hit to weak/re-recall", () => {
  const verdict = assessRecallAdequacy([0.9], { minResults: 2 });
  expect(verdict.level).toBe("weak");
  expect(verdict.action).toBe("re_recall");
  expect(verdict.escalate).toBe(false);
});

test("custom thresholds move the boundaries", () => {
  // Raise the sufficient floor so 0.7 is no longer sufficient.
  const verdict = assessRecallAdequacy([0.7, 0.4], { sufficient: 0.8, weak: 0.5 });
  expect(verdict.level).toBe("weak");
});

test("non-finite scores are ignored; the rest still classify", () => {
  const verdict = assessRecallAdequacy([Number.NaN, Infinity, 0.75]);
  expect(verdict.resultCount).toBe(1);
  expect(verdict.level).toBe("sufficient");
  expect(verdict.topScore).toBeCloseTo(0.75);
});

test("negative scores clamp to zero", () => {
  const verdict = assessRecallAdequacy([-0.3, 0.05]);
  expect(verdict.topScore).toBeCloseTo(0.05);
  expect(verdict.level).toBe("insufficient");
});

test("defaults are the documented 0.6 / 0.3 / 1", () => {
  expect(DEFAULT_RECALL_ADEQUACY_THRESHOLDS).toEqual({
    sufficient: 0.6,
    weak: 0.3,
    minResults: 1,
  });
});

test("invalid thresholds throw", () => {
  expect(() => assessRecallAdequacy([0.5], { sufficient: 0.2, weak: 0.5 })).toThrow();
  expect(() => assessRecallAdequacy([0.5], { sufficient: 1.5 })).toThrow();
  expect(() => assessRecallAdequacy([0.5], { minResults: 0 })).toThrow();
});

test("verdict carries a human-readable reason", () => {
  expect(assessRecallAdequacy([0.9]).reason).toContain("sufficient");
  expect(assessRecallAdequacy([]).reason.length).toBeGreaterThan(0);
});
