/**
 * v0.10.1 — body hygiene + signal suppression.
 *
 * Coverage:
 *   - signal `## Raw` section is OMITTED when `raw` is missing (no
 *     more `_(not provided)_` placeholder shipped on disk).
 *   - preference body skips empty sections, drops the redundant
 *     `## Principle` duplicate, and renders `## Recent applications`
 *     / `## Recent violations` from the supplied evidence arrays.
 *   - retired body is re-rendered from scratch on retire so the
 *     v0.10.1 shape is applied regardless of the source file format.
 *   - `o2b brain reject --reason` persists the text on the retired
 *     file as `user_rejected_reason`; dream's next pass emits
 *     `signal-suppressed` and moves the offending signal to
 *     `processed/`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { dream } from "../../src/core/brain/dream.ts";
import { moveToRetired, writePreference } from "../../src/core/brain/preference.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";
import {
  brainDirs,
  preferencePath,
  retiredPath,
  signalPath,
} from "../../src/core/brain/paths.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-body-hygiene-"));
  bootstrapBrain(vault);
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("signal body — no placeholder Raw", () => {
  test("Raw section is omitted entirely when `raw` is not provided", () => {
    writeSignal(vault, {
      topic: "no-raw-here",
      slug: "no-raw-here",
      date: "2026-05-16",
      created_at: "2026-05-16T10:00:00Z",
      signal: "negative",
      agent: "claude",
      principle: "Something",
    });
    const content = readFileSync(
      signalPath(vault, "2026-05-16", "no-raw-here"),
      "utf8",
    );
    expect(content).not.toContain("## Raw");
    expect(content).not.toContain("_(not provided)_");
  });

  test("Raw section is rendered when `raw` is provided", () => {
    writeSignal(vault, {
      topic: "with-raw",
      slug: "with-raw",
      date: "2026-05-16",
      created_at: "2026-05-16T10:00:00Z",
      signal: "negative",
      agent: "claude",
      principle: "Something",
      raw: "verbatim user quote",
    });
    const content = readFileSync(
      signalPath(vault, "2026-05-16", "with-raw"),
      "utf8",
    );
    expect(content).toContain("## Raw");
    expect(content).toContain("verbatim user quote");
  });
});

describe("preference body — only sections with content", () => {
  test("no Principle/Origin/HowToApply duplicate dead weight", () => {
    writePreference(vault, {
      slug: "lean",
      topic: "lean",
      principle: "Be lean",
      created_at: "2026-05-16T10:00:00Z",
      unconfirmed_until: "2026-05-30T10:00:00Z",
      status: "unconfirmed",
      evidenced_by: [],
      recentApplied: [],
      recentViolated: [],
    });
    const content = readFileSync(preferencePath(vault, "lean"), "utf8");
    expect(content).not.toContain("## Principle");
    expect(content).not.toContain("_(no evidence yet)_");
    expect(content).not.toContain("_(not provided)_");
    expect(content).not.toContain("## How to apply");
  });

  test("Origin renders wikilinks when evidenced_by is non-empty", () => {
    writePreference(vault, {
      slug: "with-origin",
      topic: "with-origin",
      principle: "P",
      created_at: "2026-05-16T10:00:00Z",
      unconfirmed_until: "2026-05-30T10:00:00Z",
      status: "unconfirmed",
      evidenced_by: ["[[sig-2026-05-16-a]]", "[[sig-2026-05-16-b]]"],
    });
    const content = readFileSync(preferencePath(vault, "with-origin"), "utf8");
    expect(content).toContain("## Origin");
    expect(content).toContain("- [[sig-2026-05-16-a]]");
    expect(content).toContain("- [[sig-2026-05-16-b]]");
  });

  test("Recent applications / violations render in priority order", () => {
    writePreference(vault, {
      slug: "tracked",
      topic: "tracked",
      principle: "P",
      created_at: "2026-05-16T10:00:00Z",
      unconfirmed_until: "2026-05-30T10:00:00Z",
      status: "confirmed",
      evidenced_by: [],
      recentApplied: [
        {
          timestamp: "2026-05-16T13:00:00Z",
          artifact: "[[docs/a.md:1-10]]",
          result: "applied",
          agent: "claude",
        },
      ],
      recentViolated: [
        {
          timestamp: "2026-05-16T14:00:00Z",
          artifact: "[[docs/b.md]]",
          result: "violated",
          note: "missed it",
        },
      ],
    });
    const content = readFileSync(preferencePath(vault, "tracked"), "utf8");
    expect(content).toContain("## Recent applications");
    expect(content).toContain("[[docs/a.md:1-10]]");
    expect(content).toContain("## Recent violations");
    expect(content).toContain("[[docs/b.md]]");
    expect(content).toContain("missed it");
  });
});

describe("retired body — re-rendered to v0.10.1 shape on retire", () => {
  test("v0.9.x placeholder body in source is replaced before append-Retired", () => {
    // Hand-craft a pref file in the old v0.9.x format with placeholder
    // body. The retire path must NOT carry those placeholders forward.
    const dirs = brainDirs(vault);
    mkdirSync(dirs.preferences, { recursive: true });
    const path = preferencePath(vault, "legacy");
    writeFileSync(
      path,
      [
        "---",
        "kind: brain-preference",
        "id: pref-legacy",
        "created_at: 2026-05-10T00:00:00Z",
        "confirmed_at: 2026-05-10T00:00:00Z",
        "unconfirmed_until: 2026-05-24T00:00:00Z",
        "tags: [brain, brain/preference, brain/topic/legacy]",
        "topic: legacy",
        "status: confirmed",
        "principle: legacy rule",
        "evidenced_by: []",
        "applied_count: 0",
        "violated_count: 0",
        "last_evidence_at: null",
        "confidence: low",
        "pinned: false",
        "---",
        "",
        "## Principle",
        "",
        "legacy rule",
        "",
        "## Origin",
        "",
        "_(no evidence yet)_",
        "",
        "## How to apply",
        "",
        "_(not provided)_",
      ].join("\n"),
      "utf8",
    );
    moveToRetired(vault, path, "user-rejected", {
      now: new Date("2026-05-16T10:00:00Z"),
      retired_by: "[[Brain/log/2026-05-16]]",
      user_rejected_reason: "irrelevant now",
    });
    const ret = readFileSync(retiredPath(vault, "legacy"), "utf8");
    expect(ret).not.toContain("_(no evidence yet)_");
    expect(ret).not.toContain("_(not provided)_");
    expect(ret).toContain("## Retired");
    expect(ret).toContain("user_rejected_reason: irrelevant now");
    expect(ret).toContain("User reason: irrelevant now");
  });
});

describe("§6 signal suppression", () => {
  test("a fresh signal on a user-rejected topic is suppressed and moved", () => {
    // Seed: a user-rejected retired pref with reason on the same topic.
    const dirs = brainDirs(vault);
    mkdirSync(dirs.retired, { recursive: true });
    writeFileSync(
      retiredPath(vault, "noisy"),
      [
        "---",
        "kind: brain-retired",
        "id: ret-noisy",
        "status: retired",
        "retired_at: 2026-05-10T00:00:00Z",
        "retired_reason: user-rejected",
        "retired_by: '[[Brain/log/2026-05-10]]'",
        "created_at: 2026-05-09T00:00:00Z",
        "tags: [brain, brain/retired, brain/topic/noisy]",
        "topic: noisy",
        "principle: stop spamming",
        "evidenced_by: []",
        "applied_count: 0",
        "violated_count: 0",
        "last_evidence_at: null",
        "confidence: low",
        "pinned: false",
        "user_rejected_reason: rule was wrong",
        "---",
        "",
      ].join("\n"),
      "utf8",
    );

    // Three fresh signals on the same topic that would otherwise
    // cross the candidate_threshold.
    for (let i = 1; i <= 3; i++) {
      writeSignal(vault, {
        topic: "noisy",
        slug: `noisy-${i}`,
        date: "2026-05-16",
        created_at: `2026-05-16T10:0${i}:00Z`,
        signal: "negative",
        agent: "claude",
        principle: "be noisy",
      });
    }

    const summary = dream(vault, { now: new Date("2026-05-16T12:00:00Z") });
    expect(summary.changed).toBe(true);
    expect(summary.suppressed.length).toBe(3);
    // No new pref must be created.
    expect(summary.new_unconfirmed).toEqual([]);
    // Signals must be out of inbox/ and into processed/.
    expect(summary.moved_to_processed.length).toBe(3);
    // Log carries the typed event.
    const logPath = join(vault, "Brain", "log", "2026-05-16.md");
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("signal-suppressed");
    expect(log).toContain("[[ret-noisy|stop spamming]]");
    expect(log).toContain("rule was wrong");
  });

  test("scoped suppressor does NOT swallow signals on a different scope", () => {
    // Retired pref scoped to `writing`.
    const dirs = brainDirs(vault);
    mkdirSync(dirs.retired, { recursive: true });
    writeFileSync(
      retiredPath(vault, "scoped"),
      [
        "---",
        "kind: brain-retired",
        "id: ret-scoped",
        "status: retired",
        "retired_at: 2026-05-10T00:00:00Z",
        "retired_reason: user-rejected",
        "retired_by: '[[Brain/log/2026-05-10]]'",
        "created_at: 2026-05-09T00:00:00Z",
        "tags: [brain, brain/retired, brain/topic/scoped, brain/scope/writing]",
        "topic: scoped",
        "scope: writing",
        "principle: writing-scoped rule",
        "evidenced_by: []",
        "applied_count: 0",
        "violated_count: 0",
        "last_evidence_at: null",
        "confidence: low",
        "pinned: false",
        "user_rejected_reason: writing-scope was the issue",
        "---",
        "",
      ].join("\n"),
      "utf8",
    );

    // Three fresh signals on the SAME topic but a DIFFERENT scope.
    for (let i = 1; i <= 3; i++) {
      writeSignal(vault, {
        topic: "scoped",
        slug: `scoped-${i}`,
        date: "2026-05-16",
        created_at: `2026-05-16T10:0${i}:00Z`,
        signal: "negative",
        agent: "claude",
        principle: "different-scope rule",
        scope: "coding",
      });
    }

    const summary = dream(vault, { now: new Date("2026-05-16T12:00:00Z") });
    expect(summary.suppressed.length).toBe(0);
    // A new pref is created (slug is suffixed because ret-scoped reserves
    // the bare slug, hence pref-scoped-2).
    expect(summary.new_unconfirmed.some((id) => id.startsWith("pref-scoped"))).toBe(
      true,
    );
    const logPath = join(vault, "Brain", "log", "2026-05-16.md");
    const log = readFileSync(logPath, "utf8");
    expect(log).not.toContain("signal-suppressed");
  });
});

describe("dream — body migration of v0.9.x preferences", () => {
  test("first pass after upgrade rewrites placeholder body to v0.10.1 shape", () => {
    // Pretend a v0.9.x pref already lives on disk with the legacy body.
    const dirs = brainDirs(vault);
    mkdirSync(dirs.preferences, { recursive: true });
    const path = preferencePath(vault, "migrate-me");
    writeFileSync(
      path,
      [
        "---",
        "kind: brain-preference",
        "id: pref-migrate-me",
        "created_at: 2026-05-10T00:00:00Z",
        "confirmed_at: 2026-05-10T00:00:00Z",
        "unconfirmed_until: 2026-05-24T00:00:00Z",
        "tags: [brain, brain/preference, brain/topic/migrate-me]",
        "topic: migrate-me",
        "status: confirmed",
        "principle: migrate me",
        'evidenced_by: ["[[sig-2026-05-09-migrate-me]]"]',
        "applied_count: 0",
        "violated_count: 0",
        "last_evidence_at: null",
        "confidence: low",
        "pinned: false",
        "---",
        "",
        "## Principle",
        "",
        "migrate me",
        "",
        "## Origin",
        "",
        "_(no evidence yet)_",
        "",
        "## How to apply",
        "",
        "_(not provided)_",
      ].join("\n"),
      "utf8",
    );
    dream(vault, { now: new Date("2026-05-16T12:00:00Z") });
    const after = readFileSync(path, "utf8");
    expect(after).not.toContain("_(no evidence yet)_");
    expect(after).not.toContain("_(not provided)_");
    expect(after).not.toContain("## Principle");
    // Origin section is preserved because evidenced_by is non-empty.
    expect(after).toContain("## Origin");
    expect(after).toContain("[[sig-2026-05-09-migrate-me]]");
  });
});
