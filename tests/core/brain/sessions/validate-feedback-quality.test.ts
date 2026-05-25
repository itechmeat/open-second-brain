import { describe, expect, test } from "bun:test";

import { validateBrainFeedbackInput } from "../../../../src/core/brain/sessions/validate-feedback.ts";

describe("validate-feedback - quality gate (v0.10.16)", () => {
  test("structurally-vague single-token principle is rejected", () => {
    const r = validateBrainFeedbackInput({
      topic: "test",
      signal: "positive",
      principle: "careful",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/principle|quality|single-token/i);
    }
  });

  test("empty principle is rejected by the existing required-field check", () => {
    const r = validateBrainFeedbackInput({
      topic: "test",
      signal: "positive",
      principle: "",
    });
    expect(r.ok).toBe(false);
  });

  test("structurally-acceptable principle passes", () => {
    const r = validateBrainFeedbackInput({
      topic: "test",
      signal: "positive",
      principle: "limit retries to 10 per hour",
    });
    expect(r.ok).toBe(true);
  });

  test("principle with operator-shape signal passes", () => {
    const r = validateBrainFeedbackInput({
      topic: "test",
      signal: "positive",
      principle: "response time must stay < 100 milliseconds",
    });
    expect(r.ok).toBe(true);
  });

  test("warn-level principle (long but with measurable signal) still passes", () => {
    // The gate REJECTs only on structurally-broken input; warn-level
    // findings (too-long, no-measurable-signal) are advisory and do
    // not block submission.
    const long = "limit X to 10 ".repeat(60); // > 500 chars but has digit
    const r = validateBrainFeedbackInput({
      topic: "test",
      signal: "positive",
      principle: long,
    });
    expect(r.ok).toBe(true);
  });
});
