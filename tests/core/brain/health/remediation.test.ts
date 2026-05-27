/**
 * Dependency-ordered remediation planner + executor (F5).
 *
 * planRemediation turns findings into a deterministically-ordered plan
 * that classifies each step auto-safe (deterministic, reversible, no
 * judgment) or needs-review. applyRemediation mutates nothing under
 * dry-run, applies only auto-safe steps otherwise, and stops at a step
 * cap. The single auto-safe action is a lossless content-hash re-stamp.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeContentHash } from "../../../../src/core/brain/content-hash.ts";
import { brainDirs } from "../../../../src/core/brain/paths.ts";
import { parsePreference, writePreference } from "../../../../src/core/brain/preference.ts";
import {
  applyRemediation,
  planRemediation,
} from "../../../../src/core/brain/health/remediation.ts";
import { BRAIN_PREFERENCE_STATUS } from "../../../../src/core/brain/types.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-remediation-"));
  mkdirSync(brainDirs(vault).preferences, { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writeDriftedPref(slug: string): void {
  writePreference(
    vault,
    {
      slug,
      topic: slug,
      principle: "always write tests first in production code",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-08T00:00:00Z",
      confirmed_at: "2026-05-08T00:00:00Z",
      status: BRAIN_PREFERENCE_STATUS.confirmed,
      evidenced_by: [],
      content_hash: "0000000000000000000000000000000000000000000000000000000000000000",
    },
    { overwrite: true },
  );
}

const allFindings = {
  driftedSlugs: ["b-drift", "a-drift"],
  contradictions: [{ aId: "pref-x", bId: "pref-y" }],
  staleClaims: [{ id: "pref-stale" }],
  conceptGaps: [{ term: "kanban" }],
};

describe("planRemediation", () => {
  test("classifies drift auto-safe and everything else needs-review", () => {
    const plan = planRemediation(allFindings, { stepCap: 10 });
    const auto = plan.steps.filter((s) => s.classification === "auto-safe");
    const review = plan.steps.filter((s) => s.classification === "needs-review");
    expect(auto.map((s) => s.code)).toEqual([
      "content-hash-drift",
      "content-hash-drift",
    ]);
    expect(review.map((s) => s.code).sort()).toEqual([
      "concept-gap",
      "contradictory-preferences",
      "stale-claim",
    ]);
  });

  test("orders auto-safe structural fixes before semantic review steps", () => {
    const plan = planRemediation(allFindings, { stepCap: 10 });
    const firstReview = plan.steps.findIndex((s) => s.classification === "needs-review");
    const lastAuto = plan.steps.map((s) => s.classification).lastIndexOf("auto-safe");
    expect(lastAuto).toBeLessThan(firstReview);
  });

  test("orders deterministically by target within a code", () => {
    const plan = planRemediation(allFindings, { stepCap: 10 });
    const driftTargets = plan.steps
      .filter((s) => s.code === "content-hash-drift")
      .map((s) => s.target);
    expect(driftTargets).toEqual(["a-drift", "b-drift"]);
  });
});

describe("applyRemediation", () => {
  test("dry-run applies nothing and leaves the file untouched", () => {
    writeDriftedPref("a-drift");
    const plan = planRemediation({ ...allFindings, driftedSlugs: ["a-drift"] }, { stepCap: 10 });
    const outcome = applyRemediation(vault, plan, { dryRun: true });
    expect(outcome.dryRun).toBe(true);
    expect(outcome.applied.map((s) => s.target)).toEqual(["a-drift"]);
    // still drifted - no write happened
    const pref = parsePreference(brainDirs(vault).preferences + "/pref-a-drift.md");
    expect(pref.content_hash).not.toBe(computeContentHash(pref.principle, pref.scope));
  });

  test("re-stamps a drifted content hash and skips needs-review steps", () => {
    writeDriftedPref("a-drift");
    const plan = planRemediation({ ...allFindings, driftedSlugs: ["a-drift"] }, { stepCap: 10 });
    const outcome = applyRemediation(vault, plan, { dryRun: false });
    expect(outcome.applied.map((s) => s.code)).toEqual(["content-hash-drift"]);
    expect(outcome.skipped.every((s) => s.classification === "needs-review")).toBe(true);
    const pref = parsePreference(brainDirs(vault).preferences + "/pref-a-drift.md");
    expect(pref.content_hash).toBe(computeContentHash(pref.principle, pref.scope));
    expect(pref.principle).toBe("always write tests first in production code");
  });

  test("the step cap bounds how many auto-safe steps are applied", () => {
    writeDriftedPref("a-drift");
    writeDriftedPref("b-drift");
    const plan = planRemediation(
      { driftedSlugs: ["a-drift", "b-drift"], contradictions: [], staleClaims: [], conceptGaps: [] },
      { stepCap: 1 },
    );
    const outcome = applyRemediation(vault, plan, { dryRun: false });
    expect(outcome.applied.length).toBe(1);
    expect(outcome.applied[0]!.target).toBe("a-drift");
    expect(outcome.skipped.map((s) => s.target)).toContain("b-drift");
  });
});
