import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendContinuityRecord,
  appendContinuityRecords,
} from "../../../src/core/brain/continuity/store.ts";
import {
  deriveSkillUsage,
  skillUsageRankingWeights,
  skillUsageWeights,
  type SkillUsage,
} from "../../../src/core/brain/skill-usage.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-skill-usage-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function invoke(skill: string, seq: number, at: string): void {
  appendContinuityRecord(vault, {
    kind: "skill_invoked",
    createdAt: at,
    sourceRefs: [{ id: `sess:${skill}:${seq}` }],
    payload: { skill, agent: "claude", tool: "get_skill" },
  });
}

test("a vault with no invocations derives an empty usage list", () => {
  expect(deriveSkillUsage(vault)).toEqual([]);
});

test("groups skill_invoked records into per-skill counts, ranked by count", () => {
  invoke("release", 1, "2026-06-01T10:00:00Z");
  invoke("release", 2, "2026-06-02T10:00:00Z");
  invoke("release", 3, "2026-06-03T10:00:00Z");
  invoke("triage", 1, "2026-06-01T11:00:00Z");

  const usage = deriveSkillUsage(vault, { nowMs: Date.parse("2026-06-04T00:00:00Z") });
  expect(usage.map((u) => [u.skill, u.invocationCount])).toEqual([
    ["release", 3],
    ["triage", 1],
  ]);
  const release = usage[0]!;
  expect(release.lastInvokedAtMs).toBe(Date.parse("2026-06-03T10:00:00Z"));
  expect(release.weight).toBeGreaterThan(0);
  expect(release.weight).toBeLessThanOrEqual(1);
});

test("distinct invocations in the same second are counted separately", () => {
  // Same skill, same timestamp, different source ref => distinct records.
  invoke("release", 1, "2026-06-01T10:00:00Z");
  invoke("release", 2, "2026-06-01T10:00:00Z");
  const usage = deriveSkillUsage(vault);
  expect(usage).toHaveLength(1);
  expect(usage[0]!.invocationCount).toBe(2);
});

// --- skillUsageWeights (t_5d1ec8a8): the offer-join side of the usage map ---

function usageRow(skill: string, weight: number): SkillUsage {
  return {
    skill,
    invocationCount: 1,
    offerAttributedCount: 0,
    lastInvokedAtMs: null,
    weight,
  };
}

test("usage keys that are known names join exactly", () => {
  const map = skillUsageWeights(
    [usageRow("codegraph-partner", 0.75)],
    new Set(["codegraph-partner", "schema-author"]),
  );
  expect(map.get("codegraph-partner")).toBe(0.75);
  expect(map.has("schema-author")).toBe(false);
});

test("a plugin-qualified usage key joins through its suffix after the colon", () => {
  const map = skillUsageWeights(
    [usageRow("open-second-brain:codegraph-partner", 0.5)],
    new Set(["codegraph-partner"]),
  );
  expect(map.get("codegraph-partner")).toBe(0.5);
});

test("the longest matching suffix wins when several colons exist", () => {
  const map = skillUsageWeights(
    [usageRow("plugin:b:codegraph-partner", 0.25)],
    new Set(["b:codegraph-partner", "codegraph-partner"]),
  );
  expect(map.get("b:codegraph-partner")).toBe(0.25);
  expect(map.has("codegraph-partner")).toBe(false);
});

test("usage keys matching nothing are dropped", () => {
  const map = skillUsageWeights(
    [usageRow("retired-skill", 1), usageRow("never-installed:ghost", 1)],
    new Set(["codegraph-partner"]),
  );
  expect(map.size).toBe(0);
});

test("map values are the decay weights unchanged", () => {
  const weights = [1, 0.02, 0.5];
  const rows = weights.map((w, i) => usageRow(`skill-${i}`, w));
  const map = skillUsageWeights(rows, new Set(rows.map((r) => r.skill)));
  expect([...map.values()].toSorted((a, b) => a - b)).toEqual(weights.toSorted((a, b) => a - b));
});

test("an exact name beats a hotter suffix join when both spellings exist", () => {
  const map = skillUsageWeights(
    [usageRow("open-second-brain:codegraph-partner", 0.9), usageRow("codegraph-partner", 0.1)],
    new Set(["codegraph-partner"]),
  );
  expect(map.get("codegraph-partner")).toBe(0.1);
});

test("an empty usage list yields an empty map", () => {
  expect(skillUsageWeights([], new Set(["codegraph-partner"])).size).toBe(0);
});

test("the join is deterministic across repeated calls", () => {
  const rows = [
    usageRow("open-second-brain:codegraph-partner", 0.5),
    usageRow("schema-author", 0.25),
    usageRow("ghost", 1),
  ];
  const names = new Set(["codegraph-partner", "schema-author"]);
  const a = skillUsageWeights(rows, names);
  const b = skillUsageWeights(rows, names);
  expect([...a.entries()]).toEqual([...b.entries()]);
});

// --- skillUsageRankingWeights (M5): a ranking weight that does not saturate ---
//
// The decay weight `SkillUsage.weight` carries is capped at 1, so among
// RECENTLY used skills frequency is invisible: a skill invoked 300 times
// this week and one invoked once yesterday both clamp to 1 and the name
// tie-break decides. The ranking builder normalises the count against the
// largest joined count so frequency separates them again.

const RANKING_NOW = Date.parse("2026-06-04T00:00:00Z");

/** `count` invocations of one skill, hourly, ending at `latestAt`. */
function invokeMany(skill: string, count: number, latestAt: string): void {
  const latest = Date.parse(latestAt);
  appendContinuityRecords(
    vault,
    Array.from({ length: count }, (_, i) => ({
      kind: "skill_invoked" as const,
      createdAt: new Date(latest - i * 3_600_000).toISOString(),
      sourceRefs: [{ id: `sess:${skill}:${i}` }],
      payload: { skill, agent: "claude", tool: "get_skill" },
    })),
  );
}

function rankingRow(skill: string, count: number, lastInvokedAtMs: number | null): SkillUsage {
  return {
    skill,
    invocationCount: count,
    offerAttributedCount: 0,
    lastInvokedAtMs,
    weight: 1,
  };
}

test("the plain decay weights tie a 300-fold and a once-invoked skill, both recent (the saturation defect)", () => {
  invokeMany("release-heavy", 300, "2026-06-03T23:00:00Z");
  invokeMany("release-once", 1, "2026-06-03T20:00:00Z");
  const usage = deriveSkillUsage(vault, { nowMs: RANKING_NOW });
  const weights = skillUsageWeights(usage, new Set(["release-heavy", "release-once"]));
  // Both clamp to the cap: this tie is exactly what the ranking builder exists
  // to break, pinned so a future change to the decay contract shows up here.
  expect(weights.get("release-heavy")).toBe(1);
  expect(weights.get("release-once")).toBe(1);
});

test("the ranking weight ranks the frequently invoked skill first, both recent", () => {
  invokeMany("release-heavy", 300, "2026-06-03T23:00:00Z");
  invokeMany("release-once", 1, "2026-06-03T20:00:00Z");
  const usage = deriveSkillUsage(vault, { nowMs: RANKING_NOW });
  const map = skillUsageRankingWeights(usage, new Set(["release-heavy", "release-once"]), {
    nowMs: RANKING_NOW,
  });
  expect(map.get("release-heavy")).toBeGreaterThan(map.get("release-once")!);
  // Bounds: weights stay in (0, 1].
  expect(map.get("release-once")).toBeGreaterThan(0);
  expect(map.get("release-heavy")).toBeLessThanOrEqual(1);
});

test("maxCount is taken over the joined rows, so an unjoined heavy row does not shrink the rest", () => {
  const rows = [
    rankingRow("vendor:ghost-heavy", 1000, RANKING_NOW - 60_000), // joins nothing
    rankingRow("recent-a", 1, null),
    rankingRow("recent-b", 1, null),
  ];
  const map = skillUsageRankingWeights(rows, new Set(["recent-a", "recent-b"]), {
    nowMs: RANKING_NOW,
  });
  // Every joined count is 1, so the ratio is 1 everywhere: undated rows carry
  // full recency (the same convention the decay curve applies) and are not
  // scaled down by the 1000-fold row that matched no known name.
  expect(map.get("recent-a")).toBe(1);
  expect(map.get("recent-b")).toBe(1);
});

test("a plugin-qualified frequent invocation outranks a once-used exact join", () => {
  const rows = [
    rankingRow("vendor:release-heavy", 300, RANKING_NOW - 60_000),
    rankingRow("release-once", 1, RANKING_NOW - 60_000),
  ];
  const map = skillUsageRankingWeights(rows, new Set(["release-heavy", "release-once"]), {
    nowMs: RANKING_NOW,
  });
  expect(map.get("release-heavy")).toBeGreaterThan(map.get("release-once")!);
});

test("an ancient invocation floors at the same minimum as the decay curve", () => {
  const rows = [rankingRow("legacy", 1, Date.parse("1990-01-01T00:00:00Z"))];
  const map = skillUsageRankingWeights(rows, new Set(["legacy"]), { nowMs: RANKING_NOW });
  expect(map.get("legacy")).toBe(0.02);
});

test("an empty usage list yields an empty ranking map", () => {
  expect(skillUsageRankingWeights([], new Set(["codegraph-partner"])).size).toBe(0);
  expect(
    skillUsageRankingWeights([usageRow("ghost", 1)], new Set(["codegraph-partner"])).size,
  ).toBe(0);
});

test("the ranking join is deterministic across repeated calls", () => {
  const rows = [
    rankingRow("vendor:release-heavy", 300, RANKING_NOW - 60_000),
    rankingRow("release-once", 1, RANKING_NOW - 3_600_000),
  ];
  const names = new Set(["release-heavy", "release-once"]);
  const a = skillUsageRankingWeights(rows, names, { nowMs: RANKING_NOW });
  const b = skillUsageRankingWeights(rows, names, { nowMs: RANKING_NOW });
  expect([...a.entries()]).toEqual([...b.entries()]);
});
