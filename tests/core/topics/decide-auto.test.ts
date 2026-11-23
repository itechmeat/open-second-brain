/**
 * The model work's share of a caller's deadline (design D10, D20; change
 * `dream-closed-questions` D4): a front door whose whole call runs under
 * one deadline hands the producer and the executor what is left of it,
 * never more than the model budget.
 */

import { expect, test } from "bun:test";

import { decideBudgetWithin, DREAM_MODEL_BUDGET_MS } from "../../../src/core/topics/decide-auto.ts";

test("no deadline leaves the pass its own budget", () => {
  expect(decideBudgetWithin(null, 5_000)).toBeUndefined();
});

test("a deadline with more left than the pass's budget leaves the budget as it is", () => {
  // What is left of the deadline; the front door takes the smaller of it
  // and its own budget (`dream.model_budget_ms`).
  const left = decideBudgetWithin(DREAM_MODEL_BUDGET_MS + 10_000, 1_000)!;
  expect(left).toBe(DREAM_MODEL_BUDGET_MS + 9_000);
  expect(Math.min(DREAM_MODEL_BUDGET_MS, left)).toBe(DREAM_MODEL_BUDGET_MS);
});

test("a deadline with less left gives the pass only what is left", () => {
  expect(decideBudgetWithin(5_000, 1_000)).toBe(4_000);
});

test("a spent deadline gives the pass nothing", () => {
  expect(decideBudgetWithin(1_000, 2_000)).toBe(0);
});
