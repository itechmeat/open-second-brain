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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    // v0.10.9: bootstrap-matched scaffold. The default _brain.yaml
    // lists `Brain/.snapshots` under `vault.ignore_paths`, so the
    // doctor's `vault-ignore-missing-path` lint expects the directory
    // to exist (real `o2b brain init` creates it).
    dirs.snapshots,
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
        "_confirmed_at: null",
        "unconfirmed_until: 2026-05-28T10:42:00Z",
        "tags: [brain, brain/preference]",
        "topic: broken",
        "_status: retired",
        "principle: Hand-crafted mismatch",
        "_evidenced_by: []",
        "_applied_count: 0",
        "_violated_count: 0",
        "_last_evidence_at: null",
        "_confidence: low",
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
    expect(res.warnings.some((w) => w.code === "status-folder-mismatch")).toBe(true);
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
        (w) => w.code === "broken-wikilink" && w.message.includes("sig-never-existed"),
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
    expect(res.warnings.filter((w) => w.code === "broken-wikilink")).toEqual([]);
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
        "_confirmed_at: null",
        "unconfirmed_until: 2026-05-28T10:00:00Z",
        "tags: [brain, brain/preference]",
        "topic: alpha",
        "_status: unconfirmed",
        "principle: Duplicate id",
        "_evidenced_by: []",
        "_applied_count: 0",
        "_violated_count: 0",
        "_last_evidence_at: null",
        "_confidence: low",
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
        "_confirmed_at: null",
        "unconfirmed_until: not-a-real-iso",
        "tags: [brain, brain/preference]",
        "topic: bad-iso",
        "_status: unconfirmed",
        "principle: Hand-crafted",
        "_evidenced_by: []",
        "_applied_count: 0",
        "_violated_count: 0",
        "_last_evidence_at: null",
        "_confidence: low",
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
        "  medium_min: 0.40",
        "  high_min: 0.75",
        "",
        "snapshots:",
        "  retention_count: 10",
        "",
      ].join("\n"),
    );
    const res = runDoctor(tmp);
    expect(
      res.errors.some((e) => e.code === "schema-version-unknown" || e.code === "config-invalid"),
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
    expect(res.errors.some((e) => e.code === "signal-invalid" && /topic/.test(e.message))).toBe(
      true,
    );
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
        "_status: retired",
        "retired_at: 2026-08-12T05:00:00Z",
        "retired_reason: stale-no-evidence",
        'retired_by: "[[2026-08-12]]"',
        "created_at: 2026-05-14T10:00:00Z",
        "tags: [brain, brain/retired]",
        "topic: alpha",
        "principle: rule",
        "_evidenced_by: []",
        "_applied_count: 0",
        "_violated_count: 0",
        "_last_evidence_at: null",
        "_confidence: low",
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
    expect(res.warnings.filter((w) => w.code === "broken-wikilink")).toEqual([]);
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

describe("duplicate-preferences lint", () => {
  test("flags two confirmed prefs in the same (topic, scope) bucket with similar principles", () => {
    writePreference(tmp, {
      slug: "a",
      topic: "tidy",
      principle: "Be tidy and consistent in writing",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-30T00:00:00Z",
      status: "confirmed",
      confirmed_at: "2026-05-02T00:00:00Z",
      evidenced_by: [],
      applied_count: 3,
      scope: "writing",
    });
    writePreference(tmp, {
      slug: "b",
      topic: "tidy",
      principle: "Be tidy and consistent when writing",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-30T00:00:00Z",
      status: "confirmed",
      confirmed_at: "2026-05-02T00:00:00Z",
      evidenced_by: [],
      applied_count: 3,
      scope: "writing",
    });
    const res = runDoctor(tmp);
    const dup = res.warnings.find((w) => w.code === "duplicate-preferences");
    expect(dup).toBeDefined();
    expect(dup!.message).toContain("pref-a");
    expect(dup!.message).toContain("pref-b");
  });

  test("does NOT flag prefs in different topics even with identical principles", () => {
    writePreference(tmp, {
      slug: "x",
      topic: "alpha",
      principle: "Identical principle text here",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-30T00:00:00Z",
      status: "confirmed",
      confirmed_at: "2026-05-02T00:00:00Z",
      evidenced_by: [],
      applied_count: 3,
    });
    writePreference(tmp, {
      slug: "y",
      topic: "beta",
      principle: "Identical principle text here",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-30T00:00:00Z",
      status: "confirmed",
      confirmed_at: "2026-05-02T00:00:00Z",
      evidenced_by: [],
      applied_count: 3,
    });
    const res = runDoctor(tmp);
    expect(res.warnings.find((w) => w.code === "duplicate-preferences")).toBeUndefined();
  });
});

describe("low-evidence-confirmed lint", () => {
  test("flags confirmed pref with applied_count ≤ low_max_applied past trial window", () => {
    // Default config: low_max_applied=2, unconfirmed_window_days=14.
    writePreference(tmp, {
      slug: "stagnant",
      topic: "stagnant",
      principle: "Got promoted but never applied",
      created_at: "2026-04-01T00:00:00Z",
      unconfirmed_until: "2026-04-15T00:00:00Z",
      status: "confirmed",
      confirmed_at: "2026-04-05T00:00:00Z",
      evidenced_by: [],
      applied_count: 1, // ≤ low_max_applied (2)
    });
    const now = new Date("2026-05-15T00:00:00Z"); // 40 days past confirmed_at
    const res = runDoctor(tmp, { now });
    const low = res.warnings.find((w) => w.code === "low-evidence-confirmed");
    expect(low).toBeDefined();
    expect(low!.message).toContain("pref-stagnant");
  });

  test("does NOT flag prefs still within the trial window", () => {
    writePreference(tmp, {
      slug: "fresh",
      topic: "fresh",
      principle: "Just promoted",
      created_at: "2026-05-10T00:00:00Z",
      unconfirmed_until: "2026-05-30T00:00:00Z",
      status: "confirmed",
      confirmed_at: "2026-05-10T00:00:00Z",
      evidenced_by: [],
      applied_count: 1,
    });
    const now = new Date("2026-05-12T00:00:00Z"); // 2 days past confirmed
    const res = runDoctor(tmp, { now });
    expect(res.warnings.find((w) => w.code === "low-evidence-confirmed")).toBeUndefined();
  });
});

describe("pinned-without-recent-evidence lint", () => {
  test("flags pinned pref with no evidence", () => {
    writePreference(tmp, {
      slug: "pinned-empty",
      topic: "pinned-empty",
      principle: "Pinned but never applied",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-30T00:00:00Z",
      status: "confirmed",
      confirmed_at: "2026-05-02T00:00:00Z",
      evidenced_by: [],
      applied_count: 0,
      last_evidence_at: null,
      pinned: true,
    });
    const res = runDoctor(tmp);
    const w = res.warnings.find((x) => x.code === "pinned-without-recent-evidence");
    expect(w).toBeDefined();
    expect(w!.message).toContain("pref-pinned-empty");
  });

  test("flags pinned pref with stale evidence past stale_evidence_days", () => {
    // Default config: stale_evidence_days=30.
    writePreference(tmp, {
      slug: "pinned-stale",
      topic: "pinned-stale",
      principle: "Pinned but stale",
      created_at: "2026-01-01T00:00:00Z",
      unconfirmed_until: "2026-01-15T00:00:00Z",
      status: "confirmed",
      confirmed_at: "2026-01-05T00:00:00Z",
      evidenced_by: [],
      applied_count: 5,
      last_evidence_at: "2026-01-10T00:00:00Z",
      pinned: true,
    });
    const now = new Date("2026-05-15T00:00:00Z"); // 125 days past last evidence
    const res = runDoctor(tmp, { now });
    expect(res.warnings.find((w) => w.code === "pinned-without-recent-evidence")).toBeDefined();
  });

  test("does NOT flag unpinned prefs", () => {
    writePreference(tmp, {
      slug: "unpinned-stale",
      topic: "unpinned-stale",
      principle: "Stale but not pinned",
      created_at: "2026-01-01T00:00:00Z",
      unconfirmed_until: "2026-01-15T00:00:00Z",
      status: "confirmed",
      confirmed_at: "2026-01-05T00:00:00Z",
      evidenced_by: [],
      applied_count: 5,
      last_evidence_at: "2026-01-10T00:00:00Z",
      pinned: false,
    });
    const now = new Date("2026-05-15T00:00:00Z");
    const res = runDoctor(tmp, { now });
    expect(res.warnings.find((w) => w.code === "pinned-without-recent-evidence")).toBeUndefined();
  });
});

describe("malformed-evidence-range lint", () => {
  test("flags an apply-evidence with reversed start-end", () => {
    // Hand-craft a log entry; we don't need a real pref file because
    // doctor's lint walks log entries directly.
    writeFileSync(
      logPath(tmp, "2026-05-14"),
      `---
kind: brain-log
date: 2026-05-14
tags: [brain, brain/log]
---

# Brain Log — 2026-05-14

## 10:00:00Z — apply-evidence

- preference: [[pref-foo]]
- artifact: [[file:120-100]]
- agent: claude
- result: applied
`,
      "utf8",
    );
    const res = runDoctor(tmp);
    const w = res.warnings.find((x) => x.code === "malformed-evidence-range");
    expect(w).toBeDefined();
    expect(w!.message).toContain("120-100");
  });

  test("does NOT flag well-formed ranges or bare wikilinks", () => {
    writeFileSync(
      logPath(tmp, "2026-05-14"),
      `---
kind: brain-log
date: 2026-05-14
tags: [brain, brain/log]
---

# Brain Log — 2026-05-14

## 10:00:00Z — apply-evidence

- preference: [[pref-foo]]
- artifact: [[file:120-145]]
- agent: claude
- result: applied

## 11:00:00Z — apply-evidence

- preference: [[pref-bar]]
- artifact: [[other]]
- agent: claude
- result: applied
`,
      "utf8",
    );
    const res = runDoctor(tmp);
    expect(res.warnings.find((w) => w.code === "malformed-evidence-range")).toBeUndefined();
  });
});

describe("orphan-evidence lint", () => {
  test("flags an apply-evidence whose artifact wikilink doesn't resolve", () => {
    writeFileSync(
      logPath(tmp, "2026-05-14"),
      `---
kind: brain-log
date: 2026-05-14
tags: [brain, brain/log]
---

# Brain Log — 2026-05-14

## 10:00:00Z — apply-evidence

- preference: [[pref-foo]]
- artifact: [[missing-vault-page]]
- agent: claude
- result: applied
`,
      "utf8",
    );
    const res = runDoctor(tmp);
    const w = res.warnings.find((x) => x.code === "orphan-evidence");
    expect(w).toBeDefined();
    expect(w!.message).toContain("missing-vault-page");
  });
});

describe("broken backlinks", () => {
  test("flags a wikilink target that no longer exists as a file", () => {
    // pref-alive references sig-missing, but no such signal file exists.
    writePreference(tmp, {
      slug: "alive",
      topic: "alive",
      principle: "Live rule",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-30T00:00:00Z",
      status: "unconfirmed",
      evidenced_by: ["[[sig-missing]]"],
    });

    const res = runDoctor(tmp);
    const broken = res.warnings.filter((w) => w.code === "broken-backlinks");
    expect(broken.length).toBeGreaterThan(0);
    const sigMissing = broken.find((w) => w.message.includes("[[sig-missing]]"));
    expect(sigMissing).toBeDefined();
    expect(sigMissing!.message).toContain("pref-alive");
  });

  test("does not flag references whose targets exist", () => {
    writeSignal(tmp, {
      topic: "real",
      signal: "negative",
      agent: "claude",
      principle: "test",
      created_at: "2026-05-01T10:00:00Z",
      date: "2026-05-01",
      slug: "present",
    });
    writePreference(tmp, {
      slug: "real",
      topic: "real",
      principle: "test",
      created_at: "2026-05-01T11:00:00Z",
      unconfirmed_until: "2026-05-30T00:00:00Z",
      status: "unconfirmed",
      evidenced_by: ["[[sig-2026-05-01-present]]"],
    });
    const res = runDoctor(tmp);
    expect(res.warnings.filter((w) => w.code === "broken-backlinks")).toHaveLength(0);
  });

  test("ignores wikilinks pointing outside the Brain namespace", () => {
    // Writing a preference whose principle mentions a Daily/-style
    // wikilink that doesn't match the pref-/ret-/sig- prefix policy.
    // The body wikilink resolves to a non-Brain id and we must NOT
    // flag it — Daily and AI Wiki references are user prose.
    writePreference(tmp, {
      slug: "with-prose",
      topic: "with-prose",
      principle: "Refer to [[Some Wiki Page]] for details",
      created_at: "2026-05-01T11:00:00Z",
      unconfirmed_until: "2026-05-30T00:00:00Z",
      status: "unconfirmed",
      evidenced_by: [],
    });
    const res = runDoctor(tmp);
    expect(res.warnings.filter((w) => w.code === "broken-backlinks")).toHaveLength(0);
  });
});

describe("vault-ignore-missing-path lint (v0.10.9)", () => {
  test("warns when vault.ignore_paths contains a path-style entry that does not exist", () => {
    atomicWriteFileSync(
      brainConfigPath(tmp),
      `schema_version: 1
vault:
  ignore_paths:
    - Brain/.snapshots
    - Notes/does-not-exist
`,
    );
    const res = runDoctor(tmp);
    const missing = res.warnings.find((w) => w.code === "vault-ignore-missing-path");
    expect(missing).toBeDefined();
    expect(missing!.message).toContain("Notes/does-not-exist");
    // Brain/.snapshots was created by the test scaffold — no warning
    // for that entry.
    expect(
      res.warnings
        .filter((w) => w.code === "vault-ignore-missing-path")
        .map((w) => w.message)
        .join("\n"),
    ).not.toContain("Brain/.snapshots");
  });

  test("does NOT warn about bare-name entries that have no current match", () => {
    atomicWriteFileSync(
      brainConfigPath(tmp),
      `schema_version: 1
vault:
  ignore_paths:
    - .git
    - node_modules
`,
    );
    const res = runDoctor(tmp);
    expect(res.warnings.find((w) => w.code === "vault-ignore-missing-path")).toBeUndefined();
  });

  test("does NOT warn when the vault block is absent (defaults source)", () => {
    atomicWriteFileSync(brainConfigPath(tmp), `schema_version: 1\n`);
    const res = runDoctor(tmp);
    expect(res.warnings.find((w) => w.code === "vault-ignore-missing-path")).toBeUndefined();
  });
});

describe("corrupted principle frontmatter", () => {
  test("a preference whose principle carries leaked tool-call fragments raises principle-corrupted", () => {
    const path = preferencePath(tmp, "leaky");
    writeFileSync(
      path,
      [
        "---",
        "kind: brain-preference",
        "id: pref-leaky",
        "created_at: 2026-05-14T10:42:00Z",
        "_confirmed_at: null",
        "unconfirmed_until: 2026-05-28T10:42:00Z",
        "tags: [brain, brain/preference]",
        "topic: leaky",
        'principle: "real rule.</principle>\\\\n<parameter name=\\\\\\"scope\\\\\\">writing"',
        "_status: unconfirmed",
        "_evidenced_by: []",
        "_applied_count: 0",
        "_violated_count: 0",
        "_last_evidence_at: null",
        "_confidence: low",
        "pinned: false",
        "---",
        "",
        "## Principle",
        "rule",
        "",
      ].join("\n"),
      "utf8",
    );
    const res = runDoctor(tmp);
    expect(res.errors).toEqual([]);
    expect(res.warnings.some((w) => w.code === "principle-corrupted" && w.path === path)).toBe(
      true,
    );
  });

  test("clean principles raise no principle-corrupted warning", () => {
    writePreference(tmp, {
      slug: "clean",
      topic: "clean",
      principle: 'Quote "plain text" freely.',
      created_at: "2026-05-14T10:00:00Z",
      unconfirmed_until: "2026-05-28T10:00:00Z",
      status: "unconfirmed",
      evidenced_by: [],
    });
    const res = runDoctor(tmp);
    expect(res.warnings.filter((w) => w.code === "principle-corrupted")).toEqual([]);
  });
});
