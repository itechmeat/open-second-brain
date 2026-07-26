/**
 * The repair planner consumes the doctor's findings (no-dead-ends, task 9).
 *
 * `planRepair` used to call `runDoctor` and then ignore what it returned
 * except as counts, while each fixer re-scanned the vault for its own
 * class independently. The applier shared vocabulary with the detector
 * but was not a consumer of it, so nothing forced the two to agree about
 * what had been detected.
 *
 * The proof that a plan is DERIVED FROM findings rather than from a fresh
 * scan is that the two can be made to disagree: hand the planner findings
 * that do not match the disk and watch the plan follow the findings.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MalformedDoctorFindingError,
  REPAIR_CODE,
  planRepair,
} from "../../../src/core/brain/diagnostics.ts";
import { runDoctor } from "../../../src/core/brain/doctor.ts";
import { DEFAULT_BRAIN_CONFIG_YAML } from "../../../src/core/brain/config-template.ts";
import { brainConfigPath, brainDirs, dreamWorkrunPath } from "../../../src/core/brain/paths.ts";
import { writePreference } from "../../../src/core/brain/preference.ts";
import type { DoctorIssue } from "../../../src/core/brain/types.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-repair-source-"));
  const dirs = brainDirs(tmp);
  for (const d of [
    dirs.brain,
    dirs.inbox,
    dirs.processed,
    dirs.preferences,
    dirs.retired,
    dirs.log,
    dirs.snapshots,
  ]) {
    mkdirSync(d, { recursive: true });
  }
  atomicWriteFileSync(brainConfigPath(tmp), DEFAULT_BRAIN_CONFIG_YAML);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Write a dangling workrun (last phase is neither finalized nor interrupted). */
function writeDanglingWorkrun(runId: string): string {
  const path = dreamWorkrunPath(tmp, runId);
  mkdirSync(join(tmp, "Brain", "log", "dream-runs"), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({ phase: "started", at: "2026-07-18T00:00:00.000Z", run_id: runId })}\n`,
    "utf8",
  );
  return path;
}

function seedDeadEvidence(slug: string, target: string): void {
  writePreference(tmp, {
    slug,
    topic: slug,
    principle: `rule ${slug}`,
    created_at: "2026-05-14T10:00:00Z",
    unconfirmed_until: "2026-05-28T10:00:00Z",
    status: "unconfirmed",
    evidenced_by: [`[[${target}]]`],
  });
}

function doctorIssues(): ReadonlyArray<DoctorIssue> {
  const report = runDoctor(tmp);
  return [...report.errors, ...report.warnings];
}

describe("planRepair derives its plan from the findings it is given", () => {
  test("the supplied findings produce the same plan the doctor run does", () => {
    writeDanglingWorkrun("run-same");
    seedDeadEvidence("alpha", "sig-never-existed");

    expect(planRepair(tmp, { issues: doctorIssues() })).toEqual(planRepair(tmp));
  });

  test("a finding withheld from the planner is absent from the plan, defect and all", () => {
    const workrun = writeDanglingWorkrun("run-withheld");
    seedDeadEvidence("alpha", "sig-never-existed");

    const withoutWalGap = doctorIssues().filter((issue) => issue.code !== "dangling-workrun");
    const plan = planRepair(tmp, { issues: withoutWalGap });

    // The dangling workrun is still on disk. A planner that re-scanned
    // would find it; one that consumes findings cannot.
    expect(workrun).toBe(dreamWorkrunPath(tmp, "run-withheld"));
    expect(plan.fixes.filter((f) => f.code === REPAIR_CODE.walGap)).toEqual([]);
    expect(plan.fixes.filter((f) => f.code === REPAIR_CODE.orphanedReference)).toHaveLength(1);
  });

  test("a finding whose defect is already gone still shapes the plan", () => {
    writeDanglingWorkrun("run-vanished");
    const captured = doctorIssues();
    unlinkSync(dreamWorkrunPath(tmp, "run-vanished"));

    // A fresh scan now finds nothing; the captured finding still names it.
    expect(planRepair(tmp).fixes).toEqual([]);
    const fromCaptured = planRepair(tmp, { issues: captured }).fixes;
    expect(fromCaptured).toHaveLength(1);
    expect(fromCaptured[0]!.code).toBe(REPAIR_CODE.walGap);
    expect(fromCaptured[0]!.target).toContain("run-vanished");
  });

  test("the unfixable aggregation reads the same supplied findings", () => {
    const issues: ReadonlyArray<DoctorIssue> = [
      { severity: "error", code: "duplicate-id", path: join(tmp, "a.md"), message: "seeded" },
      { severity: "error", code: "duplicate-id", path: join(tmp, "b.md"), message: "seeded" },
    ];
    const plan = planRepair(tmp, { issues });
    expect(plan.fixes).toEqual([]);
    expect(plan.unfixable).toHaveLength(1);
    expect(plan.unfixable[0]!.code).toBe("duplicate-id");
    expect(plan.unfixable[0]!.count).toBe(2);
  });
});

describe("a finding that cannot carry a fixer's input is named, not skipped", () => {
  test("a dangling-workrun finding with no path raises", () => {
    const issues: ReadonlyArray<DoctorIssue> = [
      { severity: "warning", code: "dangling-workrun", message: "no path on this one" },
    ];
    expect(() => planRepair(tmp, { issues })).toThrow(MalformedDoctorFindingError);
  });

  test("a broken-wikilink finding with no target raises", () => {
    const issues: ReadonlyArray<DoctorIssue> = [
      {
        severity: "warning",
        code: "broken-wikilink",
        path: join(tmp, "Brain", "preferences", "pref-alpha.md"),
        field: "evidenced_by",
        message: "no target on this one",
      },
    ];
    expect(() => planRepair(tmp, { issues })).toThrow(MalformedDoctorFindingError);
  });
});

describe("plans for the existing fixable classes are unchanged", () => {
  test("a structural link is still needs-review and an evidence link still prunable", () => {
    writePreference(tmp, {
      slug: "gamma",
      topic: "gamma",
      principle: "rule gamma",
      created_at: "2026-05-14T10:00:00Z",
      unconfirmed_until: "2026-05-28T10:00:00Z",
      status: "unconfirmed",
      evidenced_by: ["[[sig-gone]]"],
      supersedes: "[[pref-gone]]",
    });

    const fixes = planRepair(tmp).fixes.filter((f) => f.code === REPAIR_CODE.orphanedReference);
    const evidence = fixes.find((f) => f.target.includes("sig-gone"))!;
    const structural = fixes.find((f) => f.target.includes("pref-gone"))!;

    expect(evidence.applicable).toBe(true);
    expect(evidence.target).toBe("Brain/preferences/pref-gamma.md::_evidenced_by::sig-gone");
    expect(evidence.detail).toBe(
      "prune orphaned evidence [[sig-gone]] from Brain/preferences/pref-gamma.md",
    );

    expect(structural.applicable).toBe(false);
    expect(structural.target).toBe("Brain/preferences/pref-gamma.md::supersedes::pref-gone");
    expect(structural.reason).toContain("provenance");
  });

  test("a link outside the Brain id space is still left alone", () => {
    writePreference(tmp, {
      slug: "delta",
      topic: "delta",
      principle: "rule delta",
      created_at: "2026-05-14T10:00:00Z",
      unconfirmed_until: "2026-05-28T10:00:00Z",
      status: "unconfirmed",
      evidenced_by: ["[[src/some/code.ts]]"],
    });
    expect(planRepair(tmp).fixes.filter((f) => f.code === REPAIR_CODE.orphanedReference)).toEqual(
      [],
    );
  });
});
