/**
 * Thread topics - pure facet detection and the adaptive topic budget
 * (recall-quality wave, Lane B / t_2c2a883c).
 *
 * Facets are derived from the thread itself (distinct mined entity keys
 * and depth-1 summary clusters), and the topic budget is the corpus-
 * shaped clamp: budget = clamp(distinct facets, floor 12, cap 16). The
 * diagnostics report the realized topic count honestly - a 3-facet
 * thread floors at 12 and says 3 were realized.
 */

import { describe, expect, test } from "bun:test";

import {
  TOPIC_BUDGET_CAP,
  TOPIC_BUDGET_FLOOR,
  clampTopicBudget,
  detectThreadFacets,
  resolveTopicBudget,
} from "../../../src/core/brain/thread-topics.ts";

describe("adaptive topic budget", () => {
  test("the floor and cap are exported constants, floor below cap", () => {
    expect(TOPIC_BUDGET_FLOOR).toBe(12);
    expect(TOPIC_BUDGET_CAP).toBe(16);
  });

  test("budget = clamp(distinct facets, 12, 16) with realized never above facets", () => {
    expect(resolveTopicBudget(40)).toEqual({ budget: 16, realized: 16 });
    expect(resolveTopicBudget(3)).toEqual({ budget: 12, realized: 3 });
    expect(resolveTopicBudget(14)).toEqual({ budget: 14, realized: 14 });
    expect(resolveTopicBudget(0)).toEqual({ budget: 12, realized: 0 });
    expect(resolveTopicBudget(12)).toEqual({ budget: 12, realized: 12 });
    expect(resolveTopicBudget(16)).toEqual({ budget: 16, realized: 16 });
    expect(resolveTopicBudget(100)).toEqual({ budget: 16, realized: 16 });
  });

  test("clampTopicBudget agrees with resolveTopicBudget's budget", () => {
    for (const facets of [0, 1, 3, 11, 12, 13, 16, 17, 40]) {
      expect(clampTopicBudget(facets)).toBe(resolveTopicBudget(facets).budget);
    }
  });

  test("pure and deterministic across repeated calls", () => {
    const first = resolveTopicBudget(3);
    const second = resolveTopicBudget(3);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });
});

describe("facet detection", () => {
  const TURNS = ["t1", "t2", "t3", "t4", "t5"];

  test("mined mentions group into family-scoped facets over in-scope turns", () => {
    const facets = detectThreadFacets({
      turns: TURNS,
      mentions: [
        { family: "symbol", key: "SessionStore", turnId: "t1" },
        { family: "symbol", key: "SessionStore", turnId: "t3" },
        { family: "symbol", key: "sessionstore", turnId: "t2" },
        { family: "path", key: "~/src/store.ts", turnId: "t4" },
      ],
      clusters: [],
    });
    expect(facets.map((f) => f.key)).toEqual([
      "mined:symbol:SessionStore",
      "mined:symbol:sessionstore",
      "mined:path:~/src/store.ts",
    ]);
    expect(facets[0]).toMatchObject({
      origin: "mined",
      needle: "SessionStore",
      turnIds: ["t1", "t3"],
    });
  });

  test("clusters become membership facets holding their in-scope turns", () => {
    const facets = detectThreadFacets({
      turns: TURNS,
      mentions: [],
      clusters: [
        { id: "node-a", turnIds: ["t1", "t2"] },
        { id: "node-b", turnIds: ["t3", "t9"] },
      ],
    });
    expect(facets.map((f) => f.key)).toEqual(["cluster:node-a", "cluster:node-b"]);
    expect(facets[1]!.turnIds).toEqual(["t3"]);
    expect(facets[1]!.needle).toBeNull();
  });

  test("facets order by their chronologically first establishing turn", () => {
    const facets = detectThreadFacets({
      turns: TURNS,
      mentions: [{ family: "symbol", key: "LateKey", turnId: "t4" }],
      clusters: [{ id: "node-early", turnIds: ["t1", "t2"] }],
    });
    expect(facets.map((f) => f.key)).toEqual(["cluster:node-early", "mined:symbol:LateKey"]);
  });

  test("facet ties break by code unit, not locale collation", () => {
    // "B" precedes "a" by code unit; a locale-aware collation would put
    // "a" first, making the facet order host-dependent.
    const facets = detectThreadFacets({
      turns: ["t1"],
      mentions: [
        { family: "symbol", key: "a", turnId: "t1" },
        { family: "symbol", key: "B", turnId: "t1" },
      ],
      clusters: [],
    });
    expect(facets.map((f) => f.key)).toEqual(["mined:symbol:B", "mined:symbol:a"]);
  });

  test("a facet with no in-scope establishing turn is not detected", () => {
    const facets = detectThreadFacets({
      turns: TURNS,
      mentions: [{ family: "url", key: "https://example.test/x", turnId: "t99" }],
      clusters: [{ id: "node-empty", turnIds: ["t42"] }],
    });
    expect(facets).toEqual([]);
  });

  test("deterministic across repeated calls on the same input", () => {
    const input = {
      turns: TURNS,
      mentions: [{ family: "symbol", key: "SessionStore", turnId: "t1" }],
      clusters: [{ id: "node-a", turnIds: ["t2"] }],
    };
    expect(detectThreadFacets(input)).toEqual(detectThreadFacets(input));
  });
});
