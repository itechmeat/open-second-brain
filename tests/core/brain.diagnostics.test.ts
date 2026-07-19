/**
 * Tests for src/core/brain/diagnostics.ts - the diagnostics-signal model
 * and the guarded `doctor --repair` driver (O2, t_bd6cc4cb).
 *
 * The model registry, the two fixers (WAL-gap dangling-workrun close and
 * orphaned evidenced_by prune), dry-run preview, apply + typed event, and
 * idempotency each get their own case. Fixtures use the canonical writers
 * so the inputs match what real Brain operations produce; the dangling
 * workrun is written by hand because no public writer leaves one behind.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyRepair,
  DIAGNOSTIC_SIGNALS,
  planRepair,
  REPAIR_CODE,
  resolveSignal,
} from "../../src/core/brain/diagnostics.ts";
import { brainConfigPath, brainDirs, dreamWorkrunPath } from "../../src/core/brain/paths.ts";
import { DEFAULT_BRAIN_CONFIG_YAML } from "../../src/core/brain/policy.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { readLogDay, listLogDates } from "../../src/core/brain/log-jsonl.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-diagnostics-"));
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
    JSON.stringify({ phase: "started", at: "2026-07-18T00:00:00.000Z", run_id: runId }) +
      "\n" +
      JSON.stringify({ phase: "cluster_complete", at: "2026-07-18T00:00:01.000Z", run_id: runId }) +
      "\n",
    "utf8",
  );
  return path;
}

function countRepairEvents(): number {
  let n = 0;
  for (const date of listLogDates(tmp)) {
    for (const e of readLogDay(tmp, date).entries) {
      if (e.eventType === "doctor-repair") n += 1;
    }
  }
  return n;
}

describe("diagnostics-signal model", () => {
  test("fixer codes are registered as auto-repairable with a next command", () => {
    for (const code of [REPAIR_CODE.walGap, REPAIR_CODE.orphanedReference]) {
      const sig = DIAGNOSTIC_SIGNALS.get(code);
      expect(sig).toBeDefined();
      expect(sig!.autoRepairable).toBe(true);
      expect(sig!.nextCommand.length).toBeGreaterThan(0);
      expect(sig!.nextCommand.startsWith("o2b ")).toBe(true);
    }
  });

  test("resolveSignal falls back to a generic doctor hint for unknown codes", () => {
    const sig = resolveSignal("some-brand-new-lint");
    expect(sig.code).toBe("some-brand-new-lint");
    expect(sig.autoRepairable).toBe(false);
    expect(sig.nextCommand).toBe("o2b brain doctor");
  });

  test("O3 source classes carry their own next-command hint (not hardcoded downstream)", () => {
    expect(resolveSignal("stale-notes").nextCommand).toBe("o2b brain stale");
    expect(resolveSignal("hygiene-findings").nextCommand).toBe("o2b brain hygiene scan");
    expect(resolveSignal("review-queue").nextCommand).toBe("o2b brain dream --dry-run");
  });
});

describe("planRepair", () => {
  test("a clean vault plans no fixes and lists no unfixable classes", () => {
    const plan = planRepair(tmp);
    expect(plan.fixes).toEqual([]);
    expect(plan.unfixable).toEqual([]);
  });

  test("detects a dangling workrun as an applicable wal-gap fix", () => {
    writeDanglingWorkrun("run-abc");
    const plan = planRepair(tmp);
    const wal = plan.fixes.filter((f) => f.code === REPAIR_CODE.walGap);
    expect(wal).toHaveLength(1);
    expect(wal[0]!.applicable).toBe(true);
    expect(wal[0]!.target).toContain("run-abc");
  });

  test("detects a dead evidenced_by as an applicable orphaned-reference fix", () => {
    writePreference(tmp, {
      slug: "alpha",
      topic: "alpha",
      principle: "rule",
      created_at: "2026-05-14T10:00:00Z",
      unconfirmed_until: "2026-05-28T10:00:00Z",
      status: "unconfirmed",
      evidenced_by: ["[[sig-never-existed]]"],
    });
    const plan = planRepair(tmp);
    const orphan = plan.fixes.filter((f) => f.code === REPAIR_CODE.orphanedReference);
    expect(orphan).toHaveLength(1);
    expect(orphan[0]!.applicable).toBe(true);
    expect(orphan[0]!.target).toContain("sig-never-existed");
  });

  test("does not prune an evidenced_by link that points outside the Brain id space", () => {
    writePreference(tmp, {
      slug: "beta",
      topic: "beta",
      principle: "rule",
      created_at: "2026-05-14T10:00:00Z",
      unconfirmed_until: "2026-05-28T10:00:00Z",
      status: "unconfirmed",
      evidenced_by: ["[[src/some/code.ts]]"],
    });
    const plan = planRepair(tmp);
    expect(plan.fixes.filter((f) => f.code === REPAIR_CODE.orphanedReference)).toEqual([]);
  });

  test("aggregates detected classes with no fixer as unfixable, each with a hint", () => {
    // A duplicate id is a doctor error with no fixer.
    const dupA = join(brainDirs(tmp).preferences, "pref-dup-a.md");
    const dupB = join(brainDirs(tmp).preferences, "pref-dup-b.md");
    const fm =
      "---\nkind: brain-preference\nid: pref-collide\ncreated_at: 2026-05-14T10:00:00Z\n" +
      "unconfirmed_until: 2026-05-28T10:00:00Z\ntags: []\ntopic: t\nprinciple: p\n" +
      "provenance: observed\n_status: unconfirmed\n---\nbody\n";
    writeFileSync(dupA, fm, "utf8");
    writeFileSync(dupB, fm, "utf8");
    const plan = planRepair(tmp);
    const dup = plan.unfixable.find((u) => u.code === "duplicate-id");
    expect(dup).toBeDefined();
    expect(dup!.nextCommand.startsWith("o2b ")).toBe(true);
  });
});

describe("applyRepair - dry run", () => {
  test("previews fixes and writes nothing (no event, files untouched)", () => {
    const wrPath = writeDanglingWorkrun("run-dry");
    const before = readFileSync(wrPath, "utf8");
    const out = applyRepair(tmp, { dryRun: true, now: new Date("2026-07-18T12:00:00Z") });
    expect(out.dryRun).toBe(true);
    expect(out.applied.length).toBe(1);
    expect(readFileSync(wrPath, "utf8")).toBe(before); // byte-identical
    expect(countRepairEvents()).toBe(0);
  });
});

describe("applyRepair - apply", () => {
  test("closes a dangling workrun and logs one typed event", () => {
    const wrPath = writeDanglingWorkrun("run-apply");
    const out = applyRepair(tmp, { dryRun: false, now: new Date("2026-07-18T12:00:00Z") });
    expect(out.dryRun).toBe(false);
    expect(out.applied.some((f) => f.code === REPAIR_CODE.walGap)).toBe(true);
    // Terminal marker now present -> no longer dangling.
    expect(readFileSync(wrPath, "utf8")).toContain("interrupted");
    expect(countRepairEvents()).toBe(1);
    // Idempotent: a second apply finds nothing and logs nothing new.
    const again = applyRepair(tmp, { dryRun: false, now: new Date("2026-07-18T12:05:00Z") });
    expect(again.applied).toEqual([]);
    expect(countRepairEvents()).toBe(1);
  });

  test("prunes a dead evidenced_by and logs one typed event per fix", () => {
    writePreference(tmp, {
      slug: "gamma",
      topic: "gamma",
      principle: "rule",
      created_at: "2026-05-14T10:00:00Z",
      unconfirmed_until: "2026-05-28T10:00:00Z",
      status: "unconfirmed",
      evidenced_by: ["[[sig-never-existed]]"],
    });
    const out = applyRepair(tmp, { dryRun: false, now: new Date("2026-07-18T12:00:00Z") });
    expect(out.applied.some((f) => f.code === REPAIR_CODE.orphanedReference)).toBe(true);
    expect(countRepairEvents()).toBe(1);
    // The dead reference is gone from both the frontmatter and the body
    // Origin prose; re-running is a no-op.
    const prefFile = join(brainDirs(tmp).preferences, "pref-gamma.md");
    expect(readFileSync(prefFile, "utf8")).not.toContain("sig-never-existed");
    const again = applyRepair(tmp, { dryRun: false, now: new Date("2026-07-18T12:05:00Z") });
    expect(again.applied).toEqual([]);
    expect(countRepairEvents()).toBe(1);
  });

  test("a broken structural retired_by link is reported needs-review, never applied", () => {
    // A retired record whose retired_by points at a missing preference.
    const retDir = brainDirs(tmp).retired;
    const path = join(retDir, "ret-old.md");
    const fm =
      "---\nkind: brain-retired\nid: ret-old\ncreated_at: 2026-05-14T10:00:00Z\n" +
      "tags: []\ntopic: t\nprinciple: p\nprovenance: observed\n" +
      "retired_at: 2026-06-01T10:00:00Z\nretired_by: '[[pref-vanished]]'\n" +
      "retired_reason: superseded-by-context\n_status: retired\n_evidenced_by: []\n---\nbody\n";
    writeFileSync(path, fm, "utf8");
    const out = applyRepair(tmp, { dryRun: false });
    expect(out.needsReview.some((f) => f.target.includes("retired_by"))).toBe(true);
    expect(out.applied).toEqual([]);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("pref-vanished"); // untouched
  });
});
