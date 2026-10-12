import { expect, test } from "bun:test";

import { RECALL_INJECT_CONFIDENCE_FLOOR } from "../../../src/core/brain/recall-inject.ts";
import { RECALL_CHANNEL, RECALL_CHANNELS } from "../../../src/core/brain/recall-telemetry.ts";
import {
  evaluateGradedSurfacing,
  evaluateSurfacingGate,
} from "../../../src/core/search/surfacing-gate.ts";
import {
  computeSurfacingKey,
  SURFACING_ADMISSION_FLOORS,
  SurfacingKeyError,
} from "../../../src/core/search/surfacing-key.ts";

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

test("evaluateSurfacingGate admits a multi-line prompt that starts with a command name", () => {
  // The line-break test runs on the raw prompt: normalisation collapses
  // whitespace, so a test on the normalised text could never see one.
  expect(evaluateSurfacingGate({ prompt: "git status\nwhy does this fail" })).toEqual({
    retrieve: true,
    reason: "default_retrieve",
  });
  expect(evaluateSurfacingGate({ prompt: "git status\r\nwhy does this fail" }).reason).toBe(
    "default_retrieve",
  );
  expect(evaluateSurfacingGate({ prompt: "git status" }).reason).toBe("shell_command");
  expect(evaluateSurfacingGate({ prompt: "$ ls -la" }).reason).toBe("shell_command");
  // A trailing line break alone does not make a one-line command multi-line.
  expect(evaluateSurfacingGate({ prompt: "git status\n" }).reason).toBe("shell_command");
  // Documented residue: a single-line prompt that starts with a command
  // name is still skipped, even when the rest of it is prose.
  expect(evaluateSurfacingGate({ prompt: "git push keeps failing after the rebase" }).reason).toBe(
    "shell_command",
  );
});

// ----- graded surfacing key (t_107a3249, lane C Task 12) ---------------------

test("SURFACING_ADMISSION_FLOORS pins one constant per recall channel, hook at the inject floor", () => {
  for (const channel of RECALL_CHANNELS) {
    expect(SURFACING_ADMISSION_FLOORS[channel]).toBe(RECALL_INJECT_CONFIDENCE_FLOOR);
  }
});

test("computeSurfacingKey grades measurable match quality into admission tiers", () => {
  const floor = SURFACING_ADMISSION_FLOORS[RECALL_CHANNEL.mcp];
  expect(computeSurfacingKey({ matchQuality: floor, channel: RECALL_CHANNEL.mcp })).toEqual({
    key: floor,
    tier: "admitted",
    admit: true,
    reason: "admitted",
  });
  const weak = floor - 0.01;
  expect(computeSurfacingKey({ matchQuality: weak, channel: RECALL_CHANNEL.mcp })).toEqual({
    key: weak,
    tier: "below_floor",
    admit: false,
    reason: "below_floor",
  });
  expect(computeSurfacingKey({ matchQuality: null, channel: RECALL_CHANNEL.mcp })).toEqual({
    key: null,
    tier: "unmeasurable_quality",
    admit: false,
    reason: "unmeasurable_quality",
  });
});

test("computeSurfacingKey honours a caller-supplied floor over the channel constant", () => {
  // The hook's configurable confidence floor rides this override; the env
  // mirror is pinned in config tests, this pins the calculator's precedence.
  expect(
    computeSurfacingKey({ matchQuality: 0.4, channel: RECALL_CHANNEL.hook, floor: 0.5 }).admit,
  ).toBe(false);
  expect(
    computeSurfacingKey({ matchQuality: 0.5, channel: RECALL_CHANNEL.hook, floor: 0.5 }).admit,
  ).toBe(true);
});

test("computeSurfacingKey refuses an unmeasurable-shaped quality that is not null, by name", () => {
  expect(() => computeSurfacingKey({ matchQuality: 1.5, channel: RECALL_CHANNEL.mcp })).toThrow(
    SurfacingKeyError,
  );
  expect(() =>
    computeSurfacingKey({ matchQuality: Number.NaN, channel: RECALL_CHANNEL.mcp }),
  ).toThrow(SurfacingKeyError);
});

test("evaluateGradedSurfacing keeps the structural suppressions as named short-circuits above any quality", () => {
  // A suppressed prompt is never ranked, so the key stays null no matter
  // what quality a caller reports alongside it.
  expect(evaluateGradedSurfacing({ prompt: "/help", matchQuality: 0.9 })).toEqual({
    key: null,
    tier: "suppressed",
    admit: false,
    reason: "slash_command",
  });
  expect(evaluateGradedSurfacing({ prompt: "", matchQuality: 0.9 }).reason).toBe("empty");
  expect(evaluateGradedSurfacing({ prompt: "git status", matchQuality: 0.9 }).tier).toBe(
    "suppressed",
  );
  expect(
    evaluateGradedSurfacing({ prompt: "again", previousPrompt: "again", matchQuality: 0.9 }).tier,
  ).toBe("suppressed");
});

test("evaluateGradedSurfacing grades a fail-open prompt through the shared calculator", () => {
  const prompt = "what did we decide about recall diagnostics?";
  const weak = SURFACING_ADMISSION_FLOORS[RECALL_CHANNEL.mcp] - 0.1;
  expect(evaluateGradedSurfacing({ prompt, matchQuality: weak })).toEqual({
    key: weak,
    tier: "below_floor",
    admit: false,
    reason: "below_floor",
  });
  const strong = SURFACING_ADMISSION_FLOORS[RECALL_CHANNEL.mcp] + 0.1;
  expect(evaluateGradedSurfacing({ prompt, matchQuality: strong }).admit).toBe(true);
  // Explicit recall admits regardless of quality and carries the measurement.
  expect(evaluateGradedSurfacing({ prompt: "hello", explicit: true, matchQuality: 0.1 })).toEqual({
    key: 0.1,
    tier: "explicit",
    admit: true,
    reason: "explicit",
  });
  // Explicit with no measurement still admits; the key is honestly absent.
  expect(evaluateGradedSurfacing({ prompt: "hello", explicit: true })).toEqual({
    key: null,
    tier: "explicit",
    admit: true,
    reason: "explicit",
  });
});

test("an explicit request grades a measured null report as a null key, not an error", () => {
  // null is a legitimate measurement ("nothing was measurable"); the
  // explicit branch grades it like the default branch does instead of
  // handing it to the validator as a shape violation.
  expect(evaluateGradedSurfacing({ prompt: "hello", explicit: true, matchQuality: null })).toEqual({
    key: null,
    tier: "explicit",
    admit: true,
    reason: "explicit",
  });
});

test("evaluateGradedSurfacing without a measurement fails open as default_retrieve", () => {
  // Absent quality is not an unmeasurable report: the structural
  // projection failed open, and the reason records that it was a default.
  expect(evaluateGradedSurfacing({ prompt: "what did we decide?" })).toEqual({
    key: null,
    tier: "admitted",
    admit: true,
    reason: "default_retrieve",
  });
  // A measured `null` is an unmeasurable report, graded as one.
  expect(evaluateGradedSurfacing({ prompt: "what did we decide?", matchQuality: null })).toEqual({
    key: null,
    tier: "unmeasurable_quality",
    admit: false,
    reason: "unmeasurable_quality",
  });
});

test("evaluateGradedSurfacing routes admission through the requested channel", () => {
  for (const channel of RECALL_CHANNELS) {
    const floor = SURFACING_ADMISSION_FLOORS[channel];
    expect(evaluateGradedSurfacing({ prompt: "q", channel, matchQuality: floor })).toEqual({
      key: floor,
      tier: "admitted",
      admit: true,
      reason: "admitted",
    });
  }
});
