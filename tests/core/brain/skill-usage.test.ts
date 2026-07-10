import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendContinuityRecord } from "../../../src/core/brain/continuity/store.ts";
import { deriveSkillUsage } from "../../../src/core/brain/skill-usage.ts";

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
