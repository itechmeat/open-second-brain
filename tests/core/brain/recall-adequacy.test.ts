import { expect, test } from "bun:test";

import {
  assessRecallAdequacy,
  DEFAULT_RECALL_ADEQUACY_THRESHOLDS,
} from "../../../src/core/brain/recall-adequacy.ts";

/**
 * Three usable scores, so `minResults` is never what a case turns on -
 * and all three deliberately BELOW every threshold in this file.
 *
 * The scores in these fixtures used to echo the match quality beside
 * them, and a fixture where the two agree cannot tell this function from
 * the substitution it exists to have removed: reverting the verdict to
 * `topScore >=` left ten of these thirteen cases green. Every case below
 * now puts the score on the opposite side of the boundary from the
 * quality, so the substitution fails on each of them by name.
 */
const THREE_SCORES: ReadonlyArray<number> = [0.28, 0.2, 0.1];

test("strong coverage is sufficient and proceeds", () => {
  const verdict = assessRecallAdequacy({ matchQuality: 0.82, scores: THREE_SCORES });
  expect(verdict.level).toBe("sufficient");
  expect(verdict.action).toBe("proceed");
  expect(verdict.escalate).toBe(false);
  expect(verdict.matchQuality).toBeCloseTo(0.82);
  expect(verdict.resultCount).toBe(3);
  // Every score is under the `weak` floor, so nothing but the coverage
  // could have produced `sufficient`.
  expect(verdict.topScore).toBeLessThan(DEFAULT_RECALL_ADEQUACY_THRESHOLDS.weak);
});

test("middling coverage is weak and triggers re-recall", () => {
  const verdict = assessRecallAdequacy({ matchQuality: 0.42, scores: [0.9, 0.85] });
  expect(verdict.level).toBe("weak");
  expect(verdict.action).toBe("re_recall");
  expect(verdict.escalate).toBe(false);
});

test("poor coverage is insufficient, abstains, and escalates", () => {
  const verdict = assessRecallAdequacy({ matchQuality: 0.12, scores: [0.9, 0.85] });
  expect(verdict.level).toBe("insufficient");
  expect(verdict.action).toBe("abstain");
  expect(verdict.escalate).toBe(true);
});

test("the level is decided by coverage, never by the top score", () => {
  // The regression this unit exists to prevent. Both attempts carry the
  // score the shipped keyword lane pins its top row at, so under the old
  // score-driven rule both graded `sufficient` and `weak` was unreachable.
  const pinnedTopRow: ReadonlyArray<number> = [0.6, 0.3];
  const weak = assessRecallAdequacy({ matchQuality: 0.31, scores: pinnedTopRow });
  const strong = assessRecallAdequacy({ matchQuality: 0.95, scores: pinnedTopRow });
  expect(weak.level).toBe("weak");
  expect(strong.level).toBe("sufficient");
  expect(weak.topScore).toBe(strong.topScore);
});

test("no results is insufficient with zero scores and escalates", () => {
  // Coverage can be high while nothing survived the filter stack, and the
  // verdict still has to abstain: there is no material to ground on.
  const verdict = assessRecallAdequacy({ matchQuality: 0.9, scores: [] });
  expect(verdict.level).toBe("insufficient");
  expect(verdict.action).toBe("abstain");
  expect(verdict.escalate).toBe(true);
  expect(verdict.topScore).toBe(0);
  expect(verdict.meanScore).toBe(0);
  expect(verdict.resultCount).toBe(0);
});

test("min_results downgrades strong-but-lonely coverage to weak/re-recall", () => {
  const verdict = assessRecallAdequacy({ matchQuality: 0.9, scores: [0.1] }, { minResults: 2 });
  expect(verdict.level).toBe("weak");
  expect(verdict.action).toBe("re_recall");
  expect(verdict.escalate).toBe(false);
});

test("custom thresholds move the boundaries", () => {
  // Raise the sufficient floor so 0.7 coverage is no longer sufficient.
  const verdict = assessRecallAdequacy(
    // Scores above the raised floor, coverage below it: the substitution
    // would grade this `sufficient`.
    { matchQuality: 0.7, scores: [0.95, 0.9] },
    { sufficient: 0.8, weak: 0.5 },
  );
  expect(verdict.level).toBe("weak");
});

test("non-finite scores are ignored; the count still reflects the rest", () => {
  const verdict = assessRecallAdequacy({
    matchQuality: 0.75,
    scores: [Number.NaN, Infinity, 0.1],
  });
  expect(verdict.resultCount).toBe(1);
  expect(verdict.level).toBe("sufficient");
  expect(verdict.topScore).toBeCloseTo(0.1);
});

test("negative scores clamp to zero", () => {
  const verdict = assessRecallAdequacy({ matchQuality: 0.05, scores: [-0.3, 0.95] });
  expect(verdict.topScore).toBeCloseTo(0.95);
  // A confident-looking top row over material that covers almost none of
  // the query: insufficient, and the score had no say.
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
  const attempt = { matchQuality: 0.5, scores: [0.5] };
  expect(() => assessRecallAdequacy(attempt, { sufficient: 0.2, weak: 0.5 })).toThrow();
  expect(() => assessRecallAdequacy(attempt, { sufficient: 1.5 })).toThrow();
  expect(() => assessRecallAdequacy(attempt, { minResults: 0 })).toThrow();
});

test("a match quality outside [0,1] throws rather than clamping", () => {
  // Clamping would turn a broken measurement into a confident
  // `insufficient` indistinguishable from a genuine one.
  expect(() => assessRecallAdequacy({ matchQuality: 1.4, scores: [0.5] })).toThrow(/matchQuality/u);
  expect(() => assessRecallAdequacy({ matchQuality: -0.1, scores: [0.5] })).toThrow(
    /matchQuality/u,
  );
  expect(() => assessRecallAdequacy({ matchQuality: Number.NaN, scores: [0.5] })).toThrow(
    /matchQuality/u,
  );
});

test("verdict carries a human-readable reason naming the quantity it read", () => {
  const sufficient = assessRecallAdequacy({ matchQuality: 0.9, scores: [0.9] });
  expect(sufficient.reason).toContain("sufficient");
  expect(sufficient.reason).toContain("match quality");
  expect(assessRecallAdequacy({ matchQuality: 0, scores: [] }).reason.length).toBeGreaterThan(0);
});
