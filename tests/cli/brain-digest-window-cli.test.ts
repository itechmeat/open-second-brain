import { describe, expect, test } from "bun:test";
import { parseWindow, cmdBrainDigest } from "../../src/cli/brain/verbs/digest.ts";

describe("parseWindow", () => {
  test("parses '7d' as 7 days", () => {
    expect(parseWindow("7d")).toBe(7);
  });
  test("parses bare '7' as 7 days", () => {
    expect(parseWindow("7")).toBe(7);
  });
  test("parses '1d' as 1 day", () => {
    expect(parseWindow("1d")).toBe(1);
  });
  test("parses '30d' as 30 days", () => {
    expect(parseWindow("30d")).toBe(30);
  });
  test("rejects '0d'", () => {
    expect(() => parseWindow("0d")).toThrow();
  });
  test("rejects '-1d'", () => {
    expect(() => parseWindow("-1d")).toThrow();
  });
  test("rejects 'abc'", () => {
    expect(() => parseWindow("abc")).toThrow();
  });
  test("rejects '1.5d'", () => {
    expect(() => parseWindow("1.5d")).toThrow();
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
