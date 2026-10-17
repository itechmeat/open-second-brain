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
import { DEFAULT_BRAIN_CONFIG_YAML } from "../../src/core/brain/config-template.ts";
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

/** Every logged doctor-repair event, in log order (consent assertions). */
function repairEvents(): Array<{ body: Record<string, string | ReadonlyArray<string>> }> {
  const events: Array<{ body: Record<string, string | ReadonlyArray<string>> }> = [];
  for (const date of listLogDates(tmp)) {
    for (const e of readLogDay(tmp, date).entries) {
      if (e.eventType === "doctor-repair")
        events.push(e as { body: Record<string, string | ReadonlyArray<string>> });
    }
  }
  return events;
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

  test("the apply skips a fix the approved preview did not name (M6)", () => {
    // The interactive ladder previews, the operator answers y, and the
    // apply re-plans. A finding that appeared in between (the mutation
    // between preview and apply) must not be written behind an approval
    // that never showed it: only the approved targets land.
    writeDanglingWorkrun("run-seen");
    const preview = applyRepair(tmp, { dryRun: true, now: new Date("2026-07-18T12:00:00Z") });
    expect(preview.applied.length).toBe(1);
    const seenPath = preview.applied[0]!.target;

    // The mutation: a second dangling workrun appears while the prompt
    // waits. A fresh plan names both; the approval names one.
    const unseenPath = writeDanglingWorkrun("run-unseen");

    const out = applyRepair(tmp, {
      dryRun: false,
      consent: "interactive-yes",
      approvedTargets: [seenPath],
      now: new Date("2026-07-18T12:00:05Z"),
    });
    // The approved fix landed; the unseen one did not.
    expect(out.applied.length).toBe(1);
    expect(out.applied[0]!.target).toBe(seenPath);
    expect(readFileSync(unseenPath, "utf8")).not.toContain("interrupted");
    expect(countRepairEvents()).toBe(1);

    // A later run without the pin picks the straggler up - skipping is
    // deferral, not deletion.
    const next = applyRepair(tmp, { dryRun: false, now: new Date("2026-07-18T12:00:10Z") });
    expect(next.applied.length).toBe(1);
    expect(readFileSync(unseenPath, "utf8")).toContain("interrupted");
  });
});

describe("applyRepair - consent receipt (t_b6bcd984)", () => {
  test("the doctor-repair event body carries the consent verdict", () => {
    writeDanglingWorkrun("run-consent");
    const out = applyRepair(tmp, {
      dryRun: false,
      consent: "yes-flag",
      now: new Date("2026-07-18T12:00:00Z"),
    });
    expect(out.applied.length).toBe(1);
    const events = repairEvents();
    expect(events.length).toBe(1);
    expect(events[0]!.body["consent"]).toBe("yes-flag");
  });

  test("the MCP provenance value records as caller-apply", () => {
    writeDanglingWorkrun("run-caller");
    applyRepair(tmp, {
      dryRun: false,
      consent: "caller-apply",
      now: new Date("2026-07-18T12:00:00Z"),
    });
    expect(repairEvents()[0]!.body["consent"]).toBe("caller-apply");
  });

  test("a dry run records nothing, with or without a verdict", () => {
    writeDanglingWorkrun("run-dry-consent");
    const out = applyRepair(tmp, {
      dryRun: true,
      consent: "yes-flag",
      now: new Date("2026-07-18T12:00:00Z"),
    });
    expect(out.dryRun).toBe(true);
    expect(countRepairEvents()).toBe(0);
  });

  test("the apply outcome carries the consent verdict (M4)", () => {
    writeDanglingWorkrun("run-outcome-consent");
    const out = applyRepair(tmp, {
      dryRun: false,
      consent: "yes-flag",
      now: new Date("2026-07-18T12:00:00Z"),
    });
    expect(out.applied.length).toBe(1);
    expect(out.consent).toBe("yes-flag");
  });

  test("a no-op apply downgrades the verdict to unchanged (M3/M4)", () => {
    writeDanglingWorkrun("run-noop-consent");
    // First apply closes the gap. The idempotent second apply has nothing
    // to do, so no consent was consumed: the outcome reports `unchanged`
    // rather than the caller's verdict.
    const first = applyRepair(tmp, {
      dryRun: false,
      consent: "interactive-yes",
      now: new Date("2026-07-18T12:00:00Z"),
    });
    expect(first.applied.length).toBe(1);
    const again = applyRepair(tmp, {
      dryRun: false,
      consent: "interactive-yes",
      now: new Date("2026-07-18T12:05:00Z"),
    });
    expect(again.applied).toEqual([]);
    expect(again.consent).toBe("unchanged");
  });
});

describe("applyRepair - dry-run diff preview (t_b6bcd984)", () => {
  test("the preview carries a unified diff of the fixable file", () => {
    const wrPath = writeDanglingWorkrun("run-diff");
    const before = readFileSync(wrPath, "utf8");
    const out = applyRepair(tmp, { dryRun: true, now: new Date("2026-07-18T12:00:00Z") });
    expect(out.applied.length).toBe(1);
    const diff = out.applied[0]!.diff!;
    expect(diff).toContain("---");
    expect(diff).toContain("+++");
    // The appended terminal marker is the change the preview shows; the
    // untouched lines are summarized as matching context, not repeated
    // (no removal line - the header's `---` is not a removal).
    expect(diff).toContain("+ ");
    expect(diff.split("\n").some((l) => l.startsWith("- "))).toBe(false);
    // A preview writes nothing.
    expect(readFileSync(wrPath, "utf8")).toBe(before);
  });

  test("the evidence-prune preview diffs the pruned frontmatter", () => {
    writePreference(tmp, {
      slug: "delta",
      topic: "delta",
      principle: "rule",
      created_at: "2026-05-14T10:00:00Z",
      unconfirmed_until: "2026-05-28T10:00:00Z",
      status: "unconfirmed",
      evidenced_by: ["[[sig-never-existed]]"],
    });
    const out = applyRepair(tmp, { dryRun: true, now: new Date("2026-07-18T12:00:00Z") });
    const fix = out.applied.find((f) => f.code === REPAIR_CODE.orphanedReference);
    expect(fix).toBeDefined();
    expect(fix!.diff).toBeDefined();
    expect(fix!.diff).toContain("---");
    // The dead evidence entry is what the diff removes.
    expect(fix!.diff).toMatch(/-\s+.*sig-never-existed/);
  });

  test("the evidence-prune preview shows the normalization the write performs (M5)", () => {
    // A non-canonical page: the topic scalar is quoted and the body sits
    // directly after the closing fence. The write re-renders the whole
    // file through formatFrontmatter, which de-quotes the scalar and
    // inserts the blank line - so the preview must diff the RAW bytes
    // against the formatted result, or the operator approves a one-line
    // change and the write lands a third. The page starts canonical (the
    // writer's shape, so the doctor detects it) and is then
    // de-canonicalized at the byte level.
    writePreference(tmp, {
      slug: "noncanon",
      topic: "noncanon",
      principle: "rule",
      created_at: "2026-05-14T10:00:00Z",
      unconfirmed_until: "2026-05-28T10:00:00Z",
      status: "unconfirmed",
      evidenced_by: ["[[sig-never-existed]]"],
    });
    const page = join(brainDirs(tmp).preferences, "pref-noncanon.md");
    const canonical = readFileSync(page, "utf8");
    const noncanonical = canonical
      .replace("topic: noncanon", 'topic: "noncanon"')
      .replace("---\n\n", "---\n");
    expect(noncanonical).not.toBe(canonical);
    writeFileSync(page, noncanonical, "utf8");
    const rawBefore = readFileSync(page, "utf8");
    const out = applyRepair(tmp, { dryRun: true, now: new Date("2026-07-18T12:00:00Z") });
    const fix = out.applied.find((f) => f.code === REPAIR_CODE.orphanedReference);
    expect(fix).toBeDefined();
    const diff = fix!.diff!;
    // The normalization the write performs is IN the diff: the quoted
    // scalar round-trips to a bare one (the before side quotes, the
    // after side does not - the old formatted-vs-formatted diff hid
    // this line entirely).
    expect(diff).toContain('- topic: "noncanon"');
    expect(diff).toContain("+ topic: noncanon");

    // Landing exactly the preview: the write normalized what the preview
    // showed, pruned what it removed - and a follow-up preview finds
    // nothing left to do, so the bytes on disk ARE the state the diff
    // described.
    applyRepair(tmp, {
      dryRun: false,
      consent: "yes-flag",
      now: new Date("2026-07-18T12:00:05Z"),
    });
    const landed = readFileSync(page, "utf8");
    expect(landed).toContain("topic: noncanon");
    expect(landed).not.toContain('topic: "noncanon"');
    expect(landed).not.toContain("sig-never-existed");
    expect(landed).toContain("---\n\n## Origin");
    const settled = applyRepair(tmp, { dryRun: true, now: new Date("2026-07-18T12:00:10Z") });
    expect(settled.applied).toEqual([]);
    expect(landed).not.toBe(rawBefore);
  });
});
