/**
 * The preregistered eval spec registry (cycle 20261020, card t_4e1681b3,
 * task C1).
 *
 * A spec may only be called preregistered when it names everything the
 * measured decision needs: the fixture reference and its content hash,
 * the seed, the split rule and the frozen membership receipt, the metric,
 * the ceiling, the minimum counted n, and the exact threshold values the
 * use reads when it enforces. A spec missing any element is a
 * construction error, and the committed fixtures must still match their
 * frozen receipts and content hashes.
 */

import { describe, expect, test } from "bun:test";

import {
  DECISION_EVAL_DEV_FRACTION,
  DECISION_EVAL_METRIC,
  DECISION_EVAL_SPECS,
  DECISION_EVAL_SPLIT_RULE,
  decisionEvalSpecHash,
  decisionEvalSpecFor,
  validateDecisionEvalSpec,
  type DecisionEvalSpec,
} from "../../../src/core/decision-model/eval-spec.ts";
import {
  hashOrderSplit,
  loadDecisionEvalFixture,
} from "../../../src/core/decision-model/eval/take.ts";
import {
  RECALL_INJECT_ANY_MIN,
  RECALL_INJECT_NOTE_MIN,
} from "../../../src/core/decision-model/questions.ts";

function completeSpec(): DecisionEvalSpec {
  return {
    version: 1,
    use: "rerank",
    fixture: "tests/fixtures/decision-model/rerank-take.json",
    seed: "cycle-20261020",
    split: { rule: DECISION_EVAL_SPLIT_RULE, dev_fraction: DECISION_EVAL_DEV_FRACTION },
    receipt: { dev: ["rk-002"], counted: ["rk-001", "rk-003"] },
    fixture_hash: "a".repeat(64),
    metric: DECISION_EVAL_METRIC,
    ceiling: 0.05,
    min_counted: 2,
    thresholds: {},
  };
}

describe("validateDecisionEvalSpec", () => {
  test("a complete spec validates", () => {
    expect(() => validateDecisionEvalSpec(completeSpec())).not.toThrow();
  });

  const cases: ReadonlyArray<readonly [string, (s: DecisionEvalSpec) => unknown]> = [
    ["version", (s) => ({ ...s, version: 0 })],
    ["use", (s) => ({ ...s, use: "not-a-use" })],
    ["fixture", (s) => ({ ...s, fixture: "" })],
    ["seed", (s) => ({ ...s, seed: "" })],
    ["split rule", (s) => ({ ...s, split: { rule: "alternation", dev_fraction: 0.3 } })],
    [
      "dev fraction",
      (s) => ({ ...s, split: { rule: DECISION_EVAL_SPLIT_RULE, dev_fraction: 0.5 } }),
    ],
    ["receipt", (s) => ({ ...s, receipt: { dev: [], counted: [] } })],
    ["receipt overlap", (s) => ({ ...s, receipt: { dev: ["a"], counted: ["a"] } })],
    ["fixture hash", (s) => ({ ...s, fixture_hash: "xyz" })],
    ["metric", (s) => ({ ...s, metric: "vibes" })],
    ["ceiling", (s) => ({ ...s, ceiling: 1.5 })],
    ["minimum counted n", (s) => ({ ...s, min_counted: 0 })],
    ["thresholds", (s) => ({ ...s, thresholds: { note_min: Number.NaN } })],
  ];
  for (const [name, break_] of cases) {
    test(`a spec missing or breaking ${name} is a construction error`, () => {
      const broken = break_(completeSpec()) as DecisionEvalSpec;
      expect(() => validateDecisionEvalSpec(broken)).toThrow(new RegExp(name.split(" ")[0]!, "i"));
    });
  }
});

describe("decisionEvalSpecHash", () => {
  test("is stable for the same spec and changes when any registered element moves", () => {
    const spec = completeSpec();
    const hash = decisionEvalSpecHash(spec);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(decisionEvalSpecHash(completeSpec())).toBe(hash);
    const mutations: ReadonlyArray<(s: DecisionEvalSpec) => DecisionEvalSpec> = [
      (s) => ({ ...s, seed: "other" }),
      (s) => ({ ...s, ceiling: 0.06 }),
      (s) => ({ ...s, min_counted: s.min_counted + 1 }),
      (s) => ({ ...s, receipt: { dev: ["rk-009"], counted: s.receipt.counted } }),
      (s) => ({ ...s, fixture_hash: "b".repeat(64) }),
      (s) => ({ ...s, thresholds: { note_min: 0.2 } }),
      (s) => ({ ...s, version: 2 }),
    ];
    for (const mutate of mutations) {
      expect(decisionEvalSpecHash(mutate(spec))).not.toBe(hash);
    }
  });
});

describe("the committed registry", () => {
  test("carries a spec for rerank and recall_inject, each complete", () => {
    for (const use of ["rerank", "recall_inject"] as const) {
      const spec = decisionEvalSpecFor(use);
      expect(spec).not.toBeNull();
      expect(() => validateDecisionEvalSpec(spec!)).not.toThrow();
    }
  });

  test("holds no spec for extract_prefilter, whose zero-regret loop is the report path", () => {
    expect(decisionEvalSpecFor("extract_prefilter")).toBeNull();
  });

  test("each spec's fixture still matches its frozen content hash and receipt", () => {
    for (const spec of Object.values(DECISION_EVAL_SPECS)) {
      const { fixture, contentHash } = loadDecisionEvalFixture(spec.fixture, spec.use);
      const ids = fixture.items.map((item) => item.id);
      const split = hashOrderSplit(spec.seed, ids);
      expect(contentHash).toBe(spec.fixture_hash);
      expect(split.dev).toEqual([...spec.receipt.dev].toSorted());
      expect(split.counted).toEqual([...spec.receipt.counted].toSorted());
    }
  });

  test("each spec's counted take meets its own minimum counted n", () => {
    for (const spec of Object.values(DECISION_EVAL_SPECS)) {
      expect(spec.receipt.counted.length).toBeGreaterThanOrEqual(spec.min_counted);
    }
  });

  test("the recall_inject spec pins the enforce thresholds it is measured against", () => {
    const spec = decisionEvalSpecFor("recall_inject")!;
    expect(spec.thresholds["any_min"]).toBe(RECALL_INJECT_ANY_MIN);
    expect(spec.thresholds["note_min"]).toBe(RECALL_INJECT_NOTE_MIN);
  });

  test("the rerank spec pins the empty threshold set the reorder actually reads", () => {
    const spec = decisionEvalSpecFor("rerank")!;
    expect(spec.thresholds).toEqual({});
  });
});
