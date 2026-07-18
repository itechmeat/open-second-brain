import { test, expect } from "bun:test";

import {
  CHAIN_DECAY_LOW_RECALL_MAX_APPLIED,
  CHAIN_DECAY_STALE_DAYS,
  effectiveStaleThresholdDays,
  isLowRecallSupersededAncestor,
  isSuperseded,
  preferChainTips,
} from "../../../src/core/brain/inject-governor.ts";

test("preferChainTips keeps only chain tips by default", () => {
  const cands = [
    { id: "a", supersededBy: "[[b]]" },
    { id: "b", supersededBy: "[[c]]" },
    { id: "c", supersededBy: null },
  ];
  const res = preferChainTips(cands);
  expect(res.kept.map((c) => c.id)).toEqual(["c"]);
  expect(res.dropped.map((c) => c.id).toSorted()).toEqual(["a", "b"]);
});

test("preferChainTips with historical keeps the whole chain", () => {
  const cands = [
    { id: "a", supersededBy: "[[b]]" },
    { id: "b", supersededBy: null },
  ];
  const res = preferChainTips(cands, { historical: true });
  expect(res.kept.map((c) => c.id)).toEqual(["a", "b"]);
  expect(res.dropped).toEqual([]);
});

test("preferChainTips leaves non-chain memories byte-identical", () => {
  const cands = [
    { id: "x", supersededBy: null },
    { id: "y", supersededBy: undefined },
    { id: "z" },
  ];
  const res = preferChainTips(cands);
  expect(res.kept.map((c) => c.id)).toEqual(["x", "y", "z"]);
  expect(res.dropped).toEqual([]);
});

test("isSuperseded detects a non-empty successor pointer", () => {
  expect(isSuperseded({ supersededBy: "[[b]]" })).toBe(true);
  expect(isSuperseded({ supersededBy: "" })).toBe(false);
  expect(isSuperseded({ supersededBy: null })).toBe(false);
  expect(isSuperseded({})).toBe(false);
});

test("isLowRecallSupersededAncestor requires both supersession and low recall", () => {
  expect(isLowRecallSupersededAncestor({ supersededBy: "[[b]]", appliedCount: 0 })).toBe(true);
  // High recall: not accelerated even though superseded.
  expect(isLowRecallSupersededAncestor({ supersededBy: "[[b]]", appliedCount: 5 })).toBe(false);
  // Not superseded: never accelerated.
  expect(isLowRecallSupersededAncestor({ supersededBy: null, appliedCount: 0 })).toBe(false);
  expect(CHAIN_DECAY_LOW_RECALL_MAX_APPLIED).toBeGreaterThanOrEqual(0);
});

test("effectiveStaleThresholdDays accelerates but is never slower than the normal window", () => {
  expect(effectiveStaleThresholdDays(true, 90)).toBe(CHAIN_DECAY_STALE_DAYS);
  expect(effectiveStaleThresholdDays(false, 90)).toBe(90);
  // Never slower than the normal window when the normal window is short.
  expect(effectiveStaleThresholdDays(true, 3)).toBe(3);
});
