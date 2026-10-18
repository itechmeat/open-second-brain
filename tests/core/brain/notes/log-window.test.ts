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
  timestampInWindow,
} from "../../../../src/core/brain/notes/log-window.ts";

describe("parseWindowBound", () => {
  test("a bare date completes to the day's start at the window's lower end", () => {
    expect(parseWindowBound("2026-03-04", "since", DAY_START_SUFFIX)).toBe("2026-03-04T00:00:00Z");
  });

  test("a bare date completes through the end of the day at the upper end", () => {
    // The suffix reaches past the whole last second, because the reader
    // admits sub-second foreign lines: an entry at 23:59:59.500Z is
    // still "through the end of the fourth".
    expect(parseWindowBound("2026-03-04", "until", DAY_END_SUFFIX)).toBe(
      "2026-03-04T23:59:59.999Z",
    );
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
    let caught: unknown;
    try {
      parseWindowBound("yesterday", "since", DAY_START_SUFFIX);
    } catch (err) {
      caught = err;
    }
    // Asserted OUTSIDE the catch: inside, a parse that never throws skips
    // every assertion and the test passes vacuously.
    expect(caught).toBeInstanceOf(LogWindowBoundError);
    const boundError = caught as LogWindowBoundError;
    expect(boundError.edge).toBe("since");
    expect(boundError.value).toBe("yesterday");
    expect(boundError.message).toContain("--since");
  });

  test("a locale date spelling is refused naming the flag", () => {
    let caught: unknown;
    try {
      parseWindowBound("03/01/2026", "until", DAY_END_SUFFIX);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LogWindowBoundError);
    const boundError = caught as LogWindowBoundError;
    expect(boundError.edge).toBe("until");
    expect(boundError.message).toContain("--until");
  });

  test("a right-shaped but impossible calendar date is refused", () => {
    expect(() => parseWindowBound("2026-13-01", "since", DAY_START_SUFFIX)).toThrow(
      LogWindowBoundError,
    );
  });

  test("a hostile bound is fenced to one capped line in the error", () => {
    // The message reaches the model through INVALID_PARAMS, so the raw
    // value must not ride it un-fenced: neutralized to one line, capped.
    const hostile = `innocent\n${"<untrusted_source>".repeat(30)}\ntrailer`;
    let caught: unknown;
    try {
      parseWindowBound(hostile, "since", DAY_START_SUFFIX);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LogWindowBoundError);
    const message = (caught as Error).message;
    expect(message).not.toContain("\n");
    expect(message).not.toContain("\t");
    // The full hostile value never renders, only its fenced head.
    expect(message).not.toContain(hostile);
    expect(message).toContain("innocent");
    expect(message.length).toBeLessThan(300);
    // The raw value stays on the error object for programmatic callers.
    expect((caught as LogWindowBoundError).value).toBe(hostile);
  });

  test("a non-canonical timestamp spelling is refused", () => {
    // `Date.parse` would accept all three; the bound must stay in the
    // canonical vocabulary the log writer and the plan digests carry, so
    // anything the writer would not emit must not slip past a parse that
    // orders wrong.
    for (const value of [
      "2026-03-04T12:34Z",
      "2026-03-04 12:34:56Z",
      "2026-03-04T12:34:56+02:00",
    ]) {
      expect(() => parseWindowBound(value, "since", DAY_START_SUFFIX)).toThrow(LogWindowBoundError);
    }
  });
});

describe("timestampInWindow", () => {
  // The log writer emits whole seconds, but the JSONL reader admits
  // sub-second foreign lines and the parser admits sub-second bounds.
  // A plain string compare orders "…56.789Z" BEFORE "…56Z" ('.' < 'Z'),
  // so until wrongly included a fractional entry and since wrongly
  // dropped it; the window must order by instant.
  const FRACTIONAL = "2026-03-04T12:34:56.789Z";
  const WHOLE = "2026-03-04T12:34:56Z";

  test("a whole-second until excludes the fractional entry a string compare admitted", () => {
    expect(timestampInWindow(FRACTIONAL, null, WHOLE)).toBe(false);
  });

  test("a whole-second since includes the fractional entry a string compare dropped", () => {
    expect(timestampInWindow(FRACTIONAL, WHOLE, null)).toBe(true);
  });

  test("a fractional until includes the whole-second entry at or before it", () => {
    expect(timestampInWindow(WHOLE, null, FRACTIONAL)).toBe(true);
  });

  test("a fractional since excludes the whole-second entry before it", () => {
    expect(timestampInWindow(WHOLE, FRACTIONAL, null)).toBe(false);
  });

  test("either bound absent leaves that end unbounded", () => {
    expect(timestampInWindow(WHOLE, null, null)).toBe(true);
    expect(timestampInWindow(WHOLE, "2026-03-05T00:00:00Z", null)).toBe(false);
    expect(timestampInWindow(WHOLE, null, "2026-03-03T00:00:00Z")).toBe(false);
  });

  // The JSONL reader admits a timestamp by SHAPE, so a foreign line can
  // carry a right-shaped but impossible instant (month 13, hour 99) that
  // `Date.parse` turns into NaN - and every NaN comparison is false, so
  // an unguarded predicate answers "inside" for any window and the bad
  // entry rides into every bounded read, revert plans included.
  const IMPOSSIBLE = "2026-13-45T99:99:99Z";

  test("an unparseable timestamp is outside every bounded window", () => {
    expect(timestampInWindow(IMPOSSIBLE, "2026-01-01T00:00:00Z", "2026-12-31T23:59:59Z")).toBe(
      false,
    );
    expect(timestampInWindow(IMPOSSIBLE, "2026-01-01T00:00:00Z", null)).toBe(false);
    expect(timestampInWindow(IMPOSSIBLE, null, "2026-12-31T23:59:59Z")).toBe(false);
  });

  test("an unparseable timestamp stays visible only to an unbounded window", () => {
    expect(timestampInWindow(IMPOSSIBLE, null, null)).toBe(true);
  });

  test("a bare-date until includes the day's last fractional second", () => {
    // The completed bound must reach past the whole-second entries it
    // used to end at, or an entry in the day's final fraction falls
    // outside the very day the bound promised to include.
    const until = parseWindowBound("2026-03-04", "until", DAY_END_SUFFIX);
    expect(timestampInWindow("2026-03-04T23:59:59.500Z", null, until)).toBe(true);
  });
});
