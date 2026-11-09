/**
 * The minimal view pages (task 2.9): `about-me.md`, `history/<YYYY>-W<ww>.md`
 * and `decisions.md`, rendered from store records only, with one HTML id
 * comment, no frontmatter and no Obsidian-only links. Snapshots in English
 * and Russian: generated prose follows `view.language`, quoted source lines
 * stay in the language they were written in. Nothing private reaches a page.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { runViewPass } from "../../../src/core/view/render.ts";
import { isoWeek } from "../../../src/core/view/pages.ts";
import { claimViewWriter } from "../../../src/core/view/writer.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import type { StoreHandle } from "../../../src/core/store/store-open.ts";
import { makeMachines, type Machines } from "./fixtures/machines.ts";
import { seedLogEvent, seedPreference, seedSetting } from "./fixtures/seed.ts";

const MON = Date.UTC(2026, 10, 2, 9, 0, 0); // Monday of ISO week 45
const DAY = 86_400_000;
let clock = MON + 10 * DAY;
const now = () => clock;

let m: Machines;
let a: StoreHandle;
beforeEach(() => {
  clock = MON + 10 * DAY;
  m = makeMachines(["dev-a"]);
  a = m.open("dev-a");
});
afterEach(() => m.cleanup());

function seed(): void {
  seedPreference(a, MON, "pref-no-bang", {
    principle: "Do not use exclamation marks in docs.",
    scope: "writing",
    status: "confirmed",
  });
  seedPreference(a, MON + 1, "pref-tests", {
    principle: "Run only the targeted tests.",
    status: "confirmed",
  });
  seedPreference(a, MON + 2, "pref-draft", { principle: "Still a draft.", status: "unconfirmed" });
  seedLogEvent(a, MON + 3600_000, "note", { text: "Shipped [[release-1-2|release 1.2]]." });
  seedLogEvent(a, MON + 2 * DAY, "decision-record", {
    decision: "[[decision-store]]",
    chosen: "Keep the store outside the vault",
    review_date: "2026-12-01",
  });
  seedLogEvent(a, MON + 3 * DAY, "note", { text: "Заметка на русском." });
}

function render(): void {
  claimViewWriter(a, { agent: "t", now });
  for (let i = 0; i < 2; i++) {
    clock += 1000;
    runViewPass(a, { target: m.view("dev-a"), vault: null, agent: "t", now });
  }
}

function page(rel: string): string {
  return readFileSync(join(m.view("dev-a"), ...rel.split("/")), "utf8").replaceAll(
    a.storeId,
    "<store>",
  );
}

describe("view pages", () => {
  test("English snapshot", () => {
    seed();
    render();
    expect(readdirSync(join(m.view("dev-a"), "history"))).toEqual(["2026-W45.md"]);
    expect(page("about-me.md")).toBe(
      [
        "<!-- open-second-brain-view store=<store> page=about-me.md -->",
        "",
        "# About me",
        "",
        "What the brain knows about you: confirmed rules, grouped by subject. Edit a line to correct a rule, or delete it to retire the rule.",
        "",
        "## writing",
        "",
        "- Do not use exclamation marks in docs.",
        "",
        "## General",
        "",
        "- Run only the targeted tests.",
        "",
      ].join("\n"),
    );
    expect(page("decisions.md")).toBe(
      [
        "<!-- open-second-brain-view store=<store> page=decisions.md -->",
        "",
        "# Decisions",
        "",
        "Decisions recorded by you and your agents, newest first.",
        "",
        "- 2026-11-04: Keep the store outside the vault (review on 2026-12-01)",
        "",
      ].join("\n"),
    );
    expect(page("history/2026-W45.md")).toBe(
      [
        "<!-- open-second-brain-view store=<store> page=history/2026-W45.md -->",
        "",
        "# Week 45 of 2026",
        "",
        "What happened this week, day by day.",
        "",
        "## Monday, 2026-11-02",
        "",
        "- New rule: Do not use exclamation marks in docs.",
        "- New rule: Run only the targeted tests.",
        "- Shipped release 1.2.",
        "",
        "## Wednesday, 2026-11-04",
        "",
        "- Decision: Keep the store outside the vault",
        "",
        "## Thursday, 2026-11-05",
        "",
        "- Заметка на русском.",
        "",
      ].join("\n"),
    );
  });

  test("Russian snapshot: generated prose in Russian, quoted source lines as written", () => {
    seed();
    seedSetting(a, MON + 4 * DAY, "view.language", "ru");
    render();
    expect(page("about-me.md")).toBe(
      [
        "<!-- open-second-brain-view store=<store> page=about-me.md -->",
        "",
        "# Обо мне",
        "",
        "Что мозг знает о вас: подтверждённые правила, сгруппированные по темам. Исправьте строку, чтобы поправить правило, или удалите её, чтобы снять правило.",
        "",
        "## writing",
        "",
        "- Do not use exclamation marks in docs.",
        "",
        "## Общее",
        "",
        "- Run only the targeted tests.",
        "",
      ].join("\n"),
    );
    expect(page("history/2026-W45.md")).toBe(
      [
        "<!-- open-second-brain-view store=<store> page=history/2026-W45.md -->",
        "",
        "# Неделя 45, 2026",
        "",
        "Что произошло за неделю, по дням.",
        "",
        "## Понедельник, 2026-11-02",
        "",
        "- Новое правило: Do not use exclamation marks in docs.",
        "- Новое правило: Run only the targeted tests.",
        "- Shipped release 1.2.",
        "",
        "## Среда, 2026-11-04",
        "",
        "- Решение: Keep the store outside the vault",
        "",
        "## Четверг, 2026-11-05",
        "",
        "- Заметка на русском.",
        "",
      ].join("\n"),
    );
    expect(page("decisions.md")).toContain(
      "- 2026-11-04: Keep the store outside the vault (пересмотр 2026-12-01)",
    );
  });

  test("pages carry no frontmatter and no Obsidian-only links", () => {
    seed();
    render();
    for (const rel of ["about-me.md", "decisions.md", "history/2026-W45.md"]) {
      const text = page(rel);
      expect(text.startsWith("---")).toBe(false);
      expect(text).not.toContain("[[");
      expect(text.split("\n").filter((l) => l.startsWith("<!--"))).toHaveLength(1);
    }
  });

  test("private records never reach a page; a rule with a private edit shows its last shared version", () => {
    seed();
    seedPreference(
      a,
      MON + 5,
      "pref-secret",
      { principle: "Secret rule.", status: "confirmed" },
      "private",
    );
    seedPreference(a, MON + 6, "pref-tests", { scope: "work" }, "private");
    seedPreference(a, MON + 7, "pref-region", {
      principle: "Call <private>my doctor</private> on Fridays.",
      status: "confirmed",
    });
    seedLogEvent(a, MON + 8, "note", { text: "Private note." }, "private");
    render();
    const all = ["about-me.md", "decisions.md", "history/2026-W45.md"].map(page).join("\n");
    expect(all).not.toContain("Secret rule");
    // The private edit's scope must not surface (as a "## work" section or anywhere).
    expect(all).not.toMatch(/\bwork\b/);
    expect(page("about-me.md")).toContain("## General\n\n- Run only the targeted tests.");
    expect(all).not.toContain("doctor");
    expect(all).not.toContain("Private note");
    expect(all).toContain("Do not use exclamation marks in docs.");
  });

  test("records imported later are placed by the time their body states", () => {
    // The store migration writes old events with the clock of the import:
    // the later one first, both long after they happened.
    const imported = MON + 9 * DAY;
    const write = (at: number, eventType: string, body: Record<string, unknown>) =>
      appendRecord(
        a,
        {
          partition: "shared",
          stream: "log",
          kind: "log-event",
          agent: "migration",
          body: { timestamp: new Date(at).toISOString(), event_type: eventType, body },
        },
        { now: () => imported },
      );
    write(MON + 3 * 3600_000, "note", { text: "Afternoon note." });
    write(MON + 1 * 3600_000, "note", { text: "Morning note." });
    write(MON + 2 * DAY, "decision-record", { chosen: "Later choice" });
    write(MON + 1 * DAY, "decision-record", { chosen: "Earlier choice" });
    render();
    const history = page("history/2026-W45.md");
    expect(history.indexOf("Morning note.")).toBeLessThan(history.indexOf("Afternoon note."));
    const decisions = page("decisions.md");
    expect(decisions.indexOf("Later choice")).toBeLessThan(decisions.indexOf("Earlier choice"));
    expect(decisions).toContain("2026-11-03: Earlier choice");
  });

  test("with no view folder configured, the writer writes no page", () => {
    seed();
    claimViewWriter(a, { agent: "t", now });
    runViewPass(a, { target: null, vault: null, agent: "t", now });
    expect(runViewPass(a, { target: null, vault: null, agent: "t", now })).toEqual({
      status: "no-target",
    });
    expect(existsSync(m.view("dev-a"))).toBe(false);
  });

  test("a rule confirmed again is new on the day of the confirmation in force", () => {
    seedPreference(a, MON, "pref-back", { principle: "Comes back.", status: "confirmed" });
    seedPreference(a, MON + DAY, "pref-back", { status: "retired" });
    seedPreference(a, MON + 3 * DAY, "pref-back", { status: "confirmed" });
    render();
    const week = page("history/2026-W45.md");
    const lines = week.split("\n");
    const ruleLine = lines.findIndex((l) => l.includes("Comes back."));
    expect(ruleLine).toBeGreaterThan(-1);
    const dayHeading = lines.slice(0, ruleLine).findLast((l) => l.startsWith("## "));
    expect(dayHeading).toContain("2026-11-05");
  });

  test("ISO weeks: the year boundary belongs to the week's Thursday", () => {
    expect(isoWeek("2026-12-31")).toEqual({ year: 2026, week: 53 });
    expect(isoWeek("2027-01-01")).toEqual({ year: 2026, week: 53 });
    expect(isoWeek("2027-01-04")).toEqual({ year: 2027, week: 1 });
    expect(isoWeek("2024-12-30")).toEqual({ year: 2025, week: 1 });
  });
});
