/**
 * Tests for `src/core/brain/lessons.ts` (t_62363378).
 *
 * Drives the unified, signed, recency-scored lessons corpus:
 *   - positive (apply-evidence `applied`) vs negative (`violated` /
 *     `outdated`, plus dead-end notes) outcomes folded into one score;
 *   - a signed, exponentially-decayed weight so a fresh dead-end
 *     outweighs a stale "useful";
 *   - a ≥N-distinct-results corroboration gate promoting `tentative`
 *     to `preferred`, with mixed-signal nodes rendered `contested`
 *     (recency-wins) and purely-negative nodes `avoid`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  computeLessons,
  regenerateLessons,
  LESSON_TIER,
  LESSON_STANCE,
} from "../../../src/core/brain/lessons.ts";
import { appendLogEvent } from "../../../src/core/brain/log.ts";
import { recordDeadEnd } from "../../../src/core/brain/dead-ends.ts";
import type { BrainPreference } from "../../../src/core/brain/types.ts";
import {
  BRAIN_APPLY_RESULT,
  BRAIN_LOG_EVENT_KIND,
  BRAIN_PREFERENCE_STATUS,
} from "../../../src/core/brain/types.ts";
import type { DeadEndEntry } from "../../../src/core/brain/dead-ends.ts";

const NOW = new Date("2026-05-20T00:00:00Z");

function buildPref(id: string, overrides: Partial<BrainPreference> = {}): BrainPreference {
  const base: BrainPreference = {
    kind: "brain-preference",
    id,
    created_at: "2026-01-01T00:00:00Z",
    confirmed_at: null,
    unconfirmed_until: "2026-01-08T00:00:00Z",
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

function seed(
  vault: string,
  timestamp: string,
  prefWikilink: string,
  result: string,
  artifact = "[[src/foo.ts]]",
): void {
  appendLogEvent(vault, {
    timestamp,
    eventType: BRAIN_LOG_EVENT_KIND.applyEvidence,
    body: { preference: prefWikilink, artifact, agent: "tester", result },
  });
}

/** A lightweight dead-end entry (only the fields computeLessons reads). */
function deadEnd(id: string, approach: string, created_at: string): DeadEndEntry {
  return { id, path: `${id}.md`, approach, reason: "why", context: null, agent: "t", created_at };
}

describe("computeLessons", () => {
  let vault: string;
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "osb-lessons-"));
    mkdirSync(join(vault, "Brain"), { recursive: true });
  });
  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  test("empty corpus yields no lessons", () => {
    expect(computeLessons(vault, [], [], { now: NOW })).toEqual([]);
  });

  test("a preference with no outcome evidence is not yet a lesson", () => {
    const result = computeLessons(vault, [buildPref("pref-a")], [], { now: NOW });
    expect(result).toEqual([]);
  });

  test("two distinct applied artifacts promote to preferred", () => {
    seed(vault, "2026-05-18T00:00:00Z", "[[pref-a]]", BRAIN_APPLY_RESULT.applied, "[[a.ts]]");
    seed(vault, "2026-05-19T00:00:00Z", "[[pref-a]]", BRAIN_APPLY_RESULT.applied, "[[b.ts]]");
    const [lesson] = computeLessons(vault, [buildPref("pref-a")], [], { now: NOW });
    expect(lesson!.tier).toBe(LESSON_TIER.preferred);
    expect(lesson!.corroboration).toBe(2);
    expect(lesson!.signedScore).toBeGreaterThan(0);
  });

  test("a single applied artifact stays tentative (below corroboration floor)", () => {
    seed(vault, "2026-05-18T00:00:00Z", "[[pref-a]]", BRAIN_APPLY_RESULT.applied, "[[a.ts]]");
    seed(vault, "2026-05-19T00:00:00Z", "[[pref-a]]", BRAIN_APPLY_RESULT.applied, "[[a.ts]]");
    const [lesson] = computeLessons(vault, [buildPref("pref-a")], [], { now: NOW });
    expect(lesson!.tier).toBe(LESSON_TIER.tentative);
    expect(lesson!.corroboration).toBe(1); // same artifact twice = one distinct result
  });

  test("corroborationMin option gates promotion", () => {
    seed(vault, "2026-05-18T00:00:00Z", "[[pref-a]]", BRAIN_APPLY_RESULT.applied, "[[a.ts]]");
    seed(vault, "2026-05-19T00:00:00Z", "[[pref-a]]", BRAIN_APPLY_RESULT.applied, "[[b.ts]]");
    const [strict] = computeLessons(vault, [buildPref("pref-a")], [], {
      now: NOW,
      corroborationMin: 3,
    });
    expect(strict!.tier).toBe(LESSON_TIER.tentative);
  });

  test("mixed applied + violated evidence renders contested", () => {
    seed(vault, "2026-05-18T00:00:00Z", "[[pref-a]]", BRAIN_APPLY_RESULT.applied, "[[a.ts]]");
    seed(vault, "2026-05-18T00:00:00Z", "[[pref-a]]", BRAIN_APPLY_RESULT.violated, "[[b.ts]]");
    const [lesson] = computeLessons(vault, [buildPref("pref-a")], [], { now: NOW });
    expect(lesson!.tier).toBe(LESSON_TIER.contested);
    expect(lesson!.stance).not.toBeNull();
  });

  test("contested stance follows recency: a fresh violation outweighs a stale applied", () => {
    // Stale positive (~4 months old), fresh negative (2 days old).
    seed(vault, "2026-01-20T00:00:00Z", "[[pref-a]]", BRAIN_APPLY_RESULT.applied, "[[a.ts]]");
    seed(vault, "2026-05-18T00:00:00Z", "[[pref-a]]", BRAIN_APPLY_RESULT.violated, "[[b.ts]]");
    const [lesson] = computeLessons(vault, [buildPref("pref-a")], [], { now: NOW });
    expect(lesson!.tier).toBe(LESSON_TIER.contested);
    expect(lesson!.stance).toBe(LESSON_STANCE.negative);
    expect(lesson!.signedScore).toBeLessThan(0);
  });

  test("a rule only ever violated is avoid", () => {
    seed(vault, "2026-05-18T00:00:00Z", "[[pref-a]]", BRAIN_APPLY_RESULT.violated, "[[a.ts]]");
    const [lesson] = computeLessons(vault, [buildPref("pref-a")], [], { now: NOW });
    expect(lesson!.tier).toBe(LESSON_TIER.avoid);
    expect(lesson!.signedScore).toBeLessThan(0);
  });

  test("dead-ends are avoid lessons with a negative score", () => {
    const de = deadEnd("de-2026-05-18-x", "tried the flaky retry loop", "2026-05-18T00:00:00Z");
    const [lesson] = computeLessons(vault, [], [de], { now: NOW });
    expect(lesson!.kind).toBe("dead-end");
    expect(lesson!.tier).toBe(LESSON_TIER.avoid);
    expect(lesson!.negativeMass).toBeGreaterThan(0);
    expect(lesson!.positiveMass).toBe(0);
    expect(lesson!.title).toBe("tried the flaky retry loop");
  });

  test("recency: a fresh dead-end outscores a stale preference in salience ranking", () => {
    // Stale applied preference (~4 months old) vs a 1-day-old dead-end.
    seed(vault, "2026-01-20T00:00:00Z", "[[pref-old]]", BRAIN_APPLY_RESULT.applied, "[[a.ts]]");
    const de = deadEnd("de-2026-05-19-x", "fresh failed approach", "2026-05-19T00:00:00Z");
    const result = computeLessons(vault, [buildPref("pref-old")], [de], { now: NOW });
    // The fresh dead-end has larger decayed mass, so it ranks first.
    expect(result[0]!.id).toBe("de-2026-05-19-x");
  });

  test("outdated counts as a negative outcome", () => {
    seed(vault, "2026-05-18T00:00:00Z", "[[pref-a]]", BRAIN_APPLY_RESULT.outdated, "[[a.ts]]");
    const [lesson] = computeLessons(vault, [buildPref("pref-a")], [], { now: NOW });
    expect(lesson!.tier).toBe(LESSON_TIER.avoid);
  });

  test("evidence predating the preference's created_at is ignored", () => {
    const pref = buildPref("pref-a", { created_at: "2026-05-01T00:00:00Z" });
    seed(vault, "2026-04-01T00:00:00Z", "[[pref-a]]", BRAIN_APPLY_RESULT.applied, "[[a.ts]]");
    const result = computeLessons(vault, [pref], [], { now: NOW });
    expect(result).toEqual([]);
  });

  test("retired-status preferences are excluded from scoring", () => {
    seed(vault, "2026-05-18T00:00:00Z", "[[pref-a]]", BRAIN_APPLY_RESULT.applied, "[[a.ts]]");
    const pref = buildPref("pref-a", { status: "retired" as BrainPreference["status"] });
    expect(computeLessons(vault, [pref], [], { now: NOW })).toEqual([]);
  });

  test("wikilink aliases collapse to the bare id", () => {
    seed(
      vault,
      "2026-05-18T00:00:00Z",
      "[[pref-a|principle text]]",
      BRAIN_APPLY_RESULT.applied,
      "[[a.ts]]",
    );
    seed(
      vault,
      "2026-05-19T00:00:00Z",
      "[[pref-a|principle text]]",
      BRAIN_APPLY_RESULT.applied,
      "[[b.ts]]",
    );
    const [lesson] = computeLessons(vault, [buildPref("pref-a")], [], { now: NOW });
    expect(lesson!.tier).toBe(LESSON_TIER.preferred);
  });

  test("halfLifeDays option sharpens the decay", () => {
    // 30 days old applied event. A short half-life shrinks its weight.
    seed(vault, "2026-04-20T00:00:00Z", "[[pref-a]]", BRAIN_APPLY_RESULT.applied, "[[a.ts]]");
    const [gentle] = computeLessons(vault, [buildPref("pref-a")], [], {
      now: NOW,
      halfLifeDays: 60,
    });
    const [sharp] = computeLessons(vault, [buildPref("pref-a")], [], { now: NOW, halfLifeDays: 5 });
    expect(gentle!.signedScore).toBeGreaterThan(sharp!.signedScore);
  });

  test("limit truncates the ranked output", () => {
    const des = [
      deadEnd("de-1", "a", "2026-05-18T00:00:00Z"),
      deadEnd("de-2", "b", "2026-05-17T00:00:00Z"),
      deadEnd("de-3", "c", "2026-05-16T00:00:00Z"),
    ];
    const result = computeLessons(vault, [], des, { now: NOW, limit: 2 });
    expect(result.length).toBe(2);
  });

  test("output is deterministic and frozen", () => {
    seed(vault, "2026-05-18T00:00:00Z", "[[pref-a]]", BRAIN_APPLY_RESULT.applied, "[[a.ts]]");
    const first = computeLessons(vault, [buildPref("pref-a")], [], { now: NOW });
    const second = computeLessons(vault, [buildPref("pref-a")], [], { now: NOW });
    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first[0])).toBe(true);
  });
});

describe("regenerateLessons", () => {
  let vault: string;
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "osb-lessons-regen-"));
    mkdirSync(join(vault, "Brain"), { recursive: true });
  });
  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  test("writes a lessons.md digest and reports counts", () => {
    recordDeadEnd(vault, {
      approach: "polling loop that never converges",
      reason: "burned the token budget",
      agent: "tester",
      now: new Date("2026-05-18T00:00:00Z"),
    });
    const result = regenerateLessons(vault, { now: NOW });
    expect(result.changed).toBe(true);
    expect(result.counts.avoid).toBe(1);
    expect(result.counts.total).toBe(1);

    const body = require("node:fs").readFileSync(result.path, "utf8") as string;
    expect(body).toContain("kind: brain-lessons");
    expect(body).toContain("## Avoid (1)");
    expect(body).toContain("polling loop that never converges");
  });

  test("idempotent: a second regeneration with the same clock does not rewrite", () => {
    recordDeadEnd(vault, {
      approach: "x",
      reason: "y",
      agent: "tester",
      now: new Date("2026-05-18T00:00:00Z"),
    });
    const first = regenerateLessons(vault, { now: NOW });
    expect(first.changed).toBe(true);
    const second = regenerateLessons(vault, { now: NOW });
    expect(second.changed).toBe(false);
  });

  test("empty corpus renders a placeholder body", () => {
    const result = regenerateLessons(vault, { now: NOW });
    expect(result.counts.total).toBe(0);
    const body = require("node:fs").readFileSync(result.path, "utf8") as string;
    expect(body).toContain("No lessons yet");
  });
});
