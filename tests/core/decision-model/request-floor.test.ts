/**
 * The least time worth starting a decision request with (design D20): a
 * request is started only while at least `MIN_REQUEST_MS` of its budget
 * is left, otherwise the use stops as if its share were spent.
 */

import { describe, expect, test } from "bun:test";

import {
  MIN_REQUEST_MS,
  attemptTimeoutMs,
  mayStartRequest,
} from "../../../src/core/decision-model/request-floor.ts";

describe("mayStartRequest", () => {
  const until = 10_000;
  /** A request timeout that never binds. */
  const long = 60_000;

  test("starts a request with the minimum or more left", () => {
    expect(mayStartRequest(until - MIN_REQUEST_MS, until, long)).toBe(true);
    expect(mayStartRequest(until - 3000, until, long)).toBe(true);
  });

  test("starts none with less than the minimum left, or past the moment", () => {
    expect(mayStartRequest(until - MIN_REQUEST_MS + 1, until, long)).toBe(false);
    expect(mayStartRequest(until - 5, until, long)).toBe(false);
    expect(mayStartRequest(until, until, long)).toBe(false);
    expect(mayStartRequest(until + 1, until, long)).toBe(false);
  });

  test("checks the time the request gets: its own timeout when that is smaller", () => {
    expect(mayStartRequest(0, until, MIN_REQUEST_MS)).toBe(true);
    expect(mayStartRequest(0, until, MIN_REQUEST_MS - 1)).toBe(false);
    expect(mayStartRequest(0, until, 100)).toBe(false);
    // The smaller of the two binds, whichever it is.
    expect(mayStartRequest(until - MIN_REQUEST_MS + 1, until, 3000)).toBe(false);
  });

  test("the minimum is the skill floor of 250 ms", () => {
    expect(MIN_REQUEST_MS).toBe(250);
  });
});

describe("attemptTimeoutMs: the floor for each attempt of a fallback chain", () => {
  test("an even share while every remaining entry can get the floor", () => {
    expect(attemptTimeoutMs(3000, 2)).toBe(1500);
    expect(attemptTimeoutMs(MIN_REQUEST_MS * 2, 2)).toBe(MIN_REQUEST_MS);
  });

  test("an entry that would get less is not attempted: its time goes to the entries that are", () => {
    // Two entries, room for one: the first gets the whole budget, not half.
    expect(attemptTimeoutMs(MIN_REQUEST_MS * 2 - 1, 2)).toBe(MIN_REQUEST_MS * 2 - 1);
    expect(attemptTimeoutMs(MIN_REQUEST_MS * 3 - 1, 3)).toBe(
      Math.floor((MIN_REQUEST_MS * 3 - 1) / 2),
    );
  });

  test("no attempt at all with less than the floor left", () => {
    expect(attemptTimeoutMs(MIN_REQUEST_MS - 1, 1)).toBeNull();
    expect(attemptTimeoutMs(MIN_REQUEST_MS - 1, 3)).toBeNull();
    expect(attemptTimeoutMs(0, 1)).toBeNull();
    expect(attemptTimeoutMs(-5, 1)).toBeNull();
  });

  test("never a share below the floor", () => {
    for (let left = 0; left < MIN_REQUEST_MS * 5; left += 7) {
      for (let entries = 1; entries <= 4; entries++) {
        const ms = attemptTimeoutMs(left, entries);
        if (ms !== null) {
          expect(ms).toBeGreaterThanOrEqual(MIN_REQUEST_MS);
          expect(ms).toBeLessThanOrEqual(left);
        }
      }
    }
  });
});
