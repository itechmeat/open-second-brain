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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addObligation } from "../../../src/core/brain/obligations.ts";
import { addPledge, fulfillPledge } from "../../../src/core/brain/pledges.ts";
import { brainDirs } from "../../../src/core/brain/paths.ts";
import { DEFAULT_BRAIN_CONFIG_YAML } from "../../../src/core/brain/config-template.ts";
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
  test("all five sections are present with zero counts and no errors", () => {
    const dashboard = buildTodayDashboard(vault, { now: NOW });

    expect(dashboard.obligations.items).toEqual([]);
    expect(dashboard.pledges.items).toEqual([]);
    expect(dashboard.openLoops.openLoops).toEqual([]);
    expect(dashboard.openLoops.counts).toEqual({ openCount: 0, closedCount: 0, scannedFiles: 0 });
    expect(dashboard.recentActivity.entries).toEqual([]);
    expect(dashboard.recentActivity.total).toBe(0);
    expect(dashboard.totals).toEqual({
      obligationsTotal: 0,
      obligationsOverdue: 0,
      obligationsDueToday: 0,
      pledgesTotal: 0,
      pledgesOverdue: 0,
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
        "## Pledges",
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
        "Pledges: 0",
        "Pledges overdue: 0",
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

  test("rendered text carries all five sections in fixed order with real content", () => {
    seedFullVault();
    const dashboard = buildTodayDashboard(vault, { now: NOW });
    const headerOrder = [...dashboard.text.matchAll(/^## .+$/gmu)].map((m) => m[0]);
    expect(headerOrder).toEqual([
      "## Obligations",
      "## Pledges",
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

  test("a readable predicate leaves out the pages it rejects before the totals", () => {
    seedFullVault();
    const asked: string[] = [];
    const dashboard = buildTodayDashboard(vault, {
      now: NOW,
      readable: (rel) => {
        asked.push(rel);
        return rel !== "Daily/2026-07-17.md" && rel !== "Brain/obligations/past-due.md";
      },
    });
    expect(asked).toContain("Daily/2026-07-17.md");
    expect(asked).toContain("Brain/obligations/past-due.md");
    expect(dashboard.obligations.items.map((i) => i.slug)).toEqual(["upcoming"]);
    expect(dashboard.openLoops.openLoops).toEqual([]);
    expect(dashboard.openLoops.counts.scannedFiles).toBe(0);
    expect(dashboard.totals.obligationsTotal).toBe(1);
    expect(dashboard.totals.obligationsOverdue).toBe(0);
    expect(dashboard.totals.openLoopsCount).toBe(0);
    expect(dashboard.text).not.toContain("vendor");
    expect(dashboard.text).not.toContain("Past Due");
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

describe("buildTodayDashboard - pledges section", () => {
  const SOURCE_REL = "Notes/promises-meeting.md";
  const EVIDENCE = ["send the weekly report"];

  function seedPledgeVault(): void {
    writeMd(
      SOURCE_REL,
      "# Promises meeting\n\nAlice asked me to send the weekly report to the team.\n",
    );
    for (const [title, due] of [
      ["Past Pledge", "2026-07-01"],
      ["Today Pledge", "2026-07-17"],
      ["Future Pledge", "2026-07-24"],
    ] as const) {
      addPledge(vault, {
        title,
        due,
        source: SOURCE_REL,
        evidence: EVIDENCE,
        agent: "test-agent",
        now: NOW,
      });
    }
  }

  test("the pledges section renders due-sorted open pledges with overdue and days-until-due", () => {
    seedPledgeVault();
    const dashboard = buildTodayDashboard(vault, { now: NOW });
    expect(dashboard.pledges.items.map((i) => i.slug)).toEqual([
      "past-pledge",
      "today-pledge",
      "future-pledge",
    ]);
    expect(dashboard.pledges.items[0]).toEqual({
      slug: "past-pledge",
      title: "Past Pledge",
      due: "2026-07-01",
      overdue: true,
      daysUntilDue: -16,
    });
    expect(dashboard.pledges.items[1]!.overdue).toBe(false);
    expect(dashboard.pledges.items[1]!.daysUntilDue).toBe(0);
    expect(dashboard.pledges.items[2]!.daysUntilDue).toBe(7);
    expect(dashboard.text).toContain(
      "- Past Pledge (slug: past-pledge) - due 2026-07-01 - overdue by 16d",
    );
    expect(dashboard.text).toContain(
      "- Today Pledge (slug: today-pledge) - due 2026-07-17 - due today",
    );
    expect(dashboard.text).toContain(
      "- Future Pledge (slug: future-pledge) - due 2026-07-24 - due in 7d",
    );
  });

  test("an undated pledge sorts last and reports a null days-until-due", () => {
    seedPledgeVault();
    const undated = addPledge(vault, {
      title: "Undated Pledge",
      due: "2026-07-24",
      source: SOURCE_REL,
      evidence: EVIDENCE,
      agent: "test-agent",
      now: NOW,
    });
    // A hand-edited frontmatter date the family soft-parses to empty.
    writeFileSync(
      undated.path,
      readFileSync(undated.path, "utf8").replace(`due: ${undated.due}`, "due: invalid"),
    );
    const dashboard = buildTodayDashboard(vault, { now: NOW });
    expect(dashboard.pledges.items.map((i) => i.slug)).toEqual([
      "past-pledge",
      "today-pledge",
      "future-pledge",
      "undated-pledge",
    ]);
    expect(dashboard.pledges.items[3]!.daysUntilDue).toBeNull();
    expect(dashboard.pledges.items[3]!.overdue).toBe(false);
    expect(dashboard.text).toContain("- Undated Pledge (slug: undated-pledge) - undated");
  });

  test("a fulfilled pledge is left out of the section and the totals", () => {
    seedPledgeVault();
    fulfillPledge(vault, { slug: "today-pledge", now: NOW });
    const dashboard = buildTodayDashboard(vault, { now: NOW });
    expect(dashboard.pledges.items.map((i) => i.slug)).toEqual(["past-pledge", "future-pledge"]);
    expect(dashboard.totals.pledgesTotal).toBe(2);
    expect(dashboard.totals.pledgesOverdue).toBe(1);
    expect(dashboard.text).not.toContain("Today Pledge");
  });

  test("totals gain pledgesTotal and pledgesOverdue derived from the already-built section", () => {
    seedPledgeVault();
    const dashboard = buildTodayDashboard(vault, { now: NOW });
    expect(dashboard.totals.pledgesTotal).toBe(dashboard.pledges.items.length);
    expect(dashboard.totals.pledgesOverdue).toBe(
      dashboard.pledges.items.filter((i) => i.overdue).length,
    );
    expect(dashboard.totals.pledgesTotal).toBe(3);
    expect(dashboard.totals.pledgesOverdue).toBe(1);
    expect(dashboard.text).toContain("Pledges: 3");
    expect(dashboard.text).toContain("Pledges overdue: 1");
  });

  test("a readable predicate removes withheld pledge pages before the totals", () => {
    seedPledgeVault();
    const dashboard = buildTodayDashboard(vault, {
      now: NOW,
      readable: (rel) => rel !== "Brain/pledges/past-pledge.md",
    });
    expect(dashboard.pledges.items.map((i) => i.slug)).toEqual(["today-pledge", "future-pledge"]);
    expect(dashboard.totals.pledgesTotal).toBe(2);
    expect(dashboard.totals.pledgesOverdue).toBe(0);
    expect(dashboard.text).not.toContain("Past Pledge");
  });

  test("a corrupted pledges directory fails only that section; the rest still render", () => {
    seedPledgeVault();
    // Force listPledges to throw the way the obligations fixture does:
    // swap the directory for a plain file so readdirSync throws ENOTDIR.
    rmSync(join(brainDirs(vault).brain, "pledges"), { recursive: true, force: true });
    writeFileSync(join(brainDirs(vault).brain, "pledges"), "not a directory", "utf8");

    const dashboard = buildTodayDashboard(vault, { now: NOW });

    expect(dashboard.errors).toHaveLength(1);
    expect(dashboard.errors[0]!.section).toBe("pledges");
    expect(dashboard.errors[0]!.message.length).toBeGreaterThan(0);
    expect(dashboard.pledges.items).toEqual([]);
    expect(dashboard.text).toContain("## Pledges\n- error:");
    expect(dashboard.text).not.toContain("## Pledges\n(none)");
    // The obligations section still computed over its own directory.
    expect(dashboard.totals.obligationsTotal).toBe(0);
    expect(dashboard.errors.map((e) => e.section)).not.toContain("obligations");
  });

  test("a vault with no pledges directory renders an empty pledges section with no error", () => {
    // seedFullVault populates the other four sections but never creates
    // Brain/pledges, so the pledges section answers empty on its own
    // directory-missing branch while the sections that do have pages still
    // render - a distinct shape from the empty-vault describe, where every
    // section is empty and this assertion would duplicate it.
    seedFullVault();
    const dashboard = buildTodayDashboard(vault, { now: NOW });
    expect(dashboard.pledges.items).toEqual([]);
    expect(dashboard.errors).toEqual([]);
    expect(dashboard.text).toContain("## Pledges\n(none)");
    expect(dashboard.obligations.items.map((i) => i.slug)).toEqual(["past-due", "upcoming"]);
    expect(dashboard.openLoops.counts.openCount).toBe(1);
    expect(dashboard.recentActivity.total).toBe(1);
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
    expect(Object.isFrozen(dashboard.pledges)).toBe(true);
    expect(Object.isFrozen(dashboard.pledges.items)).toBe(true);
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
