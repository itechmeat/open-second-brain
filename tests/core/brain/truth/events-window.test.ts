/**
 * `selectClaimEvents` / `eventsWindowBounds` (pure events-window
 * selection for the brain_truth `events` operation): second-precision
 * `ts` bounds, the normalized-entity filter, and the named list limits.
 */

import { describe, expect, test } from "bun:test";

import {
  CLAIM_EVENT_MAX_LIST_LIMIT,
  DEFAULT_EVENT_LIST_LIMIT,
  eventsWindowBounds,
  selectClaimEvents,
} from "../../../../src/core/brain/truth/events-window.ts";
import { isoSecond } from "../../../../src/core/brain/time.ts";
import { TRUTH_SCHEMA_VERSION, type ClaimEvent } from "../../../../src/core/brain/truth/types.ts";

function claimEvent(
  overrides: Partial<ClaimEvent> & Pick<ClaimEvent, "ts" | "entity">,
): ClaimEvent {
  return Object.freeze({
    v: TRUTH_SCHEMA_VERSION,
    agent: "claude",
    aspect: "employer",
    value: "Google",
    valueKind: "text",
    source: "[[Brain/notes/a.md]]",
    ...overrides,
  });
}

/**
 * A claim carrying validity fields, built through a JSON round-trip so
 * this suite compiles before and after the optional validity fields land
 * on `ClaimEvent` (contract item 1).
 */
function windowed(e: ClaimEvent, validFrom: string, validUntil: string): ClaimEvent {
  return JSON.parse(JSON.stringify({ ...e, validFrom, validUntil })) as ClaimEvent;
}

const T0 = Date.UTC(2026, 4, 1, 10, 0, 0);

describe("eventsWindowBounds", () => {
  test("open bounds pass through as null", () => {
    expect(eventsWindowBounds(null, null)).toEqual({ since: null, until: null });
  });

  test("sub-second bounds resolve to whole-second stamps", () => {
    const halfSecond = T0 + 500;
    expect(eventsWindowBounds(halfSecond, halfSecond)).toEqual({
      since: "2026-05-01T10:00:00Z",
      until: "2026-05-01T10:00:00Z",
    });
  });

  test("exact-second bounds keep their stamp verbatim", () => {
    expect(eventsWindowBounds(T0, T0 + 1000)).toEqual({
      since: "2026-05-01T10:00:00Z",
      until: "2026-05-01T10:00:01Z",
    });
  });

  test("non-finite bounds are refused by name, never reaching new Date(NaN)", () => {
    // A NaN or infinite bound used to die inside toISOString() as an
    // unnamed "Invalid time value" RangeError; the boundary refuses it
    // with the same named style the limit validation uses, naming the
    // offending argument.
    expect(() => eventsWindowBounds(NaN, null)).toThrow(RangeError);
    expect(() => eventsWindowBounds(NaN, null)).toThrow(/claim events since bound/);
    expect(() => eventsWindowBounds(null, Number.POSITIVE_INFINITY)).toThrow(
      /claim events until bound/,
    );
    expect(() => selectClaimEvents([], { sinceMs: NaN })).toThrow(/since/);
    expect(() => selectClaimEvents([], { untilMs: NaN })).toThrow(/until/);
  });
});

describe("selectClaimEvents", () => {
  test("selects nothing from an empty ledger", () => {
    expect(selectClaimEvents([], {})).toEqual({ rows: [], total: 0, truncated: false });
  });

  test("without filters every event is matched in ascending order", () => {
    const events = [
      claimEvent({ ts: isoSecond(new Date(T0)), entity: "alice mason" }),
      claimEvent({ ts: isoSecond(new Date(T0 + 1000)), entity: "bob" }),
      claimEvent({ ts: isoSecond(new Date(T0 + 2000)), entity: "alice mason" }),
    ];
    const out = selectClaimEvents(events, {});
    expect(out.rows.map((e) => e.ts)).toEqual([
      "2026-05-01T10:00:00Z",
      "2026-05-01T10:00:01Z",
      "2026-05-01T10:00:02Z",
    ]);
    expect(out.total).toBe(3);
    expect(out.truncated).toBe(false);
  });

  test("the since bound includes the whole second it floors into", () => {
    const events = [
      claimEvent({ ts: "2026-05-01T09:59:59Z", entity: "a" }),
      claimEvent({ ts: "2026-05-01T10:00:00Z", entity: "a" }),
      claimEvent({ ts: "2026-05-01T10:00:01Z", entity: "a" }),
    ];
    // 10:00:00.500 floors to 10:00:00, whose events stay inside the window.
    const out = selectClaimEvents(events, { sinceMs: T0 + 500 });
    expect(out.rows.map((e) => e.ts)).toEqual(["2026-05-01T10:00:00Z", "2026-05-01T10:00:01Z"]);
  });

  test("the until bound includes the whole second containing it and nothing past it", () => {
    const events = [
      claimEvent({ ts: "2026-05-01T23:59:58Z", entity: "a" }),
      claimEvent({ ts: "2026-05-01T23:59:59Z", entity: "a" }),
      claimEvent({ ts: "2026-05-02T00:00:00Z", entity: "a" }),
    ];
    // The grammar's inclusive day edge resolves until=2026-05-01 to
    // 23:59:59.999; the whole second containing it stays inside the
    // window and the next day's midnight second does not.
    const dayEndMs = Date.UTC(2026, 4, 1, 23, 59, 59, 999);
    const out = selectClaimEvents(events, { untilMs: dayEndMs });
    expect(out.rows.map((e) => e.ts)).toEqual(["2026-05-01T23:59:58Z", "2026-05-01T23:59:59Z"]);
  });

  test("an exact-second until bound includes an event stamped at that second", () => {
    const events = [
      claimEvent({ ts: "2026-05-01T10:00:00Z", entity: "a" }),
      claimEvent({ ts: "2026-05-01T10:00:01Z", entity: "a" }),
    ];
    const out = selectClaimEvents(events, { untilMs: T0 });
    expect(out.rows.map((e) => e.ts)).toEqual(["2026-05-01T10:00:00Z"]);
  });

  test("a fractional-second event stamp compares at its whole second", () => {
    const events = [
      claimEvent({ ts: "2026-05-01T10:00:00.500Z", entity: "a" }),
      claimEvent({ ts: "2026-05-01T10:00:01Z", entity: "a" }),
    ];
    const out = selectClaimEvents(events, { sinceMs: T0, untilMs: T0 });
    expect(out.rows.map((e) => e.ts)).toEqual(["2026-05-01T10:00:00.500Z"]);
  });

  test("the entity filter normalizes and composes with the bounds", () => {
    const events = [
      claimEvent({ ts: isoSecond(new Date(T0)), entity: "alice mason" }),
      claimEvent({ ts: isoSecond(new Date(T0 + 1000)), entity: "bob" }),
      claimEvent({ ts: isoSecond(new Date(T0 + 86_400_000)), entity: "alice mason" }),
    ];
    const out = selectClaimEvents(events, {
      entity: "Alice Mason",
      sinceMs: T0,
      untilMs: T0 + 5000,
    });
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]!.entity).toBe("alice mason");
    expect(out.total).toBe(1);
  });

  test("an empty entity string filters nothing", () => {
    const events = [claimEvent({ ts: isoSecond(new Date(T0)), entity: "alice mason" })];
    expect(selectClaimEvents(events, { entity: "" }).rows).toHaveLength(1);
  });

  test("validity fields pass through verbatim on selected rows", () => {
    const event = windowed(
      claimEvent({ ts: isoSecond(new Date(T0)), entity: "alice mason" }),
      "2026-01-01T00:00:00Z",
      "2026-12-31T00:00:00Z",
    );
    const out = selectClaimEvents([event], {});
    expect(out.rows).toEqual([event]);
    expect(out.rows[0]!.validFrom).toBe("2026-01-01T00:00:00Z");
    expect(out.rows[0]!.validUntil).toBe("2026-12-31T00:00:00Z");
  });

  test("the default limit pages the match and reports the truncation", () => {
    const events = Array.from({ length: DEFAULT_EVENT_LIST_LIMIT + 50 }, (_, i) =>
      claimEvent({ ts: isoSecond(new Date(T0 + i * 1000)), entity: "a" }),
    );
    const out = selectClaimEvents(events, {});
    expect(out.rows).toHaveLength(DEFAULT_EVENT_LIST_LIMIT);
    expect(out.total).toBe(DEFAULT_EVENT_LIST_LIMIT + 50);
    expect(out.truncated).toBe(true);
    expect(out.rows[0]!.ts).toBe(isoSecond(new Date(T0)));
  });

  test("an explicit limit under the default pages exactly that many", () => {
    const events = Array.from({ length: 5 }, (_, i) =>
      claimEvent({ ts: isoSecond(new Date(T0 + i * 1000)), entity: "a" }),
    );
    const out = selectClaimEvents(events, { limit: 3 });
    expect(out.rows).toHaveLength(3);
    expect(out.total).toBe(5);
    expect(out.truncated).toBe(true);
  });

  test(`the hard cap is ${CLAIM_EVENT_MAX_LIST_LIMIT}`, () => {
    const events = Array.from({ length: CLAIM_EVENT_MAX_LIST_LIMIT + 100 }, (_, i) =>
      claimEvent({ ts: isoSecond(new Date(T0 + i * 1000)), entity: "a" }),
    );
    const out = selectClaimEvents(events, { limit: CLAIM_EVENT_MAX_LIST_LIMIT * 5 });
    expect(out.rows).toHaveLength(CLAIM_EVENT_MAX_LIST_LIMIT);
    expect(out.total).toBe(CLAIM_EVENT_MAX_LIST_LIMIT + 100);
    expect(out.truncated).toBe(true);
  });

  test("a limit below 1 or fractional is refused, never silently applied", () => {
    const events = [claimEvent({ ts: isoSecond(new Date(T0)), entity: "a" })];
    expect(() => selectClaimEvents(events, { limit: 0 })).toThrow(/limit/);
    expect(() => selectClaimEvents(events, { limit: -3 })).toThrow(/limit/);
    expect(() => selectClaimEvents(events, { limit: 1.5 })).toThrow(/limit/);
  });
});
