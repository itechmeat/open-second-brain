/**
 * `resolveTimeBounds` (shared time-bounds wrapper): the lifted
 * `since`/`until` resolution every recall surface consumes - resolved
 * through the shared time-range grammar, with a `SearchError` mapped to
 * `MCPError(INVALID_PARAMS)` so an unparseable bound surfaces as an
 * invalid-params tool error instead of a silently ignored filter.
 */

import { describe, expect, test } from "bun:test";

import { resolveTimeBounds } from "../../src/mcp/brain/time-bounds.ts";
import { INVALID_PARAMS, MCPError } from "../../src/mcp/protocol.ts";

describe("resolveTimeBounds", () => {
  test("absent bounds stay open", () => {
    expect(resolveTimeBounds(undefined, undefined)).toEqual({
      sinceMs: null,
      untilMs: null,
    });
  });

  test("an ISO date since resolves to its UTC day start", () => {
    expect(resolveTimeBounds("2026-05-01", undefined)).toEqual({
      sinceMs: Date.UTC(2026, 4, 1),
      untilMs: null,
    });
  });

  test("the upper bound maps onto the grammar's inclusive until edge", () => {
    expect(resolveTimeBounds(undefined, "2026-05-01")).toEqual({
      sinceMs: null,
      untilMs: Date.UTC(2026, 4, 1) + 86_400_000 - 1,
    });
  });

  test("ISO datetimes pass through in UTC", () => {
    expect(resolveTimeBounds("2026-05-01T10:30:00Z", "2026-05-02T10:30:00Z")).toEqual({
      sinceMs: Date.UTC(2026, 4, 1, 10, 30, 0),
      untilMs: Date.UTC(2026, 4, 2, 10, 30, 0),
    });
  });

  test("relative bounds resolve backwards from the current clock", () => {
    const bounds = resolveTimeBounds("2d", "1h");
    expect(bounds.sinceMs).toBeLessThan(Date.now());
    expect(bounds.untilMs).toBeLessThan(Date.now());
    expect(bounds.sinceMs).toBeLessThan(bounds.untilMs!);
  });

  test("an unparseable bound is an INVALID_PARAMS error, not a dropped filter", () => {
    try {
      resolveTimeBounds("not a time", undefined);
      throw new Error("expected resolveTimeBounds to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MCPError);
      expect((err as MCPError).code).toBe(INVALID_PARAMS);
    }
  });

  test("an inverted range is an INVALID_PARAMS error", () => {
    try {
      resolveTimeBounds("2026-05-02", "2026-05-01");
      throw new Error("expected resolveTimeBounds to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MCPError);
      expect((err as MCPError).code).toBe(INVALID_PARAMS);
    }
  });
});
