import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writePreference, type WritePreferenceInput } from "../../../src/core/brain/preference.ts";
import { buildSchemaReport } from "../../../src/core/brain/schema-report.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import {
  BRAIN_CONFIDENCE,
  BRAIN_PREFERENCE_STATUS,
  BRAIN_SIGNAL_SIGN,
} from "../../../src/core/brain/types.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-schema-report-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
  mkdirSync(join(vault, "Brain", "inbox"), { recursive: true });
  mkdirSync(join(vault, "Brain", "inbox", "processed"), { recursive: true });
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writeBrainConfig(body: string): void {
  writeFileSync(join(vault, "Brain", "_brain.yaml"), body, "utf8");
}

function basePref(
  slug: string,
  overrides: Partial<WritePreferenceInput> = {},
): WritePreferenceInput {
  return {
    slug,
    topic: "research",
    principle: `Principle for ${slug}`,
    created_at: "2026-05-30T12:00:00Z",
    unconfirmed_until: "2026-06-06T12:00:00Z",
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    evidenced_by: [],
    confirmed_at: "2026-05-30T13:00:00Z",
    confidence: BRAIN_CONFIDENCE.low,
    pinned: false,
    ...overrides,
  };
}

describe("buildSchemaReport", () => {
  test("returns resolved vocabulary, usage counts, and lint findings", () => {
    writeBrainConfig(
      [
        "schema_version: 1",
        "schema:",
        "  preference_types: [research, decision]",
        "  signal_types: [observation]",
        "  page_types: [paper, unused-page]",
        "  log_event_kinds: [milestone, unused-event]",
      ].join("\n"),
    );
    writePreference(
      vault,
      basePref("research-pref", {
        schema_type: "research",
      }),
    );
    writeSignal(vault, {
      topic: "research",
      signal: BRAIN_SIGNAL_SIGN.positive,
      agent: "tester",
      principle: "unknown signal schema type",
      created_at: "2026-05-30T12:00:00Z",
      date: "2026-05-30",
      slug: "external",
      schema_type: "external",
    });
    mkdirSync(join(vault, "Papers"), { recursive: true });
    writeFileSync(
      join(vault, "Papers", "paper.md"),
      ["---", "title: Paper", "schema_type: paper", "---", "", "Body"].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(vault, "Brain", "log", "2026-05-30.md"),
      [
        "# Brain log — 2026-05-30",
        "",
        "## 12:00:00 milestone",
        "- text: shipped schema report",
      ].join("\n"),
      "utf8",
    );

    const report = buildSchemaReport(vault);

    expect(report.vocabulary.preference_types).toEqual(["preference", "research", "decision"]);
    expect(report.vocabulary.signal_types).toEqual(["feedback", "observation"]);
    expect(report.usage.preference_types).toEqual([{ token: "research", count: 1 }]);
    expect(report.usage.signal_types).toEqual([{ token: "external", count: 1 }]);
    expect(report.usage.page_types).toEqual([{ token: "paper", count: 1 }]);
    expect(report.usage.log_event_kinds).toEqual([{ token: "milestone", count: 1 }]);
    expect(report.findings).toContainEqual({
      kind: "unknown-token",
      category: "signal_types",
      token: "external",
      path: "Brain/inbox/sig-2026-05-30-external.md",
    });
    expect(report.findings).toContainEqual({
      kind: "unused-declaration",
      category: "preference_types",
      token: "decision",
    });
    expect(report.findings).toContainEqual({
      kind: "unused-declaration",
      category: "signal_types",
      token: "observation",
    });
    expect(report.findings).toContainEqual({
      kind: "unused-declaration",
      category: "page_types",
      token: "unused-page",
    });
    expect(report.findings).toContainEqual({
      kind: "unused-declaration",
      category: "log_event_kinds",
      token: "unused-event",
    });
  });

  test("default vault has built-in vocabulary and no findings", () => {
    writeBrainConfig("schema_version: 1\n");

    const report = buildSchemaReport(vault);

    expect(report.vocabulary.preference_types).toEqual(["preference"]);
    expect(report.usage.preference_types).toEqual([]);
    expect(report.findings).toEqual([]);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.findings)).toBe(true);
  });
});
