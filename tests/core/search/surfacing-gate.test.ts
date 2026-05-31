import { expect, test } from "bun:test";

import { evaluateSurfacingGate } from "../../../src/core/search/surfacing-gate.ts";

test("evaluateSurfacingGate skips greetings, slash commands, shell-only prompts, and duplicates", () => {
  expect(evaluateSurfacingGate({ prompt: "hello" }).reason).toBe("greeting");
  expect(evaluateSurfacingGate({ prompt: "/help" }).reason).toBe("slash_command");
  expect(evaluateSurfacingGate({ prompt: "git status" }).reason).toBe("shell_command");
  expect(
    evaluateSurfacingGate({
      prompt: "find recall notes",
      previousPrompt: "Find recall notes",
    }).reason,
  ).toBe("duplicate");
});

test("evaluateSurfacingGate retrieves real memory questions and explicit requests", () => {
  expect(
    evaluateSurfacingGate({
      prompt: "what did we decide about recall diagnostics?",
    }),
  ).toEqual({
    retrieve: true,
    reason: "memory_question",
  });
  expect(evaluateSurfacingGate({ prompt: "hello", explicit: true })).toEqual({
    retrieve: true,
    reason: "explicit",
  });
});

test("evaluateSurfacingGate fails open for uncertain long questions", () => {
  expect(
    evaluateSurfacingGate({
      prompt:
        "Can you compare the options we discussed and tell me which implementation path is less risky?",
    }),
  ).toEqual({ retrieve: true, reason: "uncertain_question" });
});
