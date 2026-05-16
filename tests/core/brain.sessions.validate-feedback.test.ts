/**
 * Tests for `validateBrainFeedbackInput` — the pure validator shared
 * between the MCP layer (`toolBrainFeedback`) and the §16 session
 * importer that replays `brain_feedback` tool_use calls.
 */

import { describe, expect, test } from "bun:test";

import { validateBrainFeedbackInput } from "../../src/core/brain/sessions/validate-feedback.ts";

describe("validateBrainFeedbackInput", () => {
  test("accepts a minimal valid payload", () => {
    const r = validateBrainFeedbackInput({
      topic: "no-internal-abbrev",
      signal: "negative",
      principle: "Do not use internal abbreviations",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.topic).toBe("no-internal-abbrev");
      expect(r.value.signal).toBe("negative");
      expect(r.value.principle).toBe("Do not use internal abbreviations");
    }
  });

  test("accepts optional scope / agent / raw", () => {
    const r = validateBrainFeedbackInput({
      topic: "t",
      signal: "positive",
      principle: "p",
      scope: "writing",
      agent: "claude",
      raw: "quoted text",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.scope).toBe("writing");
      expect(r.value.agent).toBe("claude");
      expect(r.value.raw).toBe("quoted text");
    }
  });

  test("rejects when topic is missing", () => {
    const r = validateBrainFeedbackInput({ signal: "negative", principle: "p" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/topic/);
  });

  test("rejects when signal is missing", () => {
    const r = validateBrainFeedbackInput({ topic: "t", principle: "p" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/signal/);
  });

  test("rejects when principle is missing", () => {
    const r = validateBrainFeedbackInput({ topic: "t", signal: "negative" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/principle/);
  });

  test("rejects empty-string required fields", () => {
    const r = validateBrainFeedbackInput({
      topic: "",
      signal: "negative",
      principle: "p",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/topic/);
  });

  test("rejects invalid signal enum value", () => {
    const r = validateBrainFeedbackInput({
      topic: "t",
      signal: "maybe",
      principle: "p",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/signal/);
  });

  test("rejects non-string types", () => {
    const r = validateBrainFeedbackInput({
      topic: 42,
      signal: "negative",
      principle: "p",
    });
    expect(r.ok).toBe(false);
  });

  test("rejects null / undefined input", () => {
    expect(validateBrainFeedbackInput(null).ok).toBe(false);
    expect(validateBrainFeedbackInput(undefined).ok).toBe(false);
  });

  test("rejects non-object scalar input", () => {
    expect(validateBrainFeedbackInput("not an object").ok).toBe(false);
    expect(validateBrainFeedbackInput(123).ok).toBe(false);
  });
});
