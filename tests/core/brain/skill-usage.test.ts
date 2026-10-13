import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendContinuityRecord } from "../../../src/core/brain/continuity/store.ts";
import {
  deriveSkillUsage,
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
