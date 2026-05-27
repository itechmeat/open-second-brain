/**
 * Task 7: `buildWeeklySynthesis(index, vault, weekEnd, cfg)`.
 *
 * Computes a 7-day window ending at the ISO date supplied, counts
 * events by kind, derives status transitions, retired-in-window list,
 * contradictions (`signal-suppressed` + `apply-evidence` where
 * `result === "violated"`), and the vault delta.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildTimelineIndex } from "../../../../src/core/brain/temporal/build-index.ts";
import { buildWeeklySynthesis } from "../../../../src/core/brain/temporal/weekly-brief.ts";
import { BRAIN_TEMPORAL_DEFAULTS } from "../../../../src/core/brain/policy.ts";

function makeVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "o2b-temporal-weekly-"));
  mkdirSync(join(dir, "Brain", "log"), { recursive: true });
  return dir;
}

interface FixtureEvent {
  readonly timestamp: string;
  readonly kind: string;
  readonly body: Record<string, string | ReadonlyArray<string>>;
}

function writeJsonl(vault: string, date: string, events: ReadonlyArray<FixtureEvent>): void {
  const lines = events
    .map((e) => JSON.stringify({ ts: e.timestamp, kind: e.kind, payload: e.body }))
    .join("\n");
  writeFileSync(join(vault, "Brain", "log", `${date}.jsonl`), lines + "\n");
}

let VAULT: string;
beforeEach(() => {
  VAULT = makeVault();
});

describe("buildWeeklySynthesis", () => {
  test("empty window - frozen empty-counts envelope", () => {
    const idx = buildTimelineIndex(VAULT, {});
    const brief = buildWeeklySynthesis(idx, VAULT, "2026-05-25", BRAIN_TEMPORAL_DEFAULTS);
    expect(brief.windowEnd).toBe("2026-05-25T00:00:00Z");
    expect(brief.retired.length).toBe(0);
    expect(brief.contradictions.length).toBe(0);
    expect(Object.isFrozen(brief)).toBe(true);
  });

  test("window covers exactly 7 days back from weekEnd", () => {
    const idx = buildTimelineIndex(VAULT, {});
    const brief = buildWeeklySynthesis(idx, VAULT, "2026-05-25", BRAIN_TEMPORAL_DEFAULTS);
    expect(brief.windowEnd).toBe("2026-05-25T00:00:00Z");
    expect(brief.windowStart).toBe("2026-05-18T00:00:00Z");
  });

  test("contradictions list combines signal-suppressed + apply-evidence violated", () => {
    writeJsonl(VAULT, "2026-05-20", [
      {
        timestamp: "2026-05-20T08:00:00Z",
        kind: "signal-suppressed",
        body: {
          signal: "[[sig-2026-05-20-foo]]",
          retired: "[[ret-foo]]",
          topic: "foo",
          reason: "rejected",
        },
      },
      {
        timestamp: "2026-05-20T10:00:00Z",
        kind: "apply-evidence",
        body: {
          preference: "[[pref-foo|First]]",
          artifact: "[[src/cli/main.ts]]",
          agent: "claude",
          result: "violated",
        },
      },
      {
        timestamp: "2026-05-20T12:00:00Z",
        kind: "apply-evidence",
        body: {
          preference: "[[pref-foo|First]]",
          artifact: "[[src/cli/other.ts]]",
          agent: "claude",
          result: "applied",
        },
      },
    ]);
    const idx = buildTimelineIndex(VAULT, {});
    const brief = buildWeeklySynthesis(idx, VAULT, "2026-05-25", BRAIN_TEMPORAL_DEFAULTS);
    expect(brief.contradictions.length).toBe(2);
    // signal-suppressed contributes one; apply-evidence violated one.
    const kinds = brief.contradictions.map((c) => c.kind).toSorted();
    expect(kinds).toEqual(["evidence-violated", "signal-suppressed"]);
  });

  test("retired list collects retire transitions in window", () => {
    writeJsonl(VAULT, "2026-05-22", [
      {
        timestamp: "2026-05-22T08:00:00Z",
        kind: "dream",
        body: {
          run_id: "r1",
          retired: ["[[ret-foo|First]] (stale)"],
        },
      },
    ]);
    const idx = buildTimelineIndex(VAULT, {});
    const brief = buildWeeklySynthesis(idx, VAULT, "2026-05-25", BRAIN_TEMPORAL_DEFAULTS);
    expect(brief.retired.length).toBe(1);
    expect(brief.retired[0]!.prefId).toBe("ret-foo");
  });

  test("vaultDelta counters reflect 7-day window", () => {
    writeJsonl(VAULT, "2026-05-19", [
      {
        timestamp: "2026-05-19T08:00:00Z",
        kind: "feedback",
        body: {
          signal: "[[sig-2026-05-19-foo]]",
          topic: "foo",
          sign: "positive",
          agent: "claude",
        },
      },
    ]);
    writeJsonl(VAULT, "2026-05-22", [
      {
        timestamp: "2026-05-22T08:00:00Z",
        kind: "apply-evidence",
        body: {
          preference: "[[pref-foo|F]]",
          artifact: "[[a.ts]]",
          agent: "claude",
          result: "applied",
        },
      },
    ]);
    const idx = buildTimelineIndex(VAULT, {});
    const brief = buildWeeklySynthesis(idx, VAULT, "2026-05-25", BRAIN_TEMPORAL_DEFAULTS);
    expect(brief.vaultDelta.newFeedback).toBe(1);
    expect(brief.vaultDelta.evidenceApplied).toBe(1);
  });
});
