/**
 * Tests for `src/core/brain/most-applied.ts` (v0.10.10).
 *
 * Drives §6.1 of `docs/plans/2026-05-20-v0.10.10-design.md` — the
 * sliding 30-day applied-evidence ranker that backs the
 * `Most-applied (30d)` section of `Brain/active.md`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeMostApplied } from "../../../src/core/brain/most-applied.ts";
import { appendLogEvent } from "../../../src/core/brain/log.ts";
import type { BrainPreference } from "../../../src/core/brain/types.ts";
import {
  BRAIN_APPLY_RESULT,
  BRAIN_LOG_EVENT_KIND,
  BRAIN_PREFERENCE_STATUS,
} from "../../../src/core/brain/types.ts";

/**
 * Build a minimal `BrainPreference` with the fields the ranker actually
 * reads (`id`, `status`). The remaining fields are filled with type-safe
 * placeholders so the value satisfies the interface without dragging
 * unrelated test-shape concerns into this file.
 */
function buildPref(
  id: string,
  overrides: Partial<BrainPreference> = {},
): BrainPreference {
  const base: BrainPreference = {
    kind: "brain-preference",
    id,
    created_at: "2026-04-01T00:00:00Z",
    confirmed_at: null,
    unconfirmed_until: "2026-04-08T00:00:00Z",
    tags: [],
    topic: id.replace(/^pref-/, ""),
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    principle: `principle for ${id}`,
    evidenced_by: [],
    applied_count: 0,
    violated_count: 0,
    last_evidence_at: null,
    confidence: "medium",
    confidence_value: 0.5,
    pinned: false,
  };
  return { ...base, ...overrides };
}

function seedApplied(
  vault: string,
  timestamp: string,
  prefWikilink: string,
  result: string = BRAIN_APPLY_RESULT.applied,
): void {
  appendLogEvent(vault, {
    timestamp,
    eventType: BRAIN_LOG_EVENT_KIND.applyEvidence,
    body: {
      preference: prefWikilink,
      artifact: "[[src/foo.ts]]",
      agent: "tester",
      result,
    },
  });
}

function writeMalformedLogDay(vault: string, date: string, body: string): void {
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
  writeFileSync(join(vault, "Brain", "log", `${date}.md`), body, "utf8");
}

describe("computeMostApplied", () => {
  let vault: string;
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "osb-most-applied-"));
    // `_brain.yaml` is required by some downstream readers; create
    // the directory shell so `brainDirs(vault)` resolves cleanly.
    mkdirSync(join(vault, "Brain"), { recursive: true });
  });
  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  test("returns empty when log directory is missing", () => {
    const result = computeMostApplied(vault, [buildPref("pref-a")], {
      now: new Date("2026-05-20T00:00:00Z"),
    });
    expect(result).toEqual([]);
  });

  test("counts only result=applied events inside the 30d window", () => {
    const now = new Date("2026-05-20T00:00:00Z");
    seedApplied(vault, "2026-05-15T10:00:00Z", "[[pref-a]]");
    seedApplied(vault, "2026-05-15T10:05:00Z", "[[pref-a]]");
    // 31 days ago — outside the window.
    seedApplied(vault, "2026-04-19T10:00:00Z", "[[pref-a]]");
    const result = computeMostApplied(vault, [buildPref("pref-a")], { now });
    expect(result.length).toBe(1);
    expect(result[0]!.applied_30d).toBe(2);
  });

  test("ignores violated and outdated results", () => {
    const now = new Date("2026-05-20T00:00:00Z");
    seedApplied(vault, "2026-05-15T10:00:00Z", "[[pref-a]]", BRAIN_APPLY_RESULT.violated);
    seedApplied(vault, "2026-05-15T10:05:00Z", "[[pref-a]]", BRAIN_APPLY_RESULT.outdated);
    const result = computeMostApplied(vault, [buildPref("pref-a")], { now });
    expect(result).toEqual([]);
  });

  test("excludes events whose preference is not in the caller's list", () => {
    const now = new Date("2026-05-20T00:00:00Z");
    seedApplied(vault, "2026-05-15T10:00:00Z", "[[pref-a]]");
    // Caller passes ONLY confirmed/quarantine preferences. Retired
    // preferences are dropped by the caller before reaching this
    // function, so an event referencing pref-a with no matching
    // entry in the candidate list is silently ignored.
    const result = computeMostApplied(vault, [], { now });
    expect(result).toEqual([]);
  });

  test("includes quarantine preferences", () => {
    const now = new Date("2026-05-20T00:00:00Z");
    seedApplied(vault, "2026-05-15T10:00:00Z", "[[pref-q]]");
    const result = computeMostApplied(
      vault,
      [buildPref("pref-q", { status: BRAIN_PREFERENCE_STATUS.quarantine })],
      { now },
    );
    expect(result.length).toBe(1);
    expect(result[0]!.preference.id).toBe("pref-q");
    expect(result[0]!.applied_30d).toBe(1);
  });

  test("sorts by count desc, then by id asc", () => {
    const now = new Date("2026-05-20T00:00:00Z");
    seedApplied(vault, "2026-05-15T10:00:00Z", "[[pref-a]]");
    seedApplied(vault, "2026-05-15T10:01:00Z", "[[pref-a]]");
    seedApplied(vault, "2026-05-15T10:02:00Z", "[[pref-b]]");
    seedApplied(vault, "2026-05-15T10:03:00Z", "[[pref-c]]");
    const result = computeMostApplied(
      vault,
      [buildPref("pref-a"), buildPref("pref-b"), buildPref("pref-c")],
      { now },
    );
    expect(result.map((r) => r.preference.id)).toEqual([
      "pref-a",
      "pref-b",
      "pref-c",
    ]);
    expect(result[0]!.applied_30d).toBe(2);
  });

  test("honours limit", () => {
    const now = new Date("2026-05-20T00:00:00Z");
    seedApplied(vault, "2026-05-15T10:00:00Z", "[[pref-a]]");
    seedApplied(vault, "2026-05-15T10:00:01Z", "[[pref-b]]");
    seedApplied(vault, "2026-05-15T10:00:02Z", "[[pref-c]]");
    const result = computeMostApplied(
      vault,
      [buildPref("pref-a"), buildPref("pref-b"), buildPref("pref-c")],
      { now, limit: 2 },
    );
    expect(result.length).toBe(2);
  });

  test("normalises wikilinks with alias decoration", () => {
    // `renderPrefLink` (used by apply-evidence writers) emits
    // `[[pref-id|principle title]]` — the alias must collapse to the
    // bare id before the count lookup. Same shape `normaliseWikilinkTarget`
    // already strips on the read side.
    const now = new Date("2026-05-20T00:00:00Z");
    seedApplied(
      vault,
      "2026-05-15T10:00:00Z",
      "[[pref-a|principle title with spaces]]",
    );
    const result = computeMostApplied(vault, [buildPref("pref-a")], { now });
    expect(result.length).toBe(1);
    expect(result[0]!.applied_30d).toBe(1);
  });

  test("survives a malformed log day", () => {
    const now = new Date("2026-05-20T00:00:00Z");
    // Raw write bypasses `appendLogEvent` validation — required to
    // simulate a hand-edited corrupted day file. Pair with a real
    // event from the day next to it so the function still makes
    // progress.
    writeMalformedLogDay(vault, "2026-05-14", "this is not a valid log file");
    seedApplied(vault, "2026-05-15T10:00:00Z", "[[pref-a]]");
    const result = computeMostApplied(vault, [buildPref("pref-a")], { now });
    expect(result.length).toBe(1);
    expect(result[0]!.applied_30d).toBe(1);
  });

  test("event exactly on the window edge is included", () => {
    const now = new Date("2026-05-20T00:00:00Z");
    const windowStart = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
    const stamp = windowStart.toISOString().replace(/\.\d{3}Z$/, "Z");
    seedApplied(vault, stamp, "[[pref-a]]");
    const result = computeMostApplied(vault, [buildPref("pref-a")], { now });
    expect(result.length).toBe(1);
  });

  test("event exactly at now is included", () => {
    const now = new Date("2026-05-20T00:00:00Z");
    seedApplied(vault, "2026-05-20T00:00:00Z", "[[pref-a]]");
    const result = computeMostApplied(vault, [buildPref("pref-a")], { now });
    expect(result.length).toBe(1);
  });
});
