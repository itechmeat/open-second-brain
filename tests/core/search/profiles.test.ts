/**
 * Selectable recall profiles (Recall & Working-Memory Quality Suite,
 * t_98c39dd6 profile-half). A profile name expands to a knob tuple over
 * the SAME bounded axes the self-tuning grid ranges over, so profiles
 * and self-tuning stay coherent. Unknown names fail loud; no silent
 * default.
 */

import { expect, test } from "bun:test";

import {
  RECALL_PROFILE_NAMES,
  isRecallProfileName,
  resolveRecallProfile,
} from "../../../src/core/search/profiles.ts";
import {
  TUNING_POOL_MULTIPLIERS,
  TUNING_TRAVERSAL_DEPTHS,
} from "../../../src/core/search/tuning.ts";
import { SearchError } from "../../../src/core/search/types.ts";

test("the three profiles resolve to distinct knob tuples", () => {
  const fast = resolveRecallProfile("fast");
  const balanced = resolveRecallProfile("balanced");
  const thorough = resolveRecallProfile("thorough");
  // fast is the narrowest, thorough the widest, across every axis.
  expect(fast.poolMultiplier).toBeLessThanOrEqual(balanced.poolMultiplier);
  expect(balanced.poolMultiplier).toBeLessThanOrEqual(thorough.poolMultiplier);
  expect(fast.traversalDepth).toBeLessThanOrEqual(thorough.traversalDepth);
  expect(fast.expansion).toBe(false);
  expect(thorough.expansion).toBe(true);
  // The three are genuinely different points.
  const serialized = new Set([fast, balanced, thorough].map((p) => JSON.stringify(p)));
  expect(serialized.size).toBe(3);
});

test("every profile stays inside the self-tuning grid bounds", () => {
  for (const name of RECALL_PROFILE_NAMES) {
    const p = resolveRecallProfile(name);
    expect(TUNING_POOL_MULTIPLIERS).toContain(p.poolMultiplier);
    expect(TUNING_TRAVERSAL_DEPTHS).toContain(p.traversalDepth);
    expect(typeof p.learnedWeights).toBe("boolean");
    expect(typeof p.expansion).toBe("boolean");
  }
});

test("an unknown profile name fails loud with a typed SearchError", () => {
  expect(() => resolveRecallProfile("turbo")).toThrow(SearchError);
  try {
    resolveRecallProfile("turbo");
  } catch (e) {
    expect(e).toBeInstanceOf(SearchError);
    expect((e as SearchError).code).toBe("INVALID_INPUT");
    // The message lists the valid names so the caller can recover.
    for (const name of RECALL_PROFILE_NAMES) {
      expect((e as SearchError).message).toContain(name);
    }
  }
});

test("isRecallProfileName narrows only the three known names", () => {
  expect(isRecallProfileName("fast")).toBe(true);
  expect(isRecallProfileName("balanced")).toBe(true);
  expect(isRecallProfileName("thorough")).toBe(true);
  expect(isRecallProfileName("")).toBe(false);
  expect(isRecallProfileName("FAST")).toBe(false);
  expect(isRecallProfileName(null)).toBe(false);
  expect(isRecallProfileName(42)).toBe(false);
});

test("the resolved tuple is frozen so callers cannot mutate the shared table", () => {
  const p = resolveRecallProfile("balanced");
  expect(Object.isFrozen(p)).toBe(true);
});
