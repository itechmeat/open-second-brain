/**
 * Correction end-state policy (truth-correctable-time-aware, contract
 * item 2): one pure function deciding how a corrected predecessor
 * retires. A flatly-wrong claim tombstones (hidden - nothing surfaces,
 * correction included); every other correction closes validity at the
 * explicit window end when time-scoped, else at the correction
 * instant, so the predecessor stays serveable inside its historical
 * window. Pure and deterministic - no I/O, no clock.
 */

import { describe, expect, test } from "bun:test";

import {
  correctionEndState,
  type CorrectionEndStateInput,
} from "../../../../src/core/brain/truth/correction-policy.ts";

function input(over: Partial<CorrectionEndStateInput> = {}): CorrectionEndStateInput {
  return { flatlyWrong: false, ...over };
}

describe("correctionEndState", () => {
  test("a flatly-wrong claim tombstones with a null validUntil", () => {
    expect(correctionEndState(input({ flatlyWrong: true }), "2026-06-01T10:00:00Z")).toEqual({
      endState: "tombstone",
      validUntil: null,
    });
  });

  test("flatlyWrong wins over an explicit window end", () => {
    const result = correctionEndState(
      input({ flatlyWrong: true, windowEnd: "2026-12-31" }),
      "2026-06-01T10:00:00Z",
    );
    expect(result).toEqual({ endState: "tombstone", validUntil: null });
  });

  test("a time-scoped correction closes validity at the explicit window end", () => {
    expect(
      correctionEndState(input({ windowEnd: "2026-12-31T23:59:59Z" }), "2026-06-01T10:00:00Z"),
    ).toEqual({ endState: "validity_close", validUntil: "2026-12-31T23:59:59Z" });
  });

  test("a bare-date window end passes through verbatim", () => {
    expect(correctionEndState(input({ windowEnd: "2026-12-31" }), "2026-06-01T10:00:00Z")).toEqual({
      endState: "validity_close",
      validUntil: "2026-12-31",
    });
  });

  test("an unscoped correction closes validity at the correction instant", () => {
    expect(correctionEndState(input(), "2026-06-01T10:00:00Z")).toEqual({
      endState: "validity_close",
      validUntil: "2026-06-01T10:00:00Z",
    });
  });

  test("results are pure and deterministic across calls", () => {
    const first = correctionEndState(input({ windowEnd: "2026-12-31" }), "2026-06-01T10:00:00Z");
    const second = correctionEndState(input({ windowEnd: "2026-12-31" }), "2026-06-01T10:00:00Z");
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    // The input object is never mutated.
    const probe: CorrectionEndStateInput = { flatlyWrong: false, windowEnd: "2026-12-31" };
    correctionEndState(probe, "2026-06-01T10:00:00Z");
    expect(probe).toEqual({ flatlyWrong: false, windowEnd: "2026-12-31" });
  });
});
