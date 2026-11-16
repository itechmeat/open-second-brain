/**
 * The least time worth starting a decision request with (design D20): a
 * request is started only while at least `MIN_REQUEST_MS` of its budget
 * is left, otherwise the use stops as if its share were spent.
 */

import { describe, expect, test } from "bun:test";

import { MIN_REQUEST_MS, mayStartRequest } from "../../../src/core/decision-model/request-floor.ts";

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
