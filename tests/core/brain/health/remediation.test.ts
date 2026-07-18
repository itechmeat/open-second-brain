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
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeContentHash } from "../../../../src/core/brain/content-hash.ts";
import { brainDirs } from "../../../../src/core/brain/paths.ts";
import { parsePreference, writePreference } from "../../../../src/core/brain/preference.ts";
import {
  applyRemediation,
  collectWidePermissions,
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
    expect(auto.map((s) => s.code)).toEqual(["content-hash-drift", "content-hash-drift"]);
    expect(review.map((s) => s.code).toSorted()).toEqual([
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
      {
        driftedSlugs: ["a-drift", "b-drift"],
        contradictions: [],
        staleClaims: [],
        conceptGaps: [],
      },
      { stepCap: 1 },
    );
    const outcome = applyRemediation(vault, plan, { dryRun: false });
    expect(outcome.applied.length).toBe(1);
    expect(outcome.applied[0]!.target).toBe("a-drift");
    expect(outcome.skipped.map((s) => s.target)).toContain("b-drift");
  });
});

describe("harden-permissions (D2)", () => {
  // POSIX modes are meaningless on Windows; the migration is skipped
  // there, so its assertions only run on POSIX hosts.
  const posix = process.platform !== "win32";

  test("collects Brain/ files wider than 0o600 and dirs wider than 0o700", () => {
    if (!posix) return;
    const dirs = brainDirs(vault);
    const wideFile = join(dirs.preferences, "wide.md");
    writeFileSync(wideFile, "x", "utf8");
    chmodSync(wideFile, 0o644);
    const tightFile = join(dirs.preferences, "tight.md");
    writeFileSync(tightFile, "y", "utf8");
    chmodSync(tightFile, 0o600);
    chmodSync(dirs.preferences, 0o755);

    const findings = collectWidePermissions(vault, { platform: "linux" });
    const paths = findings.map((f) => f.path);
    expect(paths).toContain("Brain/preferences/wide.md");
    expect(paths).toContain("Brain/preferences");
    // An already-tight file produces no finding (idempotence precondition).
    expect(paths).not.toContain("Brain/preferences/tight.md");
    const wide = findings.find((f) => f.path === "Brain/preferences/wide.md")!;
    expect(wide.isDir).toBe(false);
    const dirFinding = findings.find((f) => f.path === "Brain/preferences")!;
    expect(dirFinding.isDir).toBe(true);
  });

  test("plans wide permissions as auto-safe steps and apply chmods them", () => {
    if (!posix) return;
    const dirs = brainDirs(vault);
    const wideFile = join(dirs.preferences, "wide.md");
    writeFileSync(wideFile, "x", "utf8");
    chmodSync(wideFile, 0o646);

    const plan = planRemediation(
      {
        ...allFindings,
        driftedSlugs: [],
        widePermissions: collectWidePermissions(vault, { platform: "linux" }),
      },
      { stepCap: 10 },
    );
    const permStep = plan.steps.find((s) => s.action === "harden-permissions");
    expect(permStep).toBeDefined();
    expect(permStep!.classification).toBe("auto-safe");

    const outcome = applyRemediation(vault, plan, { dryRun: false });
    expect(outcome.applied.some((s) => s.action === "harden-permissions")).toBe(true);
    expect(statSync(wideFile).mode & 0o777).toBe(0o600);
  });

  test("dry-run lists the chmod without touching the file", () => {
    if (!posix) return;
    const dirs = brainDirs(vault);
    const wideFile = join(dirs.preferences, "wide.md");
    writeFileSync(wideFile, "x", "utf8");
    chmodSync(wideFile, 0o644);

    const plan = planRemediation(
      {
        driftedSlugs: [],
        contradictions: [],
        staleClaims: [],
        conceptGaps: [],
        widePermissions: collectWidePermissions(vault, { platform: "linux" }),
      },
      { stepCap: 10 },
    );
    const outcome = applyRemediation(vault, plan, { dryRun: true });
    expect(outcome.applied.some((s) => s.action === "harden-permissions")).toBe(true);
    // File is untouched under dry-run.
    expect(statSync(wideFile).mode & 0o777).toBe(0o644);
  });

  test("re-running after a chmod is idempotent (no new findings)", () => {
    if (!posix) return;
    const dirs = brainDirs(vault);
    const wideFile = join(dirs.preferences, "wide.md");
    writeFileSync(wideFile, "x", "utf8");
    chmodSync(wideFile, 0o644);

    const plan = planRemediation(
      {
        driftedSlugs: [],
        contradictions: [],
        staleClaims: [],
        conceptGaps: [],
        widePermissions: collectWidePermissions(vault, { platform: "linux" }),
      },
      { stepCap: 10 },
    );
    applyRemediation(vault, plan, { dryRun: false });
    // The second collection sees a hardened tree.
    const second = collectWidePermissions(vault, { platform: "linux" });
    expect(second.some((f) => f.path === "Brain/preferences/wide.md")).toBe(false);
  });

  test("windows is skipped cleanly with an explicit logged reason", () => {
    const logged: string[] = [];
    const findings = collectWidePermissions(vault, {
      platform: "win32",
      log: (m) => logged.push(m),
    });
    expect(findings).toEqual([]);
    expect(logged.length).toBe(1);
    expect(logged[0]).toMatch(/win32/i);
  });
});
