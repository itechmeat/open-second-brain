/**
 * Safeguard abort composition (Indexer Durability suite, t_79e773be):
 * the cooperative deadline gains an optional AbortSignal so one
 * checkpoint() has two trip conditions - an aborted signal (priority)
 * or a passed deadline. Bun + synchronous SQLite still cannot be
 * preempted, so abort is cooperative: the NEXT checkpoint after an
 * abort throws SafeguardAbortError at a natural iteration boundary.
 */

import { describe, expect, test } from "bun:test";

import {
  createSafeguard,
  SafeguardAbortError,
  SafeguardTimeoutError,
  throwIfAborted,
} from "../../../src/core/brain/safeguard.ts";

describe("createSafeguard with an AbortSignal", () => {
  test("an aborted signal trips checkpoint() with SafeguardAbortError", () => {
    const ac = new AbortController();
    const guard = createSafeguard({ operation: "reindex", timeoutMs: 0, signal: ac.signal });
    guard.checkpoint();
    ac.abort();
    expect(() => guard.checkpoint()).toThrow(SafeguardAbortError);
  });

  test("abort wins over a live deadline (checked first)", () => {
    let clock = 1_000;
    const ac = new AbortController();
    const guard = createSafeguard({
      operation: "reindex",
      timeoutMs: 100_000,
      now: () => clock,
      signal: ac.signal,
    });
    clock += 10; // well within the deadline
    guard.checkpoint();
    ac.abort();
    try {
      guard.checkpoint();
      throw new Error("expected SafeguardAbortError");
    } catch (exc) {
      expect(exc).toBeInstanceOf(SafeguardAbortError);
      expect(exc).not.toBeInstanceOf(SafeguardTimeoutError);
      const e = exc as SafeguardAbortError;
      expect(e.operation).toBe("reindex");
      expect(e.message).toContain("reindex");
    }
  });

  test("a signal with no deadline still trips on abort (no noop downgrade)", () => {
    const ac = new AbortController();
    const guard = createSafeguard({ operation: "index", timeoutMs: null, signal: ac.signal });
    expect(() => guard.checkpoint()).not.toThrow();
    ac.abort();
    expect(() => guard.checkpoint()).toThrow(SafeguardAbortError);
  });

  test("the deadline still trips when the signal is never aborted", () => {
    let clock = 0;
    const ac = new AbortController();
    const guard = createSafeguard({
      operation: "reindex",
      timeoutMs: 10,
      now: () => clock,
      signal: ac.signal,
    });
    clock = 11;
    expect(() => guard.checkpoint()).toThrow(SafeguardTimeoutError);
  });

  test("no signal + live deadline behaves exactly as before", () => {
    let clock = 1_000;
    const guard = createSafeguard({ operation: "dream", timeoutMs: 50, now: () => clock });
    guard.checkpoint();
    clock += 51;
    expect(() => guard.checkpoint()).toThrow(SafeguardTimeoutError);
  });
});

describe("throwIfAborted", () => {
  test("throws SafeguardAbortError for an aborted signal", () => {
    const ac = new AbortController();
    ac.abort();
    expect(() => throwIfAborted(ac.signal, "index")).toThrow(SafeguardAbortError);
  });

  test("is a no-op for a live or absent signal", () => {
    const ac = new AbortController();
    expect(() => throwIfAborted(ac.signal, "index")).not.toThrow();
    expect(() => throwIfAborted(undefined, "index")).not.toThrow();
  });
});
