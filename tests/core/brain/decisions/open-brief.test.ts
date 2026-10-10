/**
 * Open-decisions morning-brief section (write-side-trust wave, Lane E,
 * Task 10). Render-only: the section never mutates the records it shows
 * (no delivery marking - the trigger brief's write step has no analogue
 * here), caps at five, and never renders an unreadable record as an
 * empty section.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  OPEN_DECISIONS_BRIEF_CAP,
  renderOpenDecisionsBriefSection,
} from "../../../../src/core/brain/decisions/brief.ts";
import {
  openDecision,
  resolveOpenDecision,
} from "../../../../src/core/brain/decisions/open-store.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-open-decisions-brief-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

const DAY = (n: number) => new Date(`2026-10-0${n}T09:00:00Z`);

describe("renderOpenDecisionsBriefSection", () => {
  test("an empty vault renders nothing", () => {
    const section = renderOpenDecisionsBriefSection(vault);
    expect(section.text).toBe("");
    expect(section.records).toEqual([]);
    expect(section.unreadable).toEqual([]);
  });

  test("renders open records oldest-first with their ids", () => {
    const older = openDecision(vault, {
      title: "First parked question",
      question: "Do we keep the legacy importer?",
      options: ["keep", "drop"],
      agent: "tester",
      now: DAY(1),
    });
    const newer = openDecision(vault, {
      title: "Second parked question",
      question: "Which retry budget for ingest?",
      options: ["3", "5"],
      agent: "tester",
      now: DAY(2),
    });
    const section = renderOpenDecisionsBriefSection(vault);
    expect(section.text).toContain("## Open decisions");
    expect(section.text.indexOf(older.id)).toBeLessThan(section.text.indexOf(newer.id));
    expect(section.text).toContain("Do we keep the legacy importer?");
    expect(section.records.map((r) => r.id)).toEqual([older.id, newer.id]);
  });

  test("caps at five records", () => {
    expect(OPEN_DECISIONS_BRIEF_CAP).toBe(5);
    for (let i = 1; i <= 7; i++) {
      openDecision(vault, {
        title: `Question number ${i}`,
        question: `Parked question ${i}?`,
        options: ["a", "b"],
        agent: "tester",
        now: new Date(`2026-10-0${i}T09:00:00Z`),
      });
    }
    const section = renderOpenDecisionsBriefSection(vault);
    expect(section.records).toHaveLength(5);
    expect(section.text).toContain("Parked question 1?");
    expect(section.text).not.toContain("Parked question 6?");
  });

  test("terminal records are not surfaced", () => {
    const rec = openDecision(vault, {
      title: "Resolved question",
      question: "Resolved already?",
      options: ["a"],
      agent: "tester",
      now: DAY(1),
    });
    openDecision(vault, {
      title: "Open question",
      question: "Still parked?",
      options: ["a"],
      agent: "tester",
      now: DAY(2),
    });
    resolveOpenDecision(vault, rec.id, { choice: "a" });
    const section = renderOpenDecisionsBriefSection(vault);
    expect(section.records).toHaveLength(1);
    expect(section.text).toContain("Still parked?");
    expect(section.text).not.toContain("Resolved already?");
  });

  test("an unreadable record is named in the section and never hides the readable ones", () => {
    const broken = openDecision(vault, {
      title: "Broken",
      question: "Broken record?",
      options: ["a"],
      agent: "tester",
      now: DAY(1),
    });
    writeFileSync(
      broken.path,
      readFileSync(broken.path, "utf8").replace("status: open", "status: gone"),
      "utf8",
    );
    openDecision(vault, {
      title: "Healthy",
      question: "Healthy record?",
      options: ["a"],
      agent: "tester",
      now: DAY(2),
    });
    const section = renderOpenDecisionsBriefSection(vault);
    expect(section.records).toHaveLength(1);
    expect(section.unreadable).toHaveLength(1);
    expect(section.text).toContain("## Unreadable open decisions");
    expect(section.text).toContain("status");
    expect(section.text).toContain("Healthy record?");
  });

  test("rendering is read-only: the records on disk are byte-identical afterwards", () => {
    const rec = openDecision(vault, {
      title: "Unchanged",
      question: "Unchanged?",
      options: ["a", "b"],
      agent: "tester",
      now: DAY(1),
    });
    const before = readFileSync(rec.path, "utf8");
    renderOpenDecisionsBriefSection(vault);
    expect(readFileSync(rec.path, "utf8")).toBe(before);
  });
});
