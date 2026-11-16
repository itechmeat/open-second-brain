/**
 * The decide pass's share of a caller's deadline (design D10, D20): a
 * front door whose whole call runs under one deadline hands the pass
 * what is left of it, never more than the pass's own budget.
 */

import { expect, test } from "bun:test";

import { decideBudgetWithin } from "../../../src/core/topics/decide-auto.ts";
import { DECIDE_PASS_BUDGET_MS } from "../../../src/core/topics/decide-shared.ts";

test("no deadline leaves the pass its own budget", () => {
  expect(decideBudgetWithin(null, 5_000)).toBeUndefined();
});

test("a deadline with more left than the pass's budget leaves the budget as it is", () => {
  expect(decideBudgetWithin(DECIDE_PASS_BUDGET_MS + 10_000, 1_000)).toBe(DECIDE_PASS_BUDGET_MS);
});

test("a deadline with less left gives the pass only what is left", () => {
  expect(decideBudgetWithin(5_000, 1_000)).toBe(4_000);
});

test("a spent deadline gives the pass nothing", () => {
  expect(decideBudgetWithin(1_000, 2_000)).toBe(0);
});
