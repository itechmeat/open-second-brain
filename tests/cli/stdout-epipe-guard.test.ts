/**
 * O1 (t_2ed754d1): an early-closed stdout pipe must exit clean.
 *
 * Covers the pure mapping (EPIPE -> exit 0, every other stdout error stays
 * loud with a nonzero exit) and an end-to-end regression: a real subprocess
 * that streams many lines into a pipe a reader closes early must exit 0 with
 * no diagnostic on stderr. `vault-log` shares the same `main.ts` entry point,
 * so guarding that entry covers both CLIs.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { handleStdoutError, isEpipeError } from "../../src/cli/stdout-guard.ts";

const ROOT = join(import.meta.dir, "..", "..");

/** A sink that records the outcome instead of really exiting the process. */
function recordingSink() {
  const errors: string[] = [];
  let exitCode: number | null = null;
  return {
    errors,
    get exitCode() {
      return exitCode;
    },
    sink: {
      exit: (code: number): never => {
        exitCode = code;
        // Stop control flow the way process.exit would.
        throw new Error(`__exit_${code}__`);
      },
      writeError: (message: string): void => {
        errors.push(message);
      },
    },
  };
}

describe("isEpipeError", () => {
  test("recognises an EPIPE errno error object", () => {
    expect(isEpipeError({ code: "EPIPE" })).toBe(true);
    const err = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    expect(isEpipeError(err)).toBe(true);
  });

  test("rejects non-EPIPE errors and non-objects", () => {
    expect(isEpipeError({ code: "ENOSPC" })).toBe(false);
    expect(isEpipeError(new Error("boom"))).toBe(false);
    expect(isEpipeError(null)).toBe(false);
    expect(isEpipeError("EPIPE")).toBe(false);
  });
});

describe("handleStdoutError", () => {
  test("EPIPE maps to a silent exit 0", () => {
    const rec = recordingSink();
    expect(() => handleStdoutError({ code: "EPIPE" }, rec.sink)).toThrow("__exit_0__");
    expect(rec.exitCode).toBe(0);
    expect(rec.errors).toEqual([]);
  });

  test("a non-EPIPE stdout error fails loud with a nonzero exit", () => {
    const rec = recordingSink();
    const err = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    expect(() => handleStdoutError(err, rec.sink)).toThrow("__exit_1__");
    expect(rec.exitCode).toBe(1);
    expect(rec.errors.join("")).toContain("no space left on device");
  });
});

describe("closed stdout pipe regression", () => {
  test("streaming many lines into an early-closed pipe exits 0 with no stderr", async () => {
    // Drive the real guard in a fresh process: it writes far more than a pipe
    // buffer can hold, and the downstream `head -c1` closes after one byte.
    const proc = Bun.spawn(
      ["bash", "-c", "bun run tests/helpers/epipe-stream-harness.ts | head -c1 >/dev/null"],
      { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
    );
    const [stderr, returncode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(stderr).toBe("");
    expect(returncode).toBe(0);
  }, 20_000);
});
