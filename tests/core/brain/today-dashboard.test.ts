/**
 * Tests for `buildTodayDashboard` - the today operator surface (Task 4).
 *
 * Fixtures compose the three already-tested primitives over a shared
 * tmp vault: obligation pages via `addObligation` (per
 * `tests/core/brain/obligations.test.ts`), `@osb loop` markers under a
 * configured `notes.read_paths` root (per
 * `tests/core/brain/open-loops.test.ts`), and `Brain/log/<date>.jsonl`
 * day files (per `tests/core/brain/temporal/activity-timeline.test.ts`).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addObligation } from "../../../src/core/brain/obligations.ts";
import { brainDirs } from "../../../src/core/brain/paths.ts";
import { DEFAULT_BRAIN_CONFIG_YAML } from "../../../src/core/brain/policy.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { buildTodayDashboard } from "../../../src/core/brain/today-dashboard.ts";

const NOW = new Date("2026-07-17T12:00:00Z");

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-today-dashboard-"));
  mkdirSync(brainDirs(vault).brain, { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writeConfig(extra: string): void {
  atomicWriteFileSync(
    join(brainDirs(vault).brain, "_brain.yaml"),
    `${DEFAULT_BRAIN_CONFIG_YAML}${extra}`,
  );
}

function writeMd(rel: string, content: string): void {
  const path = join(vault, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}

interface FixtureEvent {
  readonly timestamp: string;
  readonly kind: string;
  readonly body: Record<string, string>;
}

function writeJsonlDay(date: string, events: ReadonlyArray<FixtureEvent>): void {
  const lines = events
    .map((e) => JSON.stringify({ ts: e.timestamp, kind: e.kind, payload: e.body }))
    .join("\n");
  writeFileSync(join(brainDirs(vault).log, `${date}.jsonl`), lines + "\n");
}

function seedFullVault(): void {
  writeConfig("\nnotes:\n  read_paths:\n    - Daily\n");
  mkdirSync(brainDirs(vault).log, { recursive: true });

  addObligation(vault, {
    title: "Past Due",
    cadence: "weekly",
    agent: "test-agent",
    anchor: "2026-07-01",
    now: NOW,
  });
  addObligation(vault, {
    title: "Upcoming",
    cadence: "weekly",
    agent: "test-agent",
    anchor: "2026-07-24",
    now: NOW,
  });

  writeMd("Daily/2026-07-17.md", "@osb loop follow up on the vendor id=vendor\n");

  writeJsonlDay("2026-07-16", [
    { timestamp: "2026-07-16T09:00:00Z", kind: "note", body: { text: "shipped v1" } },
  ]);
}

describe("buildTodayDashboard - empty vault", () => {
  test("all four sections are present with zero counts and no errors", () => {
    const dashboard = buildTodayDashboard(vault, { now: NOW });

    expect(dashboard.obligations.items).toEqual([]);
    expect(dashboard.openLoops.openLoops).toEqual([]);
    expect(dashboard.openLoops.counts).toEqual({ openCount: 0, closedCount: 0, scannedFiles: 0 });
    expect(dashboard.recentActivity.entries).toEqual([]);
    expect(dashboard.recentActivity.total).toBe(0);
    expect(dashboard.totals).toEqual({
      obligationsTotal: 0,
      obligationsOverdue: 0,
      obligationsDueToday: 0,
      openLoopsCount: 0,
      recentActivityTotal: 0,
      scannedFiles: 0,
    });
    expect(dashboard.errors).toEqual([]);
  });

  test("empty sections render a (none) line under each fixed header", () => {
    const dashboard = buildTodayDashboard(vault, { now: NOW });
    expect(dashboard.text).toBe(
      [
        "## Obligations",
        "(none)",
        "",
        "## Open loops",
        "(none)",
        "",
        "## Recent activity",
        "(none)",
        "",
        "## Totals",
        "Obligations: 0",
        "Overdue: 0",
        "Due today: 0",
        "Open loops: 0",
        "Recent activity: 0",
        "Scanned files: 0",
      ].join("\n"),
    );
  });
});

describe("buildTodayDashboard - populated vault", () => {
  test("obligations section is due/overdue-first via listObligations's own sort", () => {
    seedFullVault();
    const dashboard = buildTodayDashboard(vault, { now: NOW });
    expect(dashboard.obligations.items.map((i) => i.slug)).toEqual(["past-due", "upcoming"]);
    expect(dashboard.obligations.items[0]).toEqual({
      slug: "past-due",
      title: "Past Due",
      overdue: true,
      daysUntilDue: -16,
      nextDue: "2026-07-01",
    });
    expect(dashboard.obligations.items[1]!.overdue).toBe(false);
  });

  test("open loops section reflects scanOpenLoops's id/text/path/line plus counts", () => {
    seedFullVault();
    const dashboard = buildTodayDashboard(vault, { now: NOW });
    expect(dashboard.openLoops.openLoops).toEqual([
      { id: "vendor", text: "follow up on the vendor", path: "Daily/2026-07-17.md", line: 1 },
    ]);
    expect(dashboard.openLoops.counts.openCount).toBe(1);
    expect(dashboard.openLoops.counts.scannedFiles).toBe(1);
  });

  test("recent activity section windows over activityLookbackDays via buildActivityTimeline", () => {
    seedFullVault();
    const dashboard = buildTodayDashboard(vault, { now: NOW, activityLookbackDays: 7 });
    expect(dashboard.recentActivity.entries).toHaveLength(1);
    expect(dashboard.recentActivity.entries[0]!.text).toBe("shipped v1");
    expect(dashboard.recentActivity.total).toBe(1);
  });

  test("recent activity section excludes events outside the lookback window", () => {
    seedFullVault();
    // The seeded event sits at 2026-07-16T09:00; a 0-day lookback from
    // 2026-07-17T12:00 excludes it (since is exclusive-lower-bound safe
    // margin aside, it is well outside one day).
    const dashboard = buildTodayDashboard(vault, { now: NOW, activityLookbackDays: 0 });
    expect(dashboard.recentActivity.entries).toEqual([]);
    expect(dashboard.recentActivity.total).toBe(0);
  });

  test("recent activity section honors activityLimit", () => {
    seedFullVault();
    writeJsonlDay("2026-07-17", [
      { timestamp: "2026-07-17T01:00:00Z", kind: "note", body: { text: "second" } },
      { timestamp: "2026-07-17T02:00:00Z", kind: "note", body: { text: "third" } },
    ]);
    const dashboard = buildTodayDashboard(vault, { now: NOW, activityLimit: 2 });
    expect(dashboard.recentActivity.entries).toHaveLength(2);
    expect(dashboard.recentActivity.total).toBe(3);
    expect(dashboard.recentActivity.entries.map((e) => e.text)).toEqual(["third", "second"]);
  });

  test("totals are cross-checked against the section contents that produced them", () => {
    seedFullVault();
    const dashboard = buildTodayDashboard(vault, { now: NOW });
    expect(dashboard.totals.obligationsTotal).toBe(dashboard.obligations.items.length);
    expect(dashboard.totals.obligationsOverdue).toBe(
      dashboard.obligations.items.filter((i) => i.overdue).length,
    );
    expect(dashboard.totals.obligationsDueToday).toBe(
      dashboard.obligations.items.filter((i) => !i.overdue && i.daysUntilDue === 0).length,
    );
    expect(dashboard.totals.openLoopsCount).toBe(dashboard.openLoops.counts.openCount);
    expect(dashboard.totals.recentActivityTotal).toBe(dashboard.recentActivity.total);
    expect(dashboard.totals.scannedFiles).toBe(dashboard.openLoops.counts.scannedFiles);
  });

  test("rendered text carries all four sections in fixed order with real content", () => {
    seedFullVault();
    const dashboard = buildTodayDashboard(vault, { now: NOW });
    const headerOrder = [...dashboard.text.matchAll(/^## .+$/gmu)].map((m) => m[0]);
    expect(headerOrder).toEqual([
      "## Obligations",
      "## Open loops",
      "## Recent activity",
      "## Totals",
    ]);
    expect(dashboard.text).toContain(
      "- Past Due (slug: past-due) - next due 2026-07-01 - overdue by 16d",
    );
    expect(dashboard.text).toContain(
      "- follow up on the vendor (id: vendor) - Daily/2026-07-17.md:1",
    );
    expect(dashboard.text).toContain("- [note] shipped v1");
    expect(dashboard.text).toContain("Open loops: 1");
  });
});

describe("buildTodayDashboard - fault isolation", () => {
  test("a corrupted obligations directory fails only that section; the rest still render", () => {
    seedFullVault();
    // Force listObligations to throw: replace Brain/obligations (a
    // directory `addObligation` just created) with a plain file, so
    // `readdirSync` on it throws ENOTDIR instead of returning entries.
    rmSync(join(brainDirs(vault).brain, "obligations"), { recursive: true, force: true });
    writeFileSync(join(brainDirs(vault).brain, "obligations"), "not a directory", "utf8");

    const dashboard = buildTodayDashboard(vault, { now: NOW });

    expect(dashboard.errors).toHaveLength(1);
    expect(dashboard.errors[0]!.section).toBe("obligations");
    expect(dashboard.errors[0]!.message.length).toBeGreaterThan(0);

    // Obligations falls back to a well-formed empty shape.
    expect(dashboard.obligations.items).toEqual([]);

    // The other two live sections still compute normally.
    expect(dashboard.openLoops.openLoops).toEqual([
      { id: "vendor", text: "follow up on the vendor", path: "Daily/2026-07-17.md", line: 1 },
    ]);
    expect(dashboard.recentActivity.entries).toHaveLength(1);

    // Totals reflect the sections that did compute.
    expect(dashboard.totals.obligationsTotal).toBe(0);
    expect(dashboard.totals.openLoopsCount).toBe(1);
    expect(dashboard.totals.recentActivityTotal).toBe(1);

    // The rendered text carries an explicit error line for the failed
    // section only - not a blank, misleadingly-healthy-looking section.
    expect(dashboard.text).toContain("## Obligations\n- error:");
    expect(dashboard.text).toContain(
      "- follow up on the vendor (id: vendor) - Daily/2026-07-17.md:1",
    );
    expect(dashboard.text).not.toContain("## Obligations\n(none)");
  });
});

describe("buildTodayDashboard - determinism and framing", () => {
  test("two identical calls over the same vault produce identical envelopes", () => {
    seedFullVault();
    const first = buildTodayDashboard(vault, { now: NOW });
    const second = buildTodayDashboard(vault, { now: NOW });
    expect(second).toEqual(first);
  });

  test("the envelope and its section arrays are frozen", () => {
    seedFullVault();
    const dashboard = buildTodayDashboard(vault, { now: NOW });
    expect(Object.isFrozen(dashboard)).toBe(true);
    expect(Object.isFrozen(dashboard.obligations)).toBe(true);
    expect(Object.isFrozen(dashboard.obligations.items)).toBe(true);
    expect(Object.isFrozen(dashboard.openLoops)).toBe(true);
    expect(Object.isFrozen(dashboard.recentActivity)).toBe(true);
    expect(Object.isFrozen(dashboard.totals)).toBe(true);
    expect(Object.isFrozen(dashboard.errors)).toBe(true);
  });
});

describe("buildTodayDashboard - option validation", () => {
  test("a negative activityLookbackDays is a fail-closed rejection", () => {
    expect(() => buildTodayDashboard(vault, { now: NOW, activityLookbackDays: -1 })).toThrow();
  });

  test("a non-integer activityLimit is a fail-closed rejection", () => {
    expect(() => buildTodayDashboard(vault, { now: NOW, activityLimit: 1.5 })).toThrow();
  });
});
