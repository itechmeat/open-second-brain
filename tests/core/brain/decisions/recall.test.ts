import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EMPTY_DECISION_RECALL_STATE,
  governDecisionRecall,
  matchRatedDecisions,
  type DecisionRecallState,
} from "../../../../src/core/brain/inject-governor.ts";
import { recallRatedDecisions } from "../../../../src/core/brain/decisions/recall.ts";
import { recordDecision } from "../../../../src/core/brain/decisions/record.ts";

describe("matchRatedDecisions (deterministic, language-agnostic)", () => {
  const candidates = [
    { id: "decision-adopt-bun", rating: 5, text: "Adopt Bun runtime for the CLI" },
    { id: "decision-use-postgres", rating: 3, text: "Use Postgres for the ledger store" },
  ];

  test("matches on structural token overlap and ranks by overlap then rating", () => {
    const hits = matchRatedDecisions("should we adopt Bun runtime for the server", candidates);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.id).toBe("decision-adopt-bun");
  });

  test("no match below the overlap floor", () => {
    expect(matchRatedDecisions("totally unrelated weather report", candidates)).toEqual([]);
  });

  test("empty prompt never matches", () => {
    expect(matchRatedDecisions("", candidates)).toEqual([]);
  });
});

describe("governDecisionRecall caps and spacing", () => {
  const matches = [
    { id: "a", rating: 5, overlap: 0.9 },
    { id: "b", rating: 4, overlap: 0.8 },
  ];

  test("disabled when maxPerSession is null (byte-identical)", () => {
    const res = governDecisionRecall({
      matches,
      state: EMPTY_DECISION_RECALL_STATE,
      turn: 0,
      config: { maxPerSession: null, minSpacingTurns: 0 },
    });
    expect(res.surface).toBeNull();
    expect(res.state).toBe(EMPTY_DECISION_RECALL_STATE);
  });

  test("surfaces the top match and advances state", () => {
    const res = governDecisionRecall({
      matches,
      state: EMPTY_DECISION_RECALL_STATE,
      turn: 0,
      config: { maxPerSession: 2, minSpacingTurns: 0 },
    });
    expect(res.surface!.id).toBe("a");
    expect(res.state.count).toBe(1);
    expect(res.state.surfacedIds).toEqual(["a"]);
  });

  test("per-session cap prevents further recalls", () => {
    const state: DecisionRecallState = { surfacedIds: ["a"], lastTurn: 0, count: 1 };
    const res = governDecisionRecall({
      matches,
      state,
      turn: 5,
      config: { maxPerSession: 1, minSpacingTurns: 0 },
    });
    expect(res.surface).toBeNull();
  });

  test("spacing prevents a recall too soon after the last", () => {
    const state: DecisionRecallState = { surfacedIds: ["a"], lastTurn: 3, count: 1 };
    const gated = governDecisionRecall({
      matches,
      state,
      turn: 4,
      config: { maxPerSession: 5, minSpacingTurns: 3 },
    });
    expect(gated.surface).toBeNull();

    const allowed = governDecisionRecall({
      matches,
      state,
      turn: 6,
      config: { maxPerSession: 5, minSpacingTurns: 3 },
    });
    expect(allowed.surface!.id).toBe("b"); // "a" already surfaced, so next best
  });

  test("never re-surfaces an already-surfaced decision", () => {
    const state: DecisionRecallState = { surfacedIds: ["a", "b"], lastTurn: 0, count: 2 };
    const res = governDecisionRecall({
      matches,
      state,
      turn: 10,
      config: { maxPerSession: 5, minSpacingTurns: 0 },
    });
    expect(res.surface).toBeNull();
  });
});

describe("recallRatedDecisions orchestrator", () => {
  let vault: string;
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "o2b-recall-"));
    mkdirSync(join(vault, "Brain"), { recursive: true });
    recordDecision(vault, {
      title: "Adopt Bun runtime for the CLI",
      chosen: "Bun",
      assumption: "compat",
      reviewDate: "2026-12-01",
      agent: "tester",
      rating: 5,
    });
  });
  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  test("unconfigured => disabled, nothing surfaced (byte-identical)", () => {
    const res = recallRatedDecisions(vault, { prompt: "adopt Bun runtime again" });
    expect(res.enabled).toBe(false);
    expect(res.surfaced).toBeNull();
    expect(res.text).toBe("");
  });

  test("configured => resurfaces the matching rated decision verbatim", () => {
    process.env["OPEN_SECOND_BRAIN_DECISION_RECALL_MAX_PER_SESSION"] = "3";
    try {
      const res = recallRatedDecisions(vault, {
        prompt: "should we adopt Bun runtime for the API",
      });
      expect(res.enabled).toBe(true);
      expect(res.surfaced?.slug).toBe("adopt-bun-runtime-for-the-cli");
      expect(res.text).toContain("Recalled decision");
      expect(res.text).toContain("Bun");
      expect(res.state.count).toBe(1);
    } finally {
      delete process.env["OPEN_SECOND_BRAIN_DECISION_RECALL_MAX_PER_SESSION"];
    }
  });
});
