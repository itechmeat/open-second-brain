/**
 * Tests for src/core/brain/next-step.ts - strict next-step resolution over
 * the existing {@link DIAGNOSTIC_SIGNALS} registry (no-dead-ends, task 1).
 *
 * Three obligations are pinned here. First, every registered code resolves
 * and an unregistered one returns the explicit absent result rather than a
 * fabricated command. Second, the registry contains commands and not prose -
 * the guard test below is what stops an English sentence entering the
 * next-step surface through the registry door. Third, the lenient
 * {@link resolveSignal} keeps its two existing consumers working exactly as
 * before, so the strict lookup is additive.
 */

import { describe, expect, test } from "bun:test";

import { DIAGNOSTIC_SIGNALS, resolveSignal } from "../../../src/core/brain/diagnostics.ts";
import { resolveNextStep } from "../../../src/core/brain/next-step.ts";

/** A code no registry entry uses, and none plausibly will. */
const UNREGISTERED_CODE = "no-such-diagnostic-code";

/**
 * Structural shape of a next command, derived from the CLI grammar rather
 * than from any word list: the binary name, one to three bare verb words,
 * then only long flags (`--name`, `--name=value`) and `<placeholder>`
 * arguments. A sentence fails this because its trailing words are neither
 * flags nor placeholders, and because a verb path is at most three words.
 */
const STRUCTURAL_COMMAND_RE =
  /^o2b(?: [a-z][a-z0-9-]*){1,3}(?: (?:--[a-z][a-z0-9-]*(?:=\S+)?|<[a-z][a-z0-9-]*>))*$/;

/** Characters that end or join sentences; none belongs in a command line. */
const SENTENCE_PUNCTUATION_RE = /[.!?;,:]/;

describe("resolveNextStep", () => {
  test("every registered code resolves to its registered command", () => {
    expect(DIAGNOSTIC_SIGNALS.size).toBeGreaterThan(0);
    for (const [code, signal] of DIAGNOSTIC_SIGNALS) {
      const step = resolveNextStep(code);
      expect(step).not.toBeNull();
      expect(step).toEqual({
        code: signal.code,
        issueClass: signal.issueClass,
        nextCommand: signal.nextCommand,
      });
    }
  });

  test("an unregistered code returns the absent result and does not throw", () => {
    expect(() => resolveNextStep(UNREGISTERED_CODE)).not.toThrow();
    expect(resolveNextStep(UNREGISTERED_CODE)).toBeNull();
  });

  test("the empty code is absent, never a fabricated generic", () => {
    expect(resolveNextStep("")).toBeNull();
  });
});

describe("registry prose guard", () => {
  test("every registered nextCommand is a structural command line", () => {
    for (const [code, signal] of DIAGNOSTIC_SIGNALS) {
      const command = signal.nextCommand;
      expect(`${code}: ${command}`).toBe(`${code}: ${command.trim()}`);
      expect(`${code}: ${command}`).not.toContain("\n");
      expect(`${code}: ${command}`).not.toContain("  ");
      expect(`${code}: ${SENTENCE_PUNCTUATION_RE.test(command)}`).toBe(`${code}: false`);
      expect(`${code}: ${STRUCTURAL_COMMAND_RE.test(command)}`).toBe(`${code}: true`);
    }
  });

  test("the guard rejects prose that a naive check would accept", () => {
    const prose = [
      "Run o2b brain doctor to repair this.",
      "o2b brain doctor to see the remaining issues",
      "o2b brain doctor; then o2b brain health",
      "o2b brain doctor, then retry",
      "o2b brain doctor\no2b brain health",
      "see the docs",
      "",
    ];
    for (const line of prose) {
      const structural = STRUCTURAL_COMMAND_RE.test(line) && !SENTENCE_PUNCTUATION_RE.test(line);
      expect(`${line}: ${structural}`).toBe(`${line}: false`);
    }
  });
});

describe("resolveSignal (lenient, unchanged)", () => {
  test("a registered code resolves to the frozen registry entry", () => {
    const signal = resolveSignal("config-missing");
    expect(signal).toBe(DIAGNOSTIC_SIGNALS.get("config-missing")!);
  });

  test("an unregistered code still yields the fabricated generic hint", () => {
    expect(resolveSignal(UNREGISTERED_CODE)).toEqual({
      code: UNREGISTERED_CODE,
      issueClass: UNREGISTERED_CODE,
      nextCommand: "o2b brain doctor",
      autoRepairable: false,
    });
  });

  test("the strict lookup and the lenient one disagree exactly on absence", () => {
    expect(resolveNextStep(UNREGISTERED_CODE)).toBeNull();
    expect(resolveSignal(UNREGISTERED_CODE).nextCommand).not.toBe("");
  });
});
