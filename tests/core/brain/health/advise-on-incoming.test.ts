/**
 * A4 (t_f79b4fe0): write-time conflict advisory - pure helper.
 *
 * `adviseOnIncoming` compares an incoming feedback principle against
 * already-confirmed same-scope preferences using the shared similarity
 * kernel (`tokenise` + `jaccard`) and the health-pass default threshold.
 * It is advisory only: it surfaces conflicting preference ids and their
 * similarity, it never blocks a write. The bucketing rules mirror
 * `detectContradictions` - only same-scope confirmed preferences count,
 * and an unscoped incoming signal compares against the unscoped bucket.
 */

import { describe, expect, test } from "bun:test";

import { BRAIN_PREFERENCE_STATUS } from "../../../../src/core/brain/types.ts";
import {
  adviseOnIncoming,
  type PreferenceForContradiction,
} from "../../../../src/core/brain/health/contradiction.ts";

function pref(
  over: Partial<PreferenceForContradiction> & Pick<PreferenceForContradiction, "id" | "principle">,
): PreferenceForContradiction {
  return {
    scope: "coding",
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    evidenced_by: [],
    ...over,
  };
}

describe("adviseOnIncoming", () => {
  test("flags a same-scope high-overlap confirmed preference", () => {
    const advisory = adviseOnIncoming("always indent source with tabs not spaces", "coding", [
      pref({ id: "pref-tabs", principle: "always indent source with tabs not spaces" }),
      pref({ id: "pref-unrelated", principle: "write commit messages in imperative voice" }),
    ]);
    expect(advisory).not.toBeNull();
    expect(advisory!.scope).toBe("coding");
    expect(advisory!.conflicts.length).toBe(1);
    expect(advisory!.conflicts[0]!.prefId).toBe("pref-tabs");
    expect(advisory!.conflicts[0]!.jaccard).toBeGreaterThanOrEqual(0.5);
  });

  test("returns null for a non-conflicting (low-overlap) incoming principle", () => {
    const advisory = adviseOnIncoming("prefer semantic HTML elements over generic divs", "coding", [
      pref({ id: "pref-tabs", principle: "always indent source with tabs not spaces" }),
    ]);
    expect(advisory).toBeNull();
  });

  test("does not fire for a near-duplicate in a DIFFERENT scope", () => {
    const advisory = adviseOnIncoming("always indent source with tabs not spaces", "writing", [
      pref({
        id: "pref-tabs",
        scope: "coding",
        principle: "always indent source with tabs not spaces",
      }),
    ]);
    expect(advisory).toBeNull();
  });

  test("unscoped incoming compares against the unscoped bucket only", () => {
    const advisory = adviseOnIncoming("always indent source with tabs not spaces", undefined, [
      pref({
        id: "pref-unscoped",
        scope: undefined,
        principle: "always indent source with tabs not spaces",
      }),
      pref({
        id: "pref-scoped",
        scope: "coding",
        principle: "always indent source with tabs not spaces",
      }),
    ]);
    expect(advisory).not.toBeNull();
    expect(advisory!.scope).toBeNull();
    expect(advisory!.conflicts.map((c) => c.prefId)).toEqual(["pref-unscoped"]);
  });

  test("ignores non-confirmed preferences", () => {
    const advisory = adviseOnIncoming("always indent source with tabs not spaces", "coding", [
      pref({
        id: "pref-unconfirmed",
        status: BRAIN_PREFERENCE_STATUS.unconfirmed,
        principle: "always indent source with tabs not spaces",
      }),
    ]);
    expect(advisory).toBeNull();
  });

  test("sorts multiple conflicts by descending similarity then id", () => {
    const advisory = adviseOnIncoming(
      "always indent source code with tabs not spaces here",
      "coding",
      [
        pref({
          id: "pref-close",
          principle: "always indent source code with tabs not spaces here",
        }),
        pref({ id: "pref-loose", principle: "always indent source code with tabs everywhere" }),
      ],
    );
    expect(advisory).not.toBeNull();
    expect(advisory!.conflicts[0]!.prefId).toBe("pref-close");
    expect(advisory!.conflicts[0]!.jaccard).toBeGreaterThanOrEqual(advisory!.conflicts[1]!.jaccard);
  });
});
