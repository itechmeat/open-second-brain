/**
 * Task 3: `buildActivityTimeline(index, opts)` merged chronological
 * activity timeline renderer.
 *
 * Fixtures are built through the real `buildTimelineIndex` over a tmp
 * vault with `Brain/log/<date>.jsonl` day files (same pattern as
 * `build-index.test.ts` / `select-events.test.ts`), so the merge order
 * and tie-break rules this module relies on are pinned against the
 * actual index builder rather than a hand-rolled stand-in.
 *
 * One exception: the empty-age-label rendering branch requires an
 * event whose `at` is not a parseable timestamp, and `buildTimelineIndex`
 * only ever emits events with a disk-validated ISO timestamp (the JSONL
 * reader rejects any other shape). Hand-crafting a `TimelineIndex`
 * literal through the public `TemporalEvent` / `TimelineIndex` shapes is
 * the only way to exercise that branch, so that one test builds its
 * fixture directly instead of through disk.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildActivityTimeline } from "../../../../src/core/brain/temporal/activity-timeline.ts";
import { buildTimelineIndex } from "../../../../src/core/brain/temporal/build-index.ts";
import type { TemporalEvent, TimelineIndex } from "../../../../src/core/brain/temporal/types.ts";

function makeVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "o2b-activity-timeline-"));
  mkdirSync(join(dir, "Brain", "log"), { recursive: true });
  mkdirSync(join(dir, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(dir, "Brain", "retired"), { recursive: true });
  return dir;
}

interface FixtureEvent {
  readonly timestamp: string;
  readonly kind: string;
  readonly body: Record<string, string | ReadonlyArray<string>>;
}

function writeJsonlDay(vault: string, date: string, events: ReadonlyArray<FixtureEvent>): void {
  const lines = events
    .map((e) => JSON.stringify({ ts: e.timestamp, kind: e.kind, payload: e.body }))
    .join("\n");
  writeFileSync(join(vault, "Brain", "log", `${date}.jsonl`), lines + "\n");
}

let VAULT: string;
beforeEach(() => {
  VAULT = makeVault();
});

describe("buildActivityTimeline - merge order and tie-break", () => {
  test("merges events across kinds newest-first, matching buildTimelineIndex's chronological order reversed", () => {
    writeJsonlDay(VAULT, "2026-05-20", [
      { timestamp: "2026-05-20T08:00:00Z", kind: "note", body: { text: "morning note" } },
    ]);
    writeJsonlDay(VAULT, "2026-05-21", [
      {
        timestamp: "2026-05-21T09:00:00Z",
        kind: "feedback",
        body: { signal: "[[sig-2026-05-21-foo]]", topic: "foo" },
      },
    ]);
    writeJsonlDay(VAULT, "2026-05-22", [
      {
        timestamp: "2026-05-22T10:00:00Z",
        kind: "apply-evidence",
        body: { preference: "[[pref-bar|Bar]]", artifact: "[[a.ts]]", result: "applied" },
      },
    ]);
    const idx = buildTimelineIndex(VAULT, {});
    const tl = buildActivityTimeline(idx, { now: new Date("2026-05-23T00:00:00Z") });
    expect(tl.entries.map((e) => e.kind)).toEqual(["apply-evidence", "feedback", "note"]);
    expect(tl.entries.map((e) => e.at)).toEqual([
      "2026-05-22T10:00:00Z",
      "2026-05-21T09:00:00Z",
      "2026-05-20T08:00:00Z",
    ]);
  });

  test("tie-break stability: same timestamp across kinds keeps compareEvents's source.path order, reversed", () => {
    // Two events at the identical instant land in the same day file at
    // different line offsets; buildTimelineIndex's compareEvents breaks
    // the `at` tie by source.path then source.line (both events share
    // the same file, so line order decides). Ascending index order is
    // [line 1, line 2]; buildActivityTimeline must reverse that to
    // [line 2, line 1] for its newest-first contract.
    writeJsonlDay(VAULT, "2026-05-20", [
      { timestamp: "2026-05-20T08:00:00Z", kind: "note", body: { text: "first-in-file" } },
      { timestamp: "2026-05-20T08:00:00Z", kind: "note", body: { text: "second-in-file" } },
    ]);
    const idx = buildTimelineIndex(VAULT, {});
    // Pin the premise: the index itself is ascending oldest-first with
    // this tie-break, so the renderer's reversal is the only thing
    // under test here.
    expect(idx.events.map((e) => e.text)).toEqual(["first-in-file", "second-in-file"]);
    const tl = buildActivityTimeline(idx, { now: new Date("2026-05-20T09:00:00Z") });
    expect(tl.entries.map((e) => e.text)).toEqual(["second-in-file", "first-in-file"]);
  });

  test("does not mutate the index's events array", () => {
    writeJsonlDay(VAULT, "2026-05-20", [
      { timestamp: "2026-05-20T08:00:00Z", kind: "note", body: { text: "a" } },
      { timestamp: "2026-05-20T09:00:00Z", kind: "note", body: { text: "b" } },
    ]);
    const idx = buildTimelineIndex(VAULT, {});
    const before = idx.events.map((e) => e.text);
    buildActivityTimeline(idx, { now: new Date("2026-05-21T00:00:00Z") });
    expect(idx.events.map((e) => e.text)).toEqual(before);
    expect(Object.isFrozen(idx.events)).toBe(true);
  });
});

describe("buildActivityTimeline - limit and total", () => {
  beforeEach(() => {
    writeJsonlDay(VAULT, "2026-05-20", [
      { timestamp: "2026-05-20T08:00:00Z", kind: "note", body: { text: "one" } },
      { timestamp: "2026-05-20T09:00:00Z", kind: "note", body: { text: "two" } },
      { timestamp: "2026-05-20T10:00:00Z", kind: "note", body: { text: "three" } },
      { timestamp: "2026-05-20T11:00:00Z", kind: "note", body: { text: "four" } },
      { timestamp: "2026-05-20T12:00:00Z", kind: "note", body: { text: "five" } },
    ]);
  });

  test("no limit returns every windowed event with total matching entry count", () => {
    const idx = buildTimelineIndex(VAULT, {});
    const tl = buildActivityTimeline(idx, { now: new Date("2026-05-21T00:00:00Z") });
    expect(tl.entries.length).toBe(5);
    expect(tl.total).toBe(5);
  });

  test("limit truncates the newest-first list; total keeps the full windowed count", () => {
    const idx = buildTimelineIndex(VAULT, {});
    const tl = buildActivityTimeline(idx, { now: new Date("2026-05-21T00:00:00Z"), limit: 2 });
    expect(tl.entries.map((e) => e.text)).toEqual(["five", "four"]);
    expect(tl.total).toBe(5);
  });

  test("limit larger than the windowed count returns everything with no error", () => {
    const idx = buildTimelineIndex(VAULT, {});
    const tl = buildActivityTimeline(idx, { now: new Date("2026-05-21T00:00:00Z"), limit: 100 });
    expect(tl.entries.length).toBe(5);
    expect(tl.total).toBe(5);
  });

  test("limit 0 returns zero entries but preserves the total count", () => {
    const idx = buildTimelineIndex(VAULT, {});
    const tl = buildActivityTimeline(idx, { now: new Date("2026-05-21T00:00:00Z"), limit: 0 });
    expect(tl.entries.length).toBe(0);
    expect(tl.bullets.length).toBe(0);
    expect(tl.total).toBe(5);
  });

  test("negative limit is a fail-closed rejection, not a silent fallback", () => {
    const idx = buildTimelineIndex(VAULT, {});
    expect(() =>
      buildActivityTimeline(idx, { now: new Date("2026-05-21T00:00:00Z"), limit: -1 }),
    ).toThrow();
  });

  test("non-integer limit is a fail-closed rejection", () => {
    const idx = buildTimelineIndex(VAULT, {});
    expect(() =>
      buildActivityTimeline(idx, { now: new Date("2026-05-21T00:00:00Z"), limit: 1.5 }),
    ).toThrow();
  });
});

describe("buildActivityTimeline - window filtering", () => {
  beforeEach(() => {
    writeJsonlDay(VAULT, "2026-05-20", [
      { timestamp: "2026-05-20T00:00:00Z", kind: "note", body: { text: "lower-boundary" } },
      { timestamp: "2026-05-20T12:00:00Z", kind: "note", body: { text: "inside" } },
    ]);
    writeJsonlDay(VAULT, "2026-05-21", [
      { timestamp: "2026-05-21T00:00:00Z", kind: "note", body: { text: "upper-boundary" } },
    ]);
  });

  test("since is inclusive and until is exclusive, matching selectEvents's own contract", () => {
    const idx = buildTimelineIndex(VAULT, {});
    const tl = buildActivityTimeline(idx, {
      now: new Date("2026-05-22T00:00:00Z"),
      since: "2026-05-20T00:00:00Z",
      until: "2026-05-21T00:00:00Z",
    });
    // lower-boundary included (since inclusive), upper-boundary excluded
    // (until exclusive); newest-first order.
    expect(tl.entries.map((e) => e.text)).toEqual(["inside", "lower-boundary"]);
    expect(tl.total).toBe(2);
  });

  test("since alone narrows the lower bound only", () => {
    const idx = buildTimelineIndex(VAULT, {});
    const tl = buildActivityTimeline(idx, {
      now: new Date("2026-05-22T00:00:00Z"),
      since: "2026-05-20T12:00:00Z",
    });
    expect(tl.entries.map((e) => e.text)).toEqual(["upper-boundary", "inside"]);
  });

  test("until alone narrows the upper bound only", () => {
    const idx = buildTimelineIndex(VAULT, {});
    const tl = buildActivityTimeline(idx, {
      now: new Date("2026-05-22T00:00:00Z"),
      until: "2026-05-20T12:00:00Z",
    });
    expect(tl.entries.map((e) => e.text)).toEqual(["lower-boundary"]);
  });
});

describe("buildActivityTimeline - bullet rendering and age labels", () => {
  test("bullet shape is `- [<kind>] <text> - <age>` with the age separated by a middle dot", () => {
    writeJsonlDay(VAULT, "2026-05-20", [
      { timestamp: "2026-05-20T00:00:00Z", kind: "note", body: { text: "shipped v1" } },
    ]);
    const idx = buildTimelineIndex(VAULT, {});
    const tl = buildActivityTimeline(idx, { now: new Date("2026-05-20T00:05:00Z") });
    expect(tl.bullets).toEqual(["- [note] shipped v1 · 5m ago"]);
    expect(tl.text).toBe("- [note] shipped v1 · 5m ago");
  });

  test("omits the age suffix entirely when relativeAge returns empty (unparseable timestamp)", () => {
    // relativeAge only returns "" for an unparseable `at`, and
    // buildTimelineIndex's JSONL reader validates every `at` it emits
    // against a strict ISO regex - so this branch cannot be reached
    // through a disk fixture. Hand-craft a minimal TimelineIndex
    // through the public TemporalEvent/TimelineIndex shapes instead.
    const ev: TemporalEvent = Object.freeze({
      at: "not-a-real-timestamp",
      kind: "note",
      source: Object.freeze({ path: "Brain/log/2026-05-20.jsonl", line: 1 }),
      text: "garbled clock event",
    });
    const idx: TimelineIndex = Object.freeze({
      events: Object.freeze([ev]),
      eventsByKind: new Map([["note", Object.freeze([ev])]]) as TimelineIndex["eventsByKind"],
      eventsByPrefId: new Map() as TimelineIndex["eventsByPrefId"],
      eventsByTopic: new Map() as TimelineIndex["eventsByTopic"],
      window: Object.freeze({ since: "1970-01-01T00:00:00Z", until: "2999-01-01T00:00:00Z" }),
    });
    const tl = buildActivityTimeline(idx, { now: new Date("2026-05-20T00:05:00Z") });
    expect(tl.entries.length).toBe(1);
    expect(tl.entries[0]!.ageLabel).toBe("");
    expect(tl.bullets).toEqual(["- [note] garbled clock event"]);
  });

  test("joined text concatenates bullets with newlines", () => {
    writeJsonlDay(VAULT, "2026-05-20", [
      { timestamp: "2026-05-20T00:00:00Z", kind: "note", body: { text: "first" } },
      { timestamp: "2026-05-20T01:00:00Z", kind: "note", body: { text: "second" } },
    ]);
    const idx = buildTimelineIndex(VAULT, {});
    const tl = buildActivityTimeline(idx, { now: new Date("2026-05-20T02:00:00Z") });
    expect(tl.text).toBe(tl.bullets.join("\n"));
    expect(tl.text.split("\n").length).toBe(2);
  });
});

describe("buildActivityTimeline - structural per-kind text derivation", () => {
  test("note events use the text field verbatim", () => {
    writeJsonlDay(VAULT, "2026-05-20", [
      { timestamp: "2026-05-20T00:00:00Z", kind: "note", body: { text: "Release v1 shipped" } },
    ]);
    const idx = buildTimelineIndex(VAULT, {});
    const tl = buildActivityTimeline(idx, { now: new Date("2026-05-20T01:00:00Z") });
    expect(tl.entries[0]!.text).toBe("Release v1 shipped");
  });

  test("apply-evidence events derive from pref id plus result, in that order", () => {
    writeJsonlDay(VAULT, "2026-05-20", [
      {
        timestamp: "2026-05-20T00:00:00Z",
        kind: "apply-evidence",
        body: { preference: "[[pref-foo|Principle]]", artifact: "[[a.ts]]", result: "applied" },
      },
    ]);
    const idx = buildTimelineIndex(VAULT, {});
    const tl = buildActivityTimeline(idx, { now: new Date("2026-05-20T01:00:00Z") });
    expect(tl.entries[0]!.text).toBe("pref=pref-foo result=applied artifact=a.ts");
  });

  test("reconcile events with a topic derive from the topic field", () => {
    writeJsonlDay(VAULT, "2026-05-20", [
      {
        timestamp: "2026-05-20T00:00:00Z",
        kind: "reconcile",
        body: { topic: "release-cadence", domain: "claims", reason: "no auto-resolution" },
      },
    ]);
    const idx = buildTimelineIndex(VAULT, {});
    const tl = buildActivityTimeline(idx, { now: new Date("2026-05-20T01:00:00Z") });
    expect(tl.entries[0]!.text).toBe("topic=release-cadence reason=no auto-resolution");
  });

  test("an event with no usable field falls back to kind plus its source pointer", () => {
    writeJsonlDay(VAULT, "2026-05-20", [
      {
        timestamp: "2026-05-20T00:00:00Z",
        kind: "scan-inline",
        body: { scanned: "3", created: "1", deduped: "0", malformed: "0" },
      },
    ]);
    const idx = buildTimelineIndex(VAULT, {});
    const tl = buildActivityTimeline(idx, { now: new Date("2026-05-20T01:00:00Z") });
    expect(tl.entries[0]!.text).toBe("scan-inline (Brain/log/2026-05-20.jsonl:1)");
  });
});

describe("buildActivityTimeline - determinism and framing", () => {
  test("two calls with identical inputs produce identical output", () => {
    writeJsonlDay(VAULT, "2026-05-20", [
      { timestamp: "2026-05-20T00:00:00Z", kind: "note", body: { text: "a" } },
      { timestamp: "2026-05-20T01:00:00Z", kind: "feedback", body: { topic: "b" } },
    ]);
    const idx = buildTimelineIndex(VAULT, {});
    const now = new Date("2026-05-20T02:00:00Z");
    const first = buildActivityTimeline(idx, { now });
    const second = buildActivityTimeline(idx, { now });
    expect(first).toEqual(second);
  });

  test("envelope and its arrays are frozen", () => {
    writeJsonlDay(VAULT, "2026-05-20", [
      { timestamp: "2026-05-20T00:00:00Z", kind: "note", body: { text: "a" } },
    ]);
    const idx = buildTimelineIndex(VAULT, {});
    const tl = buildActivityTimeline(idx, { now: new Date("2026-05-20T01:00:00Z") });
    expect(Object.isFrozen(tl)).toBe(true);
    expect(Object.isFrozen(tl.entries)).toBe(true);
    expect(Object.isFrozen(tl.entries[0])).toBe(true);
    expect(Object.isFrozen(tl.bullets)).toBe(true);
  });

  test("empty index returns a frozen empty envelope", () => {
    const idx = buildTimelineIndex(VAULT, {});
    const tl = buildActivityTimeline(idx, { now: new Date("2026-05-20T01:00:00Z") });
    expect(tl.entries.length).toBe(0);
    expect(tl.bullets.length).toBe(0);
    expect(tl.text).toBe("");
    expect(tl.total).toBe(0);
  });
});
