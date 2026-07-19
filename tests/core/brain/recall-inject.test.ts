import { describe, expect, test } from "bun:test";

import {
  decideRecallInject,
  RECALL_INJECT_CONFIDENCE_FLOOR,
  RECALL_INJECT_MAX_CHARS,
  RECALL_INJECT_MAX_NOTES,
  type RecallCandidate,
  type RecallResultSet,
  type RecallRetriever,
} from "../../../src/core/brain/recall-inject.ts";

function candidate(overrides: Partial<RecallCandidate> = {}): RecallCandidate {
  return {
    path: "Brain/notes/a.md",
    title: "Alpha note",
    score: 0.9,
    searchType: "hybrid",
    startLine: 1,
    endLine: 4,
    ...overrides,
  };
}

function retrieverOf(set: RecallResultSet): RecallRetriever {
  return async () => set;
}

describe("decideRecallInject (A2 / t_2ce46130)", () => {
  test("abstains on an empty prompt without calling the retriever", async () => {
    let called = false;
    const decision = await decideRecallInject("   ", async () => {
      called = true;
      return { candidates: [], total: 0 };
    });
    expect(decision).toEqual({ kind: "abstain", reason: "empty_prompt", topScore: 0 });
    expect(called).toBe(false);
  });

  test("abstains when the retriever returns no matches", async () => {
    const decision = await decideRecallInject(
      "how do receipts work",
      retrieverOf({ candidates: [], total: 0 }),
    );
    expect(decision).toEqual({ kind: "abstain", reason: "no_matches", topScore: 0 });
  });

  test("abstains below the confidence floor", async () => {
    const weak = RECALL_INJECT_CONFIDENCE_FLOOR - 0.05;
    const decision = await decideRecallInject(
      "receipts",
      retrieverOf({ candidates: [candidate({ score: weak })], total: 1 }),
    );
    expect(decision).toMatchObject({ kind: "abstain", reason: "below_floor" });
  });

  test("injects a bounded brief above the floor", async () => {
    const decision = await decideRecallInject(
      "receipts",
      retrieverOf({
        candidates: [
          candidate({ path: "Brain/a.md", title: "Alpha", score: 0.92 }),
          candidate({ path: "Brain/b.md", title: "Beta", score: 0.71 }),
        ],
        total: 2,
      }),
    );
    expect(decision.kind).toBe("inject");
    if (decision.kind !== "inject") return;
    expect(decision.noteCount).toBe(2);
    expect(decision.topScore).toBeCloseTo(0.92);
    expect(decision.brief).toContain("Alpha");
    expect(decision.brief).toContain("Beta");
    expect(decision.brief.length).toBeLessThanOrEqual(RECALL_INJECT_MAX_CHARS);
  });

  test("caps the number of notes at the max-notes constant", async () => {
    const many = Array.from({ length: RECALL_INJECT_MAX_NOTES + 3 }, (_, i) =>
      candidate({ path: `Brain/n${i}.md`, title: `Note ${i}`, score: 0.9 - i * 0.01 }),
    );
    const decision = await decideRecallInject(
      "receipts",
      retrieverOf({ candidates: many, total: many.length }),
    );
    expect(decision.kind).toBe("inject");
    if (decision.kind !== "inject") return;
    expect(decision.noteCount).toBe(RECALL_INJECT_MAX_NOTES);
  });

  test("respects a tight char budget by dropping notes that do not fit", async () => {
    const many = Array.from({ length: 4 }, (_, i) =>
      candidate({
        path: `Brain/really-long-note-path-number-${i}.md`,
        title: `A reasonably long note title number ${i}`,
        score: 0.9,
      }),
    );
    const decision = await decideRecallInject(
      "receipts",
      retrieverOf({ candidates: many, total: 4 }),
      {
        maxChars: 240,
      },
    );
    expect(decision.kind).toBe("inject");
    if (decision.kind !== "inject") return;
    expect(decision.brief.length).toBeLessThanOrEqual(240);
    expect(decision.noteCount).toBeLessThan(4);
  });

  test("returns an error decision when the retriever throws", async () => {
    const decision = await decideRecallInject("receipts", async () => {
      throw new Error("index unreadable");
    });
    expect(decision.kind).toBe("error");
    if (decision.kind !== "error") return;
    expect(decision.reason).toContain("index unreadable");
  });

  test("returns a timeout error decision when the retriever exceeds the time budget", async () => {
    const hang: RecallRetriever = () => new Promise<RecallResultSet>(() => {});
    const decision = await decideRecallInject("receipts", hang, { timeBudgetMs: 20 });
    expect(decision).toEqual({ kind: "error", reason: "timeout" });
  });
});
