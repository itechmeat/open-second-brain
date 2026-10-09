/**
 * Frontmatter-tags hygiene detector (trust-surface-hardening wave;
 * kanban t_11ee559f, doctor half).
 *
 * The doctor-half companion to the write-time tag validation: existing
 * vault content cannot be retroactively refused at a composer, so this
 * detector audits the frontmatter `tags:` field - the one place the
 * inline-tags detector explicitly scopes OUT - against the ONE shared
 * tag rule (`src/core/tags.ts`, `isObsidianTagValue`). Findings are
 * informational, review-actioned, and never auto-fixed. The detector is
 * opt-in: registered but excluded from `DEFAULT_SCAN_IDS`, exactly like
 * the inline `tags` detector.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { isObsidianTagValue } from "../../../src/core/tags.ts";
import { runHygieneScan } from "../../../src/core/brain/hygiene/scan.ts";
import { hygieneFindingId } from "../../../src/core/brain/hygiene/detectors/id.ts";
import {
  MALFORMED_REASON,
  detectFrontmatterTags,
} from "../../../src/core/brain/hygiene/detectors/frontmatter-tags.ts";
import type { HygieneFinding } from "../../../src/core/brain/hygiene/types.ts";

let vault: string;

const NOW = new Date("2026-06-10T12:00:00Z");

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-hygiene-fm-tags-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writeNote(rel: string, frontmatter: string, body = "clean body"): void {
  const abs = join(vault, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `---\n${frontmatter}\n---\n\n${body}\n`, "utf8");
}

function findings(): HygieneFinding[] {
  return [...detectFrontmatterTags(vault)];
}

/** Recursive [relative path -> bytes] snapshot, for the read-only pin. */
function treeSnapshot(dir: string, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const rel = prefix === "" ? entry : `${prefix}/${entry}`;
    if (statSync(abs).isDirectory()) {
      for (const [k, v] of treeSnapshot(abs, rel)) out.set(k, v);
    } else {
      out.set(rel, readFileSync(abs, "utf8"));
    }
  }
  return out;
}

describe("frontmatter-tags detector - malformed values", () => {
  test("a frontmatter tags entry the shared rule rejects produces a finding naming the value and the rule", () => {
    writeNote("Brain/notes/a.md", 'tags: [brain, "foo bar"]');
    const malformed = findings();
    expect(malformed).toHaveLength(1);
    const finding = malformed[0]!;
    expect(finding.detector).toBe("frontmatter-tags");
    expect(finding.severity).toBe("info");
    expect(finding.proposed_action).toBe("review");
    expect(finding.evidence.tag).toBe("foo bar");
    expect(finding.evidence.field).toBe("tags");
    // Acceptance C2(a): the finding's evidence names BOTH the offending
    // value and the rule - a reason that said only "check this" would not
    // be reviewable without re-deriving why the value is malformed.
    expect(finding.evidence.reason).toBe(`"foo bar" ${MALFORMED_REASON}`);
    expect(finding.evidence.reason).toContain("foo bar");
    expect(finding.evidence.reason).toContain("must start with a letter or underscore");
    expect(finding.evidence.reason).toContain("never only digits");
    expect(finding.targets).toEqual(["Brain/notes/a.md", "foo bar"]);
    expect(finding.title).toContain("foo bar");
    expect(finding.id).toBe(hygieneFindingId("frontmatter-tags", finding.targets));
  });

  test("a purely numeric or slash-onset entry is malformed too", () => {
    writeNote("Brain/notes/a.md", "tags: [2024, /leading, ok-tag]");
    const values = findings()
      .map((f) => f.evidence.tag)
      .toSorted();
    expect(values).toEqual(["/leading", "2024"]);
  });

  test("the block-sequence form of the field is audited like the inline form", () => {
    writeNote("Brain/notes/a.md", "kind: note\ntags:\n  - brain\n  - bad tag");
    const malformed = findings();
    expect(malformed).toHaveLength(1);
    expect(malformed[0]!.evidence.tag).toBe("bad tag");
  });

  test("a scalar tags value is audited as the one-element list it parses to", () => {
    writeNote("Brain/notes/a.md", "tags: also bad");
    expect(findings().map((f) => f.evidence.tag)).toEqual(["also bad"]);
  });

  test("the same malformed value across documents is one finding; distinct values stay distinct", () => {
    writeNote("Brain/notes/a.md", "tags: [shared bad]");
    writeNote("Brain/notes/b.md", "tags: [shared bad]");
    writeNote("Brain/notes/c.md", "tags: [other bad]");
    const malformed = findings();
    expect(malformed).toHaveLength(2);
    const grouped = malformed.find((f) => f.evidence.tag === "shared bad");
    expect(grouped!.targets).toEqual(["Brain/notes/a.md", "Brain/notes/b.md", "shared bad"]);
  });

  test("empty entries are not values and are not reported", () => {
    writeNote("Brain/notes/a.md", "tags: [brain, , /bad]");
    const malformed = findings();
    expect(malformed).toHaveLength(1);
    expect(malformed[0]!.evidence.tag).toBe("/bad");
  });

  test("findings are stable across runs and sorted by value", () => {
    writeNote("Brain/notes/a.md", "tags: [zz bad, aa bad]");
    const first = findings();
    const second = findings();
    expect(first.map((f) => f.id)).toEqual(second.map((f) => f.id));
    expect(first.map((f) => f.evidence.tag)).toEqual(["aa bad", "zz bad"]);
  });
});

describe("frontmatter-tags detector - parse-shaped tags", () => {
  test("nested, underscore-onset, and dashed values produce nothing", () => {
    writeNote("Brain/notes/a.md", "tags: [brain, brain/preference, _under, Foo_1-b/c]");
    expect(findings()).toHaveLength(0);
  });

  test("a note without a tags field produces nothing", () => {
    writeNote("Brain/notes/a.md", "kind: note");
    expect(findings()).toHaveLength(0);
  });

  test("body hash-like tokens are out of scope (the inline detector owns prose)", () => {
    writeNote("Brain/notes/a.md", "kind: note", "body with #2024notes and #ok-tag");
    expect(findings()).toHaveLength(0);
  });

  test("an empty vault produces nothing", () => {
    expect(findings()).toHaveLength(0);
  });
});

describe("frontmatter-tags detector - read-only and shared rule", () => {
  test("the detector never mutates the vault", () => {
    writeNote("Brain/notes/a.md", "tags: [bad tag, ok]");
    const before = treeSnapshot(vault);
    findings();
    runHygieneScan(vault, { detectors: ["frontmatter-tags"], now: NOW });
    expect(treeSnapshot(vault)).toEqual(before);
  });

  test("the detector consumes the ONE shared predicate, never a local copy", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../../src/core/brain/hygiene/detectors/frontmatter-tags.ts"),
      "utf8",
    );
    expect(source).toMatch(/from "\.\.\/\.\.\/\.\.\/tags\.ts"/);
    expect(source).toContain("isObsidianTagValue");
    // A local redefinition would need a regex construction or the rule's
    // own onset charset; neither may appear in the detector.
    expect(source).not.toContain("new RegExp");
    expect(source).not.toContain("[A-Za-z_]");
    // Behavioral agreement: every value this suite saw judged malformed
    // is one the shared predicate rejects, and vice versa.
    const malformedSeen = ["foo bar", "2024", "/leading"];
    const parseShapedSeen = ["brain", "brain/preference", "_under"];
    for (const value of malformedSeen) expect(isObsidianTagValue(value)).toBe(false);
    for (const value of parseShapedSeen) expect(isObsidianTagValue(value)).toBe(true);
  });
});

describe("frontmatter-tags scan integration", () => {
  test("the default sweep skips the detector (opt-in like tags)", () => {
    writeNote("Brain/notes/a.md", "tags: [bad tag]");
    const report = runHygieneScan(vault, { now: NOW });
    expect(report.detectors_run).not.toContain("frontmatter-tags");
    expect(report.counts["frontmatter-tags"]).toBeUndefined();
    expect(report.findings.find((f) => f.detector === "frontmatter-tags")).toBeUndefined();
  });

  test("an explicit subset runs the detector alone", () => {
    writeNote("Brain/notes/a.md", "tags: [bad tag]");
    const report = runHygieneScan(vault, { detectors: ["frontmatter-tags"], now: NOW });
    expect(report.detectors_run).toEqual(["frontmatter-tags"]);
    expect(report.counts["frontmatter-tags"]).toBe(1);
    expect(report.errors).toHaveLength(0);
  });
});
