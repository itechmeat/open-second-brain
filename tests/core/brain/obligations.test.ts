import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  addObligation,
  completeObligation,
  listObligations,
  nextDueDate,
  parseCadence,
  removeObligation,
  showObligation,
  ObligationError,
} from "../../../src/core/brain/obligations.ts";

const NOW = new Date("2026-06-19T12:00:00Z");

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-obligations-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

test("parseCadence accepts the canonical set and every-N-days", () => {
  expect(parseCadence("weekly")).toBe("weekly");
  expect(parseCadence("MONTHLY")).toBe("monthly");
  expect(parseCadence("every-10-days")).toBe("every-10-days");
  expect(() => parseCadence("fortnightly")).toThrow(ObligationError);
  expect(() => parseCadence("every-0-days")).toThrow(ObligationError);
});

test("nextDueDate is deterministic calendar math", () => {
  expect(nextDueDate("daily", "2026-06-19")).toBe("2026-06-20");
  expect(nextDueDate("weekly", "2026-06-19")).toBe("2026-06-26");
  expect(nextDueDate("biweekly", "2026-06-19")).toBe("2026-07-03");
  expect(nextDueDate("monthly", "2026-06-19")).toBe("2026-07-19");
  expect(nextDueDate("quarterly", "2026-06-19")).toBe("2026-09-19");
  expect(nextDueDate("yearly", "2026-06-19")).toBe("2027-06-19");
  expect(nextDueDate("every-3-days", "2026-06-19")).toBe("2026-06-22");
});

test("monthly cadence clamps to the last day of a short month", () => {
  expect(nextDueDate("monthly", "2026-01-31")).toBe("2026-02-28");
  expect(nextDueDate("monthly", "2028-01-31")).toBe("2028-02-29"); // leap year
});

test("addObligation creates a page with next_due at the anchor", () => {
  const page = addObligation(vault, {
    title: "Weekly Review",
    cadence: "weekly",
    agent: "test-agent",
    anchor: "2026-06-22",
    now: NOW,
  });
  expect(page.slug).toBe("weekly-review");
  expect(page.cadence).toBe("weekly");
  expect(page.anchor).toBe("2026-06-22");
  expect(page.nextDue).toBe("2026-06-22");
  expect(page.lastDone).toBeNull();
  expect(page.path.endsWith(join("Brain", "obligations", "weekly-review.md"))).toBe(true);
  expect(readFileSync(page.path, "utf8")).toContain("cadence: weekly");
});

test("addObligation defaults the anchor to today", () => {
  const page = addObligation(vault, {
    title: "Standup",
    cadence: "daily",
    agent: "a",
    now: NOW,
  });
  expect(page.anchor).toBe("2026-06-19");
  expect(page.nextDue).toBe("2026-06-19");
});

test("addObligation rejects an invalid cadence and a duplicate slug", () => {
  expect(() =>
    addObligation(vault, { title: "X", cadence: "never", agent: "a", now: NOW }),
  ).toThrow(ObligationError);
  addObligation(vault, { title: "Dup", cadence: "weekly", agent: "a", now: NOW });
  expect(() =>
    addObligation(vault, { title: "Dup", cadence: "weekly", agent: "a", now: NOW }),
  ).toThrow(/already exists/);
});

test("completeObligation records a completion and advances next_due", () => {
  addObligation(vault, {
    title: "Monthly Report",
    cadence: "monthly",
    agent: "a",
    anchor: "2026-06-01",
    now: NOW,
  });
  const done = completeObligation(vault, { slug: "monthly-report", date: "2026-06-01" });
  expect(done.lastDone).toBe("2026-06-01");
  expect(done.nextDue).toBe("2026-07-01");
  expect(done.completions).toEqual(["2026-06-01"]);

  const again = completeObligation(vault, { slug: "monthly-report", date: "2026-07-03" });
  expect(again.nextDue).toBe("2026-08-03");
  expect(again.completions).toEqual(["2026-07-03", "2026-06-01"]);
});

test("completeObligation throws for an unknown obligation", () => {
  expect(() => completeObligation(vault, { slug: "ghost" })).toThrow(/no obligation/);
});

test("listObligations sorts by next_due and flags overdue", () => {
  addObligation(vault, {
    title: "Soon",
    cadence: "weekly",
    agent: "a",
    anchor: "2026-06-25",
    now: NOW,
  });
  addObligation(vault, {
    title: "Past",
    cadence: "weekly",
    agent: "a",
    anchor: "2026-06-10",
    now: NOW,
  });
  const items = listObligations(vault, { now: NOW });
  expect(items.map((i) => i.slug)).toEqual(["past", "soon"]);
  expect(items[0]!.overdue).toBe(true);
  expect(items[0]!.daysUntilDue).toBe(-9);
  expect(items[1]!.overdue).toBe(false);
  expect(items[1]!.daysUntilDue).toBe(6);

  const overdueOnly = listObligations(vault, { now: NOW, overdueOnly: true });
  expect(overdueOnly.map((i) => i.slug)).toEqual(["past"]);
});

test("showObligation reads back round-trip and survives completions", () => {
  addObligation(vault, {
    title: "Backup Audit",
    cadence: "quarterly",
    agent: "a",
    anchor: "2026-06-19",
    notes: "Verify offsite encryption keys.",
    now: NOW,
  });
  completeObligation(vault, { slug: "backup-audit", date: "2026-06-19" });
  const page = showObligation(vault, "backup-audit");
  expect(page).not.toBeNull();
  expect(page!.notes).toBe("Verify offsite encryption keys.");
  expect(page!.nextDue).toBe("2026-09-19");
  expect(page!.lastDone).toBe("2026-06-19");
});

test("removeObligation archives the page and clears the active file", () => {
  const page = addObligation(vault, { title: "Old", cadence: "weekly", agent: "a", now: NOW });
  const result = removeObligation(vault, "old");
  expect(existsSync(page.path)).toBe(false);
  expect(existsSync(result.archivePath)).toBe(true);
  expect(result.archivePath).toContain(join("obligations", "archive", "old.md"));
  expect(showObligation(vault, "old")).toBeNull();
});

test("rejects an unparseable anchor date", () => {
  expect(() =>
    addObligation(vault, {
      title: "Bad",
      cadence: "weekly",
      agent: "a",
      anchor: "2026-13-40",
      now: NOW,
    }),
  ).toThrow(ObligationError);
});

test("rejects overflow calendar dates instead of normalizing them", () => {
  expect(() =>
    addObligation(vault, {
      title: "Impossible Anchor",
      cadence: "weekly",
      agent: "a",
      anchor: "2026-02-31",
      now: NOW,
    }),
  ).toThrow(ObligationError);

  addObligation(vault, {
    title: "Possible Anchor",
    cadence: "weekly",
    agent: "a",
    anchor: "2026-02-28",
    now: NOW,
  });
  expect(() => completeObligation(vault, { slug: "possible-anchor", date: "2026-04-31" })).toThrow(
    ObligationError,
  );
});
