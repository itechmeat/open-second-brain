/**
 * Hygiene apply: explicit plan execution with audit
 * (continuity-hygiene-freshness suite, Task 11; kanban t_698db8f7).
 *
 * Apply consumes a plan built from scan finding ids; review findings
 * are structurally excluded, dry-run previews with zero writes, merge
 * routes to the preference merge machinery, supersede appends the
 * resolver-chosen claim, archive moves pages under Brain/.snapshots
 * (never deletes).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { appendClaimEvent, readTruthState } from "../../../src/core/brain/truth/store.ts";
import { runHygieneScan } from "../../../src/core/brain/hygiene/scan.ts";
import { buildHygienePlan } from "../../../src/core/brain/hygiene/plan.ts";
import { applyHygienePlan } from "../../../src/core/brain/hygiene/apply.ts";
import { resolveConflictFindings } from "../../../src/core/brain/hygiene/resolve-conflicts.ts";
import type { HygieneFinding } from "../../../src/core/brain/hygiene/types.ts";

let vault: string;

const NOW = new Date("2026-06-10T12:00:00Z");

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-hygiene-apply-"));
  bootstrapBrain(vault);
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writePref(slug: string, topic: string, principle: string): void {
  writeFileSync(
    join(vault, "Brain", "preferences", `pref-${slug}.md`),
    [
      "---",
      "kind: brain-preference",
      `id: pref-${slug}`,
      "tags: [brain, brain/preference]",
      `topic: ${topic}`,
      "_status: confirmed",
      `principle: ${principle}`,
      "created_at: 2026-01-01T00:00:00Z",
      "unconfirmed_until: 2026-01-15T00:00:00Z",
      "---",
      "",
    ].join("\n"),
    "utf8",
  );
}

describe("buildHygienePlan", () => {
  test("review findings are structurally excluded", () => {
    writePref("solo", "lonely-topic", "a principle that nobody recalled");
    const report = runHygieneScan(vault, { detectors: ["usefulness"], now: NOW });
    const reviewId = report.findings[0]!.id;
    const plan = buildHygienePlan(report, { ids: [reviewId, "nope:000000000000"] });
    expect(plan.selected).toHaveLength(0);
    expect(plan.excluded_review).toEqual([reviewId]);
    expect(plan.unknown_ids).toEqual(["nope:000000000000"]);
  });
});

describe("applyHygienePlan", () => {
  test("dry-run previews routed actions with zero writes", async () => {
    writePref("dup-a", "same-topic", "collect metrics before optimizing the code");
    writePref("dup-b", "same-topic", "collect metrics before optimizing the code base");
    const report = runHygieneScan(vault, { detectors: ["dedup"], now: NOW });
    const plan = buildHygienePlan(report);
    expect(plan.selected.length).toBeGreaterThan(0);
    const result = await applyHygienePlan(vault, plan, { dryRun: true, agent: "tester", now: NOW });
    expect(result.dry_run).toBe(true);
    expect(result.planned[0]?.action).toBe("merge");
    expect(existsSync(join(vault, "Brain", "preferences", "pref-dup-b.md"))).toBe(true);
    expect(readdirSync(join(vault, "Brain", "retired"))).toHaveLength(0);
  });

  test("merge keeps the first target and retires the second", async () => {
    writePref("dup-a", "same-topic", "collect metrics before optimizing the code");
    writePref("dup-b", "same-topic", "collect metrics before optimizing the code base");
    const report = runHygieneScan(vault, { detectors: ["dedup"], now: NOW });
    const plan = buildHygienePlan(report);
    const result = await applyHygienePlan(vault, plan, { agent: "tester", now: NOW });
    expect(result.errors).toHaveLength(0);
    expect(result.applied[0]?.action).toBe("merge");
    expect(existsSync(join(vault, "Brain", "preferences", "pref-dup-a.md"))).toBe(true);
    expect(existsSync(join(vault, "Brain", "preferences", "pref-dup-b.md"))).toBe(false);
    expect(readdirSync(join(vault, "Brain", "retired")).some((n) => n.includes("dup-b"))).toBe(
      true,
    );
  });

  test("supersede appends the resolver-chosen claim as current truth", async () => {
    appendClaimEvent(vault, {
      ts: "2026-06-01T10:00:00Z",
      agent: "agent-a",
      entity: "acme",
      aspect: "hq",
      value: "Berlin",
      source: "[[note-a]]",
    });
    appendClaimEvent(vault, {
      ts: "2026-06-05T10:00:00Z",
      agent: "agent-b",
      entity: "acme",
      aspect: "hq",
      value: "Lisbon",
      source: "[[note-b]]",
    });
    const report = runHygieneScan(vault, { detectors: ["conflicts"], now: NOW });
    const withVerdicts = resolveConflictFindings(vault, report.findings, {
      resolverCmd: `printf '{"verdicts": {"${report.findings[0]!.id}": {"action": "supersede", "winner_value": "Lisbon", "rationale": "later independent source"}}}'`,
    });
    const plan = buildHygienePlan({ ...report, findings: withVerdicts });
    const result = await applyHygienePlan(vault, plan, { agent: "hygiene", now: NOW });
    expect(result.errors).toHaveLength(0);
    expect(result.applied[0]?.action).toBe("supersede");
    const state = readTruthState(vault);
    const slot = state?.slots.find((s) => s.entity === "acme" && s.aspect === "hq");
    expect(slot?.current.value).toBe("Lisbon");
    expect(slot?.current.source).toBe("[[hygiene-resolver]]");
  });

  test("archive moves the page under Brain/.snapshots and records the destination", async () => {
    const page = join(vault, "Brain", "old-page.md");
    writeFileSync(page, "---\ntitle: old\n---\nbody", "utf8");
    const finding: HygieneFinding = {
      id: "freshness:manualtest1",
      detector: "freshness",
      severity: "warning",
      title: "operator chose to archive",
      targets: [page],
      proposed_action: "archive",
      evidence: {},
    };
    const result = await applyHygienePlan(
      vault,
      { selected: [finding], excluded_review: [], unknown_ids: [] },
      { agent: "tester", now: NOW },
    );
    expect(result.applied[0]?.detail).toContain(".snapshots");
    expect(existsSync(page)).toBe(false);
  });
});
