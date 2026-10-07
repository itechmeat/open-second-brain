import { describe, expect, test } from "bun:test";

import { READ_ALL_REFS } from "../../../src/core/brain/near-duplicate.ts";
import {
  planRetireSiblings,
  RETIRE_SIBLING_TRIGGER_REASONS,
  retireSiblingPool,
} from "../../../src/core/brain/retire-siblings.ts";
import { BRAIN_RETIRED_REASON, type BrainRetiredReason } from "../../../src/core/brain/types.ts";

const RULE = "always run the formatter before every commit in this repository";
const PARAPHRASE = "always run the formatter before each commit in this repository";
const UNRELATED = "prefer tabs over spaces inside every makefile you touch";

const hideSibling = (ref: string) => ref !== "pref-paraphrase";
const hideRetiring = (ref: string) => ref !== "pref-old";
const NO_GATE = { readable: READ_ALL_REFS, gated: new Set<string>() };

function retiring(reason: BrainRetiredReason, id = "pref-old") {
  return [{ id, principle: RULE, reason }];
}

const ACTIVE = [
  { id: "pref-paraphrase", principle: PARAPHRASE },
  { id: "pref-unrelated", principle: UNRELATED },
];

describe("planRetireSiblings", () => {
  test("only the four context-driven reasons nominate", () => {
    expect([...RETIRE_SIBLING_TRIGGER_REASONS].toSorted()).toEqual([
      "quarantine-violated",
      "rebutted",
      "superseded-by-context",
      "user-rejected",
    ]);
    for (const reason of RETIRE_SIBLING_TRIGGER_REASONS) {
      const out = planRetireSiblings(ACTIVE, retiring(reason), NO_GATE);
      expect(out).toEqual([
        { retiring_id: "pref-old", sibling_id: "pref-paraphrase", score: 0.818, method: "lexical" },
      ]);
    }
  });

  test("decay reasons and merged-into never nominate", () => {
    for (const reason of [
      BRAIN_RETIRED_REASON.staleNoEvidence,
      BRAIN_RETIRED_REASON.expiredUnconfirmed,
      BRAIN_RETIRED_REASON.mergedInto,
    ]) {
      expect(planRetireSiblings(ACTIVE, retiring(reason), NO_GATE)).toEqual([]);
    }
  });

  test("siblings of a gated id are dropped", () => {
    const out = planRetireSiblings(ACTIVE, retiring(BRAIN_RETIRED_REASON.rebutted), {
      readable: READ_ALL_REFS,
      gated: new Set(["pref-old"]),
    });
    expect(out).toEqual([]);
  });

  test("an unreadable sibling or retiring id is never listed", () => {
    const reason = BRAIN_RETIRED_REASON.rebutted;
    const gated = new Set<string>();
    expect(planRetireSiblings(ACTIVE, retiring(reason), { readable: hideSibling, gated })).toEqual(
      [],
    );
    expect(planRetireSiblings(ACTIVE, retiring(reason), { readable: hideRetiring, gated })).toEqual(
      [],
    );
  });

  test("merge-resolved pages are excluded from the pool", () => {
    const pool = retireSiblingPool([
      { id: "pref-paraphrase", principle: PARAPHRASE, merged_into: "pref-canonical" },
      { id: "pref-live", principle: PARAPHRASE },
    ]);
    expect(pool).toEqual([{ id: "pref-live", principle: PARAPHRASE }]);
    const out = planRetireSiblings(pool, retiring(BRAIN_RETIRED_REASON.rebutted), NO_GATE);
    expect(out.map((s) => s.sibling_id)).toEqual(["pref-live"]);
  });

  test("preferences from other topics and scopes are compared", () => {
    // The planner takes no topic or scope: the whole active set is one pool.
    const active = [{ id: "pref-other-topic-slug", principle: PARAPHRASE }];
    const out = planRetireSiblings(active, retiring(BRAIN_RETIRED_REASON.rebutted), NO_GATE);
    expect(out.map((s) => s.sibling_id)).toEqual(["pref-other-topic-slug"]);
  });

  test("the retiring set is never its own sibling and siblings are not cascaded", () => {
    const secondHop = `${PARAPHRASE} today`;
    const active = [
      { id: "pref-old", principle: RULE },
      { id: "pref-paraphrase", principle: PARAPHRASE },
      { id: "pref-second-hop", principle: `each ${secondHop} quickly` },
    ];
    const out = planRetireSiblings(active, retiring(BRAIN_RETIRED_REASON.rebutted), NO_GATE);
    expect(out.map((s) => s.sibling_id)).toEqual(["pref-paraphrase"]);
  });

  test("another retiring preference is not offered as a sibling", () => {
    const both = [
      { id: "pref-old", principle: RULE, reason: BRAIN_RETIRED_REASON.rebutted },
      {
        id: "pref-paraphrase",
        principle: PARAPHRASE,
        reason: BRAIN_RETIRED_REASON.staleNoEvidence,
      },
    ];
    expect(planRetireSiblings(ACTIVE, both, NO_GATE)).toEqual([]);
  });

  test("the output is stable across runs and input orders", () => {
    const active = [
      { id: "pref-b", principle: PARAPHRASE },
      { id: "pref-a", principle: PARAPHRASE },
      { id: "pref-c", principle: RULE },
    ];
    const retires = [
      { id: "pref-y", principle: RULE, reason: BRAIN_RETIRED_REASON.rebutted },
      { id: "pref-x", principle: RULE, reason: BRAIN_RETIRED_REASON.userRejected },
    ];
    const first = planRetireSiblings(active, retires, NO_GATE);
    const again = planRetireSiblings(active.toReversed(), retires.toReversed(), NO_GATE);
    expect(again).toEqual(first);
    expect(first.map((s) => `${s.retiring_id}>${s.sibling_id}`)).toEqual([
      "pref-x>pref-c",
      "pref-x>pref-a",
      "pref-x>pref-b",
      "pref-y>pref-c",
      "pref-y>pref-a",
      "pref-y>pref-b",
    ]);
  });
});
