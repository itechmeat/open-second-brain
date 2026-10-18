/**
 * The shared write-ledger window-bound parser (`log-window.ts`).
 *
 * The parser exists because two readers carried the same unvalidating
 * copy of the completion rule and a mistyped bound answered a clean,
 * wrong empty. The valid forms here are the two spellings both surfaces'
 * schema text promises; the malformed ones are the shapes an operator or
 * agent actually types - a relative day, a locale date, a right-shaped
 * but impossible calendar date.
 */

import { describe, expect, test } from "bun:test";

import {
  DAY_END_SUFFIX,
  DAY_START_SUFFIX,
  LogWindowBoundError,
  parseWindowBound,
} from "../../../../src/core/brain/notes/log-window.ts";

describe("parseWindowBound", () => {
  test("a bare date completes to the day's start at the window's lower end", () => {
    expect(parseWindowBound("2026-03-04", "since", DAY_START_SUFFIX)).toBe("2026-03-04T00:00:00Z");
  });

  test("a bare date completes through the end of the day at the upper end", () => {
    expect(parseWindowBound("2026-03-04", "until", DAY_END_SUFFIX)).toBe("2026-03-04T23:59:59Z");
  });

  test("a canonical UTC timestamp passes through verbatim at either end", () => {
    expect(parseWindowBound("2026-03-04T12:34:56Z", "since", DAY_START_SUFFIX)).toBe(
      "2026-03-04T12:34:56Z",
    );
    expect(parseWindowBound("2026-03-04T12:34:56.789Z", "until", DAY_END_SUFFIX)).toBe(
      "2026-03-04T12:34:56.789Z",
    );
  });

  test("a relative day is refused naming the flag", () => {
    expect(() => parseWindowBound("yesterday", "since", DAY_START_SUFFIX)).toThrow(
      LogWindowBoundError,
    );
    try {
      parseWindowBound("yesterday", "since", DAY_START_SUFFIX);
    } catch (err) {
      const boundError = err as LogWindowBoundError;
      expect(boundError.edge).toBe("since");
      expect(boundError.value).toBe("yesterday");
      expect(boundError.message).toContain("--since");
    }
  });

  test("a locale date spelling is refused naming the flag", () => {
    expect(() => parseWindowBound("03/01/2026", "until", DAY_END_SUFFIX)).toThrow(
      LogWindowBoundError,
    );
    try {
      parseWindowBound("03/01/2026", "until", DAY_END_SUFFIX);
    } catch (err) {
      const boundError = err as LogWindowBoundError;
      expect(boundError.edge).toBe("until");
      expect(boundError.message).toContain("--until");
    }
  });

  test("a right-shaped but impossible calendar date is refused", () => {
    expect(() => parseWindowBound("2026-13-01", "since", DAY_START_SUFFIX)).toThrow(
      LogWindowBoundError,
    );
  });

  test("a non-canonical timestamp spelling is refused", () => {
    // `Date.parse` would accept all three; the readers compare bounds as
    // strings against canonical log timestamps, so anything the writer
    // would not emit must not slip past a parse that orders wrong.
    for (const value of [
      "2026-03-04T12:34Z",
      "2026-03-04 12:34:56Z",
      "2026-03-04T12:34:56+02:00",
    ]) {
      expect(() => parseWindowBound(value, "since", DAY_START_SUFFIX)).toThrow(LogWindowBoundError);
    }
  });
});
