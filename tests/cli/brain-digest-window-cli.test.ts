import { describe, expect, test } from "bun:test";
import { parseWindow, cmdBrainDigest } from "../../src/cli/brain/verbs/digest.ts";

describe("parseWindow", () => {
  test("parses day windows with or without the d suffix", () => {
    for (const [raw, days] of [
      ["7d", 7],
      ["7", 7],
      ["1d", 1],
      ["30d", 30],
    ] as const) {
      expect(parseWindow(raw)).toBe(days);
    }
  });

  test("rejects non-positive and malformed windows", () => {
    for (const raw of ["0d", "-1d", "abc", "1.5d"]) {
      expect(() => parseWindow(raw)).toThrow();
    }
  });
});

describe("cmdBrainDigest --window exit codes", () => {
  test("invalid --window exits with code 2", async () => {
    const code = await cmdBrainDigest(["--window", "abc"]);
    expect(code).toBe(2);
  });

  test("non-positive --window exits with code 2", async () => {
    const code = await cmdBrainDigest(["--window", "0d"]);
    expect(code).toBe(2);
  });
});
