/**
 * Unit tests for the shared external-command JSON bridge
 * (continuity-hygiene-freshness suite, Task 1).
 *
 * The bridge is the single sanctioned boundary for consulting an
 * external command with JSON on stdin and reading JSON from stdout.
 * Contract pinned here: skipped on absent command, ran with parsed
 * output on success, error (never throw) on non-zero exit, malformed
 * JSON, signal kill, or timeout - the fail-open semantics
 * `src/core/bench/judge.ts` shipped with.
 */

import { describe, expect, test } from "bun:test";

import { runJsonCommandBridge } from "../../src/core/reliability/command-bridge.ts";

describe("runJsonCommandBridge", () => {
  test("skips when the command is undefined or blank", () => {
    expect(runJsonCommandBridge(undefined, { a: 1 })).toEqual({ status: "skipped" });
    expect(runJsonCommandBridge("", { a: 1 })).toEqual({ status: "skipped" });
    expect(runJsonCommandBridge("   ", { a: 1 })).toEqual({ status: "skipped" });
  });

  test("runs the command, passes input JSON on stdin, parses stdout JSON", () => {
    const result = runJsonCommandBridge("cat", { questions: [1, 2] });
    expect(result.status).toBe("ran");
    if (result.status === "ran") {
      expect(result.output).toEqual({ questions: [1, 2] });
    }
  });

  test("reports error with exit status on non-zero exit", () => {
    const result = runJsonCommandBridge("exit 3", {});
    expect(result).toEqual({ status: "error", detail: "command exited 3" });
  });

  test("labels error details when a label is supplied", () => {
    const result = runJsonCommandBridge("exit 2", {}, { label: "judge command" });
    expect(result).toEqual({ status: "error", detail: "judge command exited 2" });
  });

  test("reports error on malformed stdout JSON instead of throwing", () => {
    const result = runJsonCommandBridge("echo not-json", {});
    expect(result.status).toBe("error");
  });

  test("reports error on timeout instead of hanging or throwing", () => {
    const result = runJsonCommandBridge("sleep 5", {}, { timeoutMs: 100 });
    expect(result.status).toBe("error");
  });

  test("result objects are frozen", () => {
    const result = runJsonCommandBridge("cat", {});
    expect(Object.isFrozen(result)).toBe(true);
  });
});
