import { expect, test } from "bun:test";

import { evaluateSurfacingGate } from "../../../src/core/search/surfacing-gate.ts";

test("evaluateSurfacingGate suppresses only structural non-recall prompts", () => {
  expect(evaluateSurfacingGate({ prompt: "" }).reason).toBe("empty");
  expect(evaluateSurfacingGate({ prompt: "/help" }).reason).toBe("slash_command");
  expect(evaluateSurfacingGate({ prompt: "git status" }).reason).toBe("shell_command");
  expect(
    evaluateSurfacingGate({
      prompt: "find recall notes",
      previousPrompt: "Find recall notes",
    }).reason,
  ).toBe("duplicate");
});

test("evaluateSurfacingGate fails open for any non-suppressed prompt, in any language", () => {
  // No natural-language keyword list: an English memory question, a
  // greeting, a long uncertain question, and a non-Latin prompt all
  // fall through to the same language-agnostic retrieve decision.
  for (const prompt of [
    "what did we decide about recall diagnostics?",
    "hello",
    "Can you compare the options we discussed and tell me which path is less risky?",
    "что мы решили про диагностику recall?",
    "私たちは何を決めましたか",
    "هل ناقشنا هذا من قبل",
  ]) {
    expect(evaluateSurfacingGate({ prompt })).toEqual({
      retrieve: true,
      reason: "default_retrieve",
    });
  }
});

test("evaluateSurfacingGate honours an explicit recall request", () => {
  expect(evaluateSurfacingGate({ prompt: "hello", explicit: true })).toEqual({
    retrieve: true,
    reason: "explicit",
  });
});
