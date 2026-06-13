/**
 * Pure debounce/coalesce planner for the file-watcher index sync (Unit 3
 * of the Vault Integrity & Trust suite).
 *
 * The planner is deterministic and OS-independent: it takes an explicit
 * `now` rather than reading the clock, so a burst of edits can be replayed
 * exactly in a test. The CLI verb owns the real `fs.watch` handle, the
 * timer, and the single-flight guard; this module owns only the question
 * "which paths have been quiet long enough to index now?".
 */

import { describe, expect, test } from "bun:test";

import { IndexWatchPlanner } from "../../../src/core/search/index-watch.ts";

describe("IndexWatchPlanner", () => {
  test("a recorded path is not due before the debounce window elapses", () => {
    const p = new IndexWatchPlanner({ debounceMs: 500 });
    p.record("a.md", 1000);
    expect(p.due(1000)).toEqual([]);
    expect(p.due(1499)).toEqual([]);
  });

  test("a path becomes due once the quiet window has elapsed", () => {
    const p = new IndexWatchPlanner({ debounceMs: 500 });
    p.record("a.md", 1000);
    expect(p.due(1500)).toEqual(["a.md"]);
  });

  test("a burst on the same path coalesces - each edit resets the quiet window", () => {
    const p = new IndexWatchPlanner({ debounceMs: 500 });
    p.record("a.md", 1000);
    p.record("a.md", 1300); // resets the window
    expect(p.due(1500)).toEqual([]); // 1500 - 1300 < 500
    expect(p.due(1800)).toEqual(["a.md"]); // now quiet long enough
  });

  test("multiple distinct files coalesce into one due-set, sorted", () => {
    const p = new IndexWatchPlanner({ debounceMs: 100 });
    p.record("b/y.md", 1000);
    p.record("a/x.md", 1000);
    expect(p.due(1200)).toEqual(["a/x.md", "b/y.md"]);
  });

  test("take() returns the due paths and removes them from the pending set", () => {
    const p = new IndexWatchPlanner({ debounceMs: 100 });
    p.record("a.md", 1000);
    p.record("b.md", 1000);
    expect(p.take(1200)).toEqual(["a.md", "b.md"]);
    expect(p.pendingCount).toBe(0);
    expect(p.due(2000)).toEqual([]);
  });

  test("take() leaves not-yet-due paths pending", () => {
    const p = new IndexWatchPlanner({ debounceMs: 500 });
    p.record("ready.md", 1000);
    p.record("fresh.md", 1400);
    expect(p.take(1600)).toEqual(["ready.md"]); // fresh.md still in window
    expect(p.pendingCount).toBe(1);
    expect(p.take(1900)).toEqual(["fresh.md"]);
  });

  test("re-recording a flushed path re-arms it", () => {
    const p = new IndexWatchPlanner({ debounceMs: 100 });
    p.record("a.md", 1000);
    expect(p.take(1200)).toEqual(["a.md"]);
    p.record("a.md", 2000);
    expect(p.due(2050)).toEqual([]);
    expect(p.due(2200)).toEqual(["a.md"]);
  });

  test("nextDueAt reports the earliest pending due time, null when empty", () => {
    const p = new IndexWatchPlanner({ debounceMs: 500 });
    expect(p.nextDueAt()).toBeNull();
    p.record("a.md", 1000);
    p.record("b.md", 1200);
    expect(p.nextDueAt()).toBe(1500); // a.md (1000) + 500
  });

  test("rejects a non-finite or negative debounce", () => {
    expect(() => new IndexWatchPlanner({ debounceMs: -1 })).toThrow();
    expect(() => new IndexWatchPlanner({ debounceMs: Number.NaN })).toThrow();
  });
});
