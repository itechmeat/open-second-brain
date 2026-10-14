/**
 * Packing-policy vocabulary and the pure lane-allocation primitive
 * (recall-lane-latency wave).
 *
 * The premise of one shared reading budget over which a packing order
 * reorders is false across surfaces - pages and the facts-side brief
 * are budgeted by two separate surfaces - so the wave first makes the
 * two candidate populations CORRELATABLE through one pure allocation
 * primitive beside `applyCharBudget`, then lets a caller opt into an
 * order over it. Claims pinned here:
 *
 *   1. `PACKING_POLICIES` is a frozen two-member tuple and
 *      `isPackingPolicy` narrows exactly like the queryMode guard.
 *   2. `retired_first` lets the pages lane claim the shared budget
 *      before the facts lane fills the remainder; `facts_first` claims
 *      facts-side first (the delivery order the two surfaces already
 *      observe today).
 *   3. A single populated lane is an identity pass: the whole claimable
 *      budget goes to the lane that exists.
 *   4. A lane whose demand exceeds its remainder drops its overflow and
 *      never drags the other lane's allocation negative.
 *   5. Total conservation: both lane allocations plus the reserved
 *      charge equal the total, exactly.
 *   6. Per-lane native caps (chars, note counts) stay lane-internal:
 *      the primitive allocates whole entries in tokens and never splits
 *      or trims one.
 */

import { describe, expect, test } from "bun:test";

import {
  allocateRecallBudget,
  isPackingPolicy,
  PACKING_POLICIES,
  type RecallBudgetEntry,
} from "../../../src/core/brain/recall-budget.ts";

const page = (item: string, tokens: number): RecallBudgetEntry<string> => ({ item, tokens });

describe("PACKING_POLICIES vocabulary", () => {
  test("the tuple is frozen and ordered facts_first then retired_first", () => {
    expect([...PACKING_POLICIES]).toEqual(["facts_first", "retired_first"]);
    expect(Object.isFrozen(PACKING_POLICIES)).toBe(true);
  });

  test("isPackingPolicy accepts exactly the tuple members", () => {
    for (const policy of PACKING_POLICIES) {
      expect(isPackingPolicy(policy)).toBe(true);
    }
  });

  test("isPackingPolicy narrows like the queryMode guard: unknown, case and type refuse", () => {
    expect(isPackingPolicy("budget_policy")).toBe(false);
    expect(isPackingPolicy("FACTS_FIRST")).toBe(false);
    expect(isPackingPolicy("facts-first")).toBe(false);
    expect(isPackingPolicy("")).toBe(false);
    expect(isPackingPolicy(undefined)).toBe(false);
    expect(isPackingPolicy(null)).toBe(false);
    expect(isPackingPolicy(1)).toBe(false);
    expect(isPackingPolicy({})).toBe(false);
    expect(isPackingPolicy(["facts_first"])).toBe(false);
  });
});

describe("allocateRecallBudget", () => {
  test("retired_first lets the pages lane claim before the facts lane fills the remainder", () => {
    // Total 10: pages demand 7, facts demand 6. Pages claim first and fit
    // whole; facts keep only what the 3-token remainder holds.
    const r = allocateRecallBudget<string, string>(
      10,
      [page("p1", 4), page("p2", 3)],
      [page("f1", 4), page("f2", 2)],
      "retired_first",
    );
    expect(r.pages.allocation).toBe(7);
    expect(r.pages.kept).toEqual(["p1", "p2"]);
    expect(r.pages.spent).toBe(7);
    expect(r.facts.allocation).toBe(3);
    expect(r.facts.kept).toEqual(["f2"]);
    expect(r.facts.dropped).toEqual(["f1"]);
    expect(r.facts.spent).toBe(2);
    expect(r.pages.allocation + r.facts.allocation).toBe(10);
  });

  test("facts_first claims facts-side first and pages take the remainder", () => {
    const r = allocateRecallBudget<string, string>(
      10,
      [page("p1", 4), page("p2", 3)],
      [page("f1", 4), page("f2", 2)],
      "facts_first",
    );
    expect(r.facts.allocation).toBe(6);
    expect(r.facts.kept).toEqual(["f1", "f2"]);
    expect(r.facts.spent).toBe(6);
    expect(r.pages.allocation).toBe(4);
    expect(r.pages.kept).toEqual(["p1"]);
    expect(r.pages.dropped).toEqual(["p2"]);
    expect(r.pages.spent).toBe(4);
    expect(r.facts.allocation + r.pages.allocation).toBe(10);
  });

  test("the policy decides the winner over the same demand", () => {
    const pages = [page("p-big", 8)];
    const facts = [page("f-big", 8)];
    const retiredFirst = allocateRecallBudget(10, pages, facts, "retired_first");
    const factsFirst = allocateRecallBudget(10, pages, facts, "facts_first");
    expect(retiredFirst.pages.kept).toEqual(["p-big"]);
    expect(retiredFirst.facts.dropped).toEqual(["f-big"]);
    expect(factsFirst.facts.kept).toEqual(["f-big"]);
    expect(factsFirst.pages.dropped).toEqual(["p-big"]);
  });

  test("an empty pages lane hands the whole claimable budget to facts", () => {
    for (const policy of PACKING_POLICIES) {
      const r = allocateRecallBudget<string, string>(
        10,
        [],
        [page("f1", 6), page("f2", 4)],
        policy,
      );
      expect(r.pages.allocation).toBe(0);
      expect(r.pages.kept).toEqual([]);
      expect(r.facts.allocation).toBe(10);
      expect(r.facts.kept).toEqual(["f1", "f2"]);
      expect(r.facts.spent).toBe(10);
    }
  });

  test("an empty facts lane hands the whole claimable budget to pages", () => {
    for (const policy of PACKING_POLICIES) {
      const r = allocateRecallBudget<string, string>(
        10,
        [page("p1", 6), page("p2", 4)],
        [],
        policy,
      );
      expect(r.facts.allocation).toBe(0);
      expect(r.facts.kept).toEqual([]);
      expect(r.pages.allocation).toBe(10);
      expect(r.pages.kept).toEqual(["p1", "p2"]);
    }
  });

  test("facts_first with only facts populated is an identity pass", () => {
    const facts = [page("f1", 3), page("f2", 3)];
    const alone = allocateRecallBudget<string, string>(8, [], facts, "facts_first");
    expect(alone.facts.kept).toEqual(["f1", "f2"]);
    expect(alone.facts.spent).toBe(6);
    // The lane holds what it claimed; the untouched remainder is the
    // empty pages lane's window, and the books still balance.
    expect(alone.facts.allocation).toBe(6);
    expect(alone.pages.allocation).toBe(2);
    expect(alone.facts.allocation + alone.pages.allocation).toBe(8);
  });

  test("facts exceeding the remainder drop overflow and spend exactly the remainder", () => {
    // Pages claim 9 of 10; the facts lane fits exactly one more token.
    const r = allocateRecallBudget<string, string>(
      10,
      [page("p1", 9)],
      [page("f1", 5), page("f2", 1)],
      "retired_first",
    );
    expect(r.pages.spent).toBe(9);
    expect(r.facts.allocation).toBe(1);
    expect(r.facts.dropped).toEqual(["f1"]);
    expect(r.facts.kept).toEqual(["f2"]);
    expect(r.facts.spent).toBe(1);
  });

  test("a reserved charge is paid before either lane claims and conservation holds", () => {
    const r = allocateRecallBudget<string, string>(
      20,
      [page("p1", 5), page("p2", 9)],
      [page("f1", 4), page("f2", 4)],
      "retired_first",
      6,
    );
    expect(r.reservedTokens).toBe(6);
    expect(r.pages.allocation).toBe(14);
    expect(r.pages.kept).toEqual(["p1", "p2"]);
    expect(r.facts.allocation).toBe(0);
    expect(r.facts.dropped).toEqual(["f1", "f2"]);
    // Total conservation, reserved charge included.
    expect(r.pages.allocation + r.facts.allocation + r.reservedTokens).toBe(20);
    expect(r.pages.spent + r.facts.spent + r.reservedTokens).toBeLessThanOrEqual(20);
  });

  test("a reserved charge at or over the total leaves both lanes nothing", () => {
    const r = allocateRecallBudget<string, string>(
      5,
      [page("p1", 1)],
      [page("f1", 1)],
      "retired_first",
      7,
    );
    expect(r.pages.allocation).toBe(0);
    expect(r.facts.allocation).toBe(0);
    expect(r.pages.kept).toEqual([]);
    expect(r.facts.kept).toEqual([]);
  });

  test("a lane entry that cannot fit whole is dropped, never split or trimmed", () => {
    // Native per-entry caps (chars, note counts) stay lane-internal: the
    // primitive sees whole-entry token costs and drops the overflow.
    const r = allocateRecallBudget<string, string>(
      4,
      [page("huge", 100), page("small", 2)],
      [page("f1", 1)],
      "retired_first",
    );
    expect(r.pages.dropped).toEqual(["huge"]);
    expect(r.pages.kept).toEqual(["small"]);
    expect(r.pages.spent).toBe(2);
  });

  test("a smaller later entry still fits after a larger overflow is dropped", () => {
    const r = allocateRecallBudget<string, string>(
      6,
      [page("a", 4), page("big", 5), page("c", 2)],
      [page("f1", 0)],
      "retired_first",
    );
    expect(r.pages.kept).toEqual(["a", "c"]);
    expect(r.pages.dropped).toEqual(["big"]);
  });

  test("an entry with a non-finite or negative cost is dropped, never charged", () => {
    const r = allocateRecallBudget<string, string>(
      6,
      [page("nan", Number.NaN), page("neg", -3), page("ok", 2)],
      [],
      "retired_first",
    );
    expect(r.pages.dropped).toEqual(["nan", "neg"]);
    expect(r.pages.kept).toEqual(["ok"]);
    expect(r.pages.spent).toBe(2);
  });

  test("a zero-token entry always fits and spends nothing", () => {
    const r = allocateRecallBudget<string, string>(
      2,
      [page("p1", 2), page("free", 0)],
      [],
      "retired_first",
    );
    expect(r.pages.kept).toEqual(["p1", "free"]);
    expect(r.pages.spent).toBe(2);
  });

  test("a non-finite or non-positive total is a fail-closed empty allocation", () => {
    for (const total of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = allocateRecallBudget<string, string>(
        total,
        [page("p1", 1)],
        [page("f1", 1)],
        "retired_first",
        1,
      );
      expect(r.pages.allocation).toBe(0);
      expect(r.facts.allocation).toBe(0);
      expect(r.pages.kept).toEqual([]);
      expect(r.facts.kept).toEqual([]);
      expect(r.reservedTokens).toBe(0);
    }
  });

  test("the allocation is deterministic and frozen for identical inputs", () => {
    const pages = [page("p1", 3), page("p2", 3)];
    const facts = [page("f1", 2)];
    const a = allocateRecallBudget(8, pages, facts, "retired_first", 1);
    const b = allocateRecallBudget(8, pages, facts, "retired_first", 1);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.pages)).toBe(true);
    expect(Object.isFrozen(a.facts)).toBe(true);
    expect(Object.isFrozen(a.pages.kept)).toBe(true);
    expect(Object.isFrozen(a.facts.dropped)).toBe(true);
  });

  test("the policy rides the result by name", () => {
    const r = allocateRecallBudget(4, [], [], "facts_first");
    expect(r.policy).toBe("facts_first");
    expect(r.totalTokens).toBe(4);
  });
});
