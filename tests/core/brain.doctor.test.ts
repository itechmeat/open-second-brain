/**
 * Tests for src/core/brain/doctor.ts.
 *
 * Each invariant gets its own test: status-vs-folder mismatch, broken
 * wikilink, duplicate id, invalid ISO, malformed log header, unknown
 * schema version. The clean-vault and bootstrap-only cases assert that
 * a freshly initialised Brain layer reports zero issues.
 *
 * Fixtures are built by hand (writeFileSync) when the test specifically
 * needs a malformed file; otherwise we use the canonical writers so the
 * inputs match what the real Brain operations produce.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  brainConfigPath,
  brainDirs,
  logPath,
  preferencePath,
  retiredPath,
  signalPath,
} from "../../src/core/brain/paths.ts";
import { DEFAULT_BRAIN_CONFIG_YAML } from "../../src/core/brain/policy.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";
import { runDoctor } from "../../src/core/brain/doctor.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-brain-doctor-"));
  const dirs = brainDirs(tmp);
  for (const d of [
    dirs.brain,
    dirs.inbox,
    dirs.processed,
    dirs.preferences,
    dirs.retired,
    dirs.log,
  ]) {
    mkdirSync(d, { recursive: true });
  }
  // Drop a default _brain.yaml — most tests require a valid config so
  // the schema-version check passes silently.
  atomicWriteFileSync(brainConfigPath(tmp), DEFAULT_BRAIN_CONFIG_YAML);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("clean vault", () => {
  test("brain layer with only the bootstrap config reports zero issues", () => {
    const res = runDoctor(tmp);
    expect(res.errors).toEqual([]);
    expect(res.warnings).toEqual([]);
  });

  test("a vault without Brain/ at all reports zero issues (no Brain layer present is acceptable)", () => {
    const fresh = mkdtempSync(join(tmpdir(), "o2b-doctor-no-brain-"));
    try {
      const res = runDoctor(fresh);
      expect(res.errors).toEqual([]);
      expect(res.warnings).toEqual([]);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});

describe("status-vs-folder mismatch", () => {
  test("a file in preferences/ with status=retired raises a status-folder-mismatch warning", () => {
    const path = preferencePath(tmp, "broken");
    writeFileSync(
      path,
      [
        "---",
        "kind: brain-preference",
        "id: pref-broken",
        "created_at: 2026-05-14T10:42:00Z",
        "confirmed_at: null",
        "unconfirmed_until: 2026-05-28T10:42:00Z",
        "tags: [brain, brain/preference]",
        "topic: broken",
        "status: retired",
        "principle: Hand-crafted mismatch",
        "evidenced_by: []",
        "applied_count: 0",
        "violated_count: 0",
        "last_evidence_at: null",
        "confidence: low",
        "pinned: false",
        "---",
        "",
        "## Principle",
        "Mismatch",
        "",
      ].join("\n"),
      "utf8",
    );
    const res = runDoctor(tmp);
    expect(res.errors).toEqual([]);
    expect(res.warnings.some((w) => w.code === "status-folder-mismatch")).toBe(
      true,
    );
  });
});

describe("broken wikilinks", () => {
  test("a preference whose evidenced_by points at a missing signal raises a broken-wikilink warning", () => {
    writePreference(tmp, {
      slug: "alpha",
      topic: "alpha",
      principle: "rule",
      created_at: "2026-05-14T10:00:00Z",
      unconfirmed_until: "2026-05-28T10:00:00Z",
      status: "unconfirmed",
      evidenced_by: ["[[sig-never-existed]]"],
    });
    const res = runDoctor(tmp);
    expect(res.errors).toEqual([]);
    expect(
      res.warnings.some(
        (w) =>
          w.code === "broken-wikilink" &&
          w.message.includes("sig-never-existed"),
      ),
    ).toBe(true);
  });

  test("a preference with an existing wikilink target produces no broken-wikilink warning", () => {
    // Create a signal first so the wikilink target resolves.
    writeSignal(tmp, {
      topic: "alpha",
      signal: "negative",
      agent: "claude",
      principle: "rule",
      created_at: "2026-05-13T10:00:00Z",
      date: "2026-05-13",
      slug: "alpha",
    });
    writePreference(tmp, {
      slug: "alpha",
      topic: "alpha",
      principle: "rule",
      created_at: "2026-05-14T10:00:00Z",
      unconfirmed_until: "2026-05-28T10:00:00Z",
      status: "unconfirmed",
      evidenced_by: ["[[sig-2026-05-13-alpha]]"],
    });
    const res = runDoctor(tmp);
    expect(res.warnings.filter((w) => w.code === "broken-wikilink")).toEqual(
      [],
    );
  });
});

describe("duplicate id", () => {
  test("two preference files sharing the same id raise a duplicate-id error", () => {
    // Write the canonical pref-alpha, then drop a second file with a
    // different filename basename but the same `id` in frontmatter.
    writePreference(tmp, {
      slug: "alpha",
      topic: "alpha",
      principle: "rule",
      created_at: "2026-05-14T10:00:00Z",
      unconfirmed_until: "2026-05-28T10:00:00Z",
      status: "unconfirmed",
      evidenced_by: [],
    });
    const dirs = brainDirs(tmp);
    const dupPath = join(dirs.preferences, "pref-dup-name.md");
    writeFileSync(
      dupPath,
      [
        "---",
        "kind: brain-preference",
        "id: pref-alpha", // intentional duplicate
        "created_at: 2026-05-14T10:00:00Z",
        "confirmed_at: null",
        "unconfirmed_until: 2026-05-28T10:00:00Z",
        "tags: [brain, brain/preference]",
        "topic: alpha",
        "status: unconfirmed",
        "principle: Duplicate id",
        "evidenced_by: []",
        "applied_count: 0",
        "violated_count: 0",
        "last_evidence_at: null",
        "confidence: low",
        "pinned: false",
        "---",
        "",
      ].join("\n"),
      "utf8",
    );
    const res = runDoctor(tmp);
    expect(res.errors.some((e) => e.code === "duplicate-id")).toBe(true);
  });
});

describe("invalid ISO", () => {
  test("a preference with a malformed unconfirmed_until raises an iso-invalid error", () => {
    const path = preferencePath(tmp, "bad-iso");
    writeFileSync(
      path,
      [
        "---",
        "kind: brain-preference",
        "id: pref-bad-iso",
        "created_at: 2026-05-14T10:42:00Z",
        "confirmed_at: null",
        "unconfirmed_until: not-a-real-iso",
        "tags: [brain, brain/preference]",
        "topic: bad-iso",
        "status: unconfirmed",
        "principle: Hand-crafted",
        "evidenced_by: []",
        "applied_count: 0",
        "violated_count: 0",
        "last_evidence_at: null",
        "confidence: low",
        "pinned: false",
        "---",
        "",
      ].join("\n"),
      "utf8",
    );
    const res = runDoctor(tmp);
    expect(res.errors.some((e) => e.code === "iso-invalid")).toBe(true);
  });
});

describe("malformed log header", () => {
  test("a log file with a bogus event header surfaces a log-malformed warning", () => {
    const path = logPath(tmp, "2026-05-14");
    writeFileSync(
      path,
      [
        "---",
        "kind: brain-log",
        "date: 2026-05-14",
        "tags: [brain, brain/log]",
        "---",
        "",
        "# Brain log — 2026-05-14",
        "",
        "## 10:42:00Z — dream",
        "- run_id: dream-2026-05-14-104200",
        "",
        "## NOT A VALID HEADER", // missing time / em-dash
        "- something: weird",
        "",
        "## 11:00:00Z — totally-bogus-kind", // unknown event
        "- foo: bar",
      ].join("\n"),
      "utf8",
    );
    const res = runDoctor(tmp);
    expect(res.warnings.some((w) => w.code === "log-malformed")).toBe(true);
  });
});

describe("schema_version", () => {
  test("unknown schema_version raises a schema-version-unknown or config-invalid error", () => {
    atomicWriteFileSync(
      brainConfigPath(tmp),
      [
        "schema_version: 999",
        "",
        "dream:",
        "  candidate_threshold: 3",
        "  unconfirmed_window_days: 14",
        "  contradiction_window_days: 14",
        "",
        "retire:",
        "  stale_evidence_days: 90",
        "",
        "confidence:",
        "  low_max_applied: 2",
        "  high_min_applied: 10",
        "  high_freshness_factor: 0.8",
        "",
        "snapshots:",
        "  retention_count: 10",
        "",
      ].join("\n"),
    );
    const res = runDoctor(tmp);
    expect(
      res.errors.some(
        (e) =>
          e.code === "schema-version-unknown" || e.code === "config-invalid",
      ),
    ).toBe(true);
  });
});

describe("required fields per kind", () => {
  test("a signal missing a required field is surfaced as an error", () => {
    const dirs = brainDirs(tmp);
    const sigPath = signalPath(tmp, "2026-05-14", "missing-fields");
    void dirs;
    writeFileSync(
      sigPath,
      [
        "---",
        "kind: brain-signal",
        "id: sig-2026-05-14-missing-fields",
        "created_at: 2026-05-14T10:00:00Z",
        "tags: [brain, brain/signal]",
        // topic missing intentionally
        "signal: negative",
        "agent: claude",
        "principle: rule",
        "---",
        "",
        "## Raw",
        "",
        "_(not provided)_",
        "",
      ].join("\n"),
      "utf8",
    );
    const res = runDoctor(tmp);
    expect(
      res.errors.some(
        (e) => e.code === "signal-invalid" && /topic/.test(e.message),
      ),
    ).toBe(true);
  });
});

describe("retired entries", () => {
  test("a valid retired file linking to its retired_by log produces no warnings", () => {
    // Create the log file the retired entry will link to.
    const dirs = brainDirs(tmp);
    writeFileSync(
      logPath(tmp, "2026-08-12"),
      [
        "---",
        "kind: brain-log",
        "date: 2026-08-12",
        "tags: [brain, brain/log]",
        "---",
        "",
        "# Brain log — 2026-08-12",
        "",
        "## 05:00:00Z — retire",
        "- preference: [[pref-alpha]]",
        "- reason: stale-no-evidence",
        "",
      ].join("\n"),
      "utf8",
    );
    void dirs;
    writeFileSync(
      retiredPath(tmp, "alpha"),
      [
        "---",
        "kind: brain-retired",
        "id: ret-alpha",
        "status: retired",
        "retired_at: 2026-08-12T05:00:00Z",
        "retired_reason: stale-no-evidence",
        'retired_by: "[[2026-08-12]]"',
        "created_at: 2026-05-14T10:00:00Z",
        "tags: [brain, brain/retired]",
        "topic: alpha",
        "principle: rule",
        "evidenced_by: []",
        "applied_count: 0",
        "violated_count: 0",
        "last_evidence_at: null",
        "confidence: low",
        "pinned: false",
        "---",
        "",
        "## Retired",
        "Reason: stale-no-evidence",
        "",
      ].join("\n"),
      "utf8",
    );
    const res = runDoctor(tmp);
    expect(res.errors).toEqual([]);
    expect(res.warnings.filter((w) => w.code === "broken-wikilink")).toEqual(
      [],
    );
  });
});

describe("missing config", () => {
  test("absent _brain.yaml triggers a config-missing error", () => {
    // Remove the config that beforeEach() wrote.
    rmSync(brainConfigPath(tmp));
    const res = runDoctor(tmp);
    expect(res.errors.some((e) => e.code === "config-missing")).toBe(true);
  });
});
