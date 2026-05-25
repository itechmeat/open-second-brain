/**
 * Task 6: `buildDailyBrief(index, vault, date)`.
 *
 * Returns a frozen deterministic envelope:
 *   - eventsByKind: count per BrainLogEventKind for the day
 *   - statusTransitions: list of pref-id status changes in the day
 *   - vaultDelta: newPromotions, newRetired, newFeedback, evidenceApplied, evidenceViolated counters
 *   - sourcePointers: deduplicated list of artifact wikilinks cited by evidence events
 *   - generatedAt
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildTimelineIndex } from "../../../../src/core/brain/temporal/build-index.ts";
import { buildDailyBrief } from "../../../../src/core/brain/temporal/daily-brief.ts";

function makeVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "o2b-temporal-daily-"));
  mkdirSync(join(dir, "Brain", "log"), { recursive: true });
  mkdirSync(join(dir, "Brain", "preferences"), { recursive: true });
  return dir;
}

interface FixtureEvent {
  readonly timestamp: string;
  readonly kind: string;
  readonly body: Record<string, string | ReadonlyArray<string>>;
}

function writeJsonl(
  vault: string,
  date: string,
  events: ReadonlyArray<FixtureEvent>,
): void {
  const lines = events
    .map((e) =>
      JSON.stringify({ ts: e.timestamp, kind: e.kind, payload: e.body }),
    )
    .join("\n");
  writeFileSync(join(vault, "Brain", "log", `${date}.jsonl`), lines + "\n");
}

let VAULT: string;
beforeEach(() => {
  VAULT = makeVault();
});

describe("buildDailyBrief", () => {
  test("empty day - frozen empty-counts envelope", () => {
    const idx = buildTimelineIndex(VAULT, {});
    const brief = buildDailyBrief(idx, VAULT, "2026-05-25");
    expect(brief.date).toBe("2026-05-25");
    expect(brief.vaultDelta.newPromotions).toBe(0);
    expect(brief.vaultDelta.newRetired).toBe(0);
    expect(brief.vaultDelta.newFeedback).toBe(0);
    expect(brief.vaultDelta.evidenceApplied).toBe(0);
    expect(brief.vaultDelta.evidenceViolated).toBe(0);
    expect(brief.statusTransitions.length).toBe(0);
    expect(brief.sourcePointers.length).toBe(0);
    expect(Object.isFrozen(brief)).toBe(true);
  });

  test("counts events by kind and computes vaultDelta", () => {
    writeJsonl(VAULT, "2026-05-25", [
      {
        timestamp: "2026-05-25T08:00:00Z",
        kind: "dream",
        body: {
          run_id: "r1",
          confirmed: ["[[pref-foo|First]]"],
          retired: ["[[ret-baz|Old]] (stale-no-evidence)"],
        },
      },
      {
        timestamp: "2026-05-25T09:00:00Z",
        kind: "feedback",
        body: {
          signal: "[[sig-2026-05-25-foo]]",
          topic: "foo",
          sign: "positive",
          agent: "claude",
        },
      },
      {
        timestamp: "2026-05-25T10:00:00Z",
        kind: "apply-evidence",
        body: {
          preference: "[[pref-foo|First]]",
          artifact: "[[src/cli/main.ts]]",
          agent: "claude",
          result: "applied",
        },
      },
      {
        timestamp: "2026-05-25T11:00:00Z",
        kind: "apply-evidence",
        body: {
          preference: "[[pref-foo|First]]",
          artifact: "[[src/cli/other.ts]]",
          agent: "claude",
          result: "violated",
        },
      },
    ]);
    const idx = buildTimelineIndex(VAULT, {});
    const brief = buildDailyBrief(idx, VAULT, "2026-05-25");
    expect(brief.eventsByKind.dream).toBe(1);
    expect(brief.eventsByKind.feedback).toBe(1);
    expect(brief.eventsByKind["apply-evidence"]).toBe(2);
    expect(brief.vaultDelta.newPromotions).toBe(1);
    expect(brief.vaultDelta.newRetired).toBe(1);
    expect(brief.vaultDelta.newFeedback).toBe(1);
    expect(brief.vaultDelta.evidenceApplied).toBe(1);
    expect(brief.vaultDelta.evidenceViolated).toBe(1);
  });

  test("statusTransitions list contains promotion + retirement entries", () => {
    writeJsonl(VAULT, "2026-05-25", [
      {
        timestamp: "2026-05-25T08:00:00Z",
        kind: "dream",
        body: {
          run_id: "r1",
          new_unconfirmed: ["[[pref-new|Newly minted]]"],
          confirmed: ["[[pref-foo|First]]"],
          retired: ["[[ret-baz|Old]] (stale)"],
        },
      },
    ]);
    const idx = buildTimelineIndex(VAULT, {});
    const brief = buildDailyBrief(idx, VAULT, "2026-05-25");
    expect(brief.statusTransitions.length).toBe(3);
    const kinds = brief.statusTransitions.map((t) => t.kind).sort();
    expect(kinds).toEqual(["creation", "promotion", "retirement"]);
  });

  test("sourcePointers deduplicates artifact wikilinks from evidence", () => {
    writeJsonl(VAULT, "2026-05-25", [
      {
        timestamp: "2026-05-25T08:00:00Z",
        kind: "apply-evidence",
        body: {
          preference: "[[pref-a|A]]",
          artifact: "[[src/x.ts]]",
          agent: "claude",
          result: "applied",
        },
      },
      {
        timestamp: "2026-05-25T09:00:00Z",
        kind: "apply-evidence",
        body: {
          preference: "[[pref-b|B]]",
          artifact: "[[src/x.ts]]",
          agent: "claude",
          result: "applied",
        },
      },
      {
        timestamp: "2026-05-25T10:00:00Z",
        kind: "apply-evidence",
        body: {
          preference: "[[pref-c|C]]",
          artifact: "[[src/y.ts]]",
          agent: "claude",
          result: "violated",
        },
      },
    ]);
    const idx = buildTimelineIndex(VAULT, {});
    const brief = buildDailyBrief(idx, VAULT, "2026-05-25");
    expect(brief.sourcePointers.length).toBe(2);
    expect(brief.sourcePointers).toContain("src/x.ts");
    expect(brief.sourcePointers).toContain("src/y.ts");
  });

  test("midnight-boundary event at since is included, at until is excluded", () => {
    writeJsonl(VAULT, "2026-05-25", [
      {
        timestamp: "2026-05-25T00:00:00Z",
        kind: "feedback",
        body: {
          signal: "[[sig-2026-05-25-edge-since]]",
          topic: "edge",
          sign: "positive",
          agent: "claude",
        },
      },
    ]);
    writeJsonl(VAULT, "2026-05-26", [
      {
        timestamp: "2026-05-26T00:00:00Z",
        kind: "feedback",
        body: {
          signal: "[[sig-2026-05-26-edge-until]]",
          topic: "edge",
          sign: "positive",
          agent: "claude",
        },
      },
    ]);
    const idx = buildTimelineIndex(VAULT, {
      since: "2026-05-01T00:00:00Z",
      until: "2026-06-01T00:00:00Z",
    });
    const brief = buildDailyBrief(idx, VAULT, "2026-05-25");
    // since=2026-05-25T00:00:00Z (inclusive) -> event at exact since
    // is counted. until=2026-05-26T00:00:00Z (exclusive) -> event at
    // exact until is NOT counted.
    expect(brief.vaultDelta.newFeedback).toBe(1);
  });

  test("daily window respects daily_window_offset_hours config", () => {
    // Event at 03:30 UTC on May 26 falls into the May 26 brief by
    // default (offset 0 = UTC days). The index needs an explicit
    // `until` past the event timestamp because the wall clock during
    // test runs may sit anywhere in real time.
    writeJsonl(VAULT, "2026-05-26", [
      {
        timestamp: "2026-05-26T03:30:00Z",
        kind: "feedback",
        body: {
          signal: "[[sig-2026-05-26-edge]]",
          topic: "edge",
          sign: "positive",
          agent: "claude",
        },
      },
    ]);
    const idx = buildTimelineIndex(VAULT, {
      since: "2026-05-01T00:00:00Z",
      until: "2026-06-01T00:00:00Z",
    });
    const brief = buildDailyBrief(idx, VAULT, "2026-05-26");
    expect(brief.vaultDelta.newFeedback).toBe(1);
  });
});
