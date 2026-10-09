/**
 * Tags hygiene detector (search/diagnostics/vault-hygiene wave; kanban
 * t_c8508241).
 *
 * Three informational finding classes over inline body tags, all riding
 * the ONE shared tag rule (`src/core/tags.ts`): malformed - body `#...`
 * tokens the looser Obsidian-compatible rule accepts but the index tag
 * rule rejects (reported as the diff: the index will never match them);
 * inconsistent - the same tag differing by case or hierarchy depth;
 * orphan - a tag value on exactly one document. Frontmatter `tags:`
 * arrays are OUT of scope here (recorded refusal) - the trust-surface-
 * hardening wave gives them their own opt-in `frontmatter-tags`
 * detector - and this detector is opt-in too: registered but excluded
 * from `DEFAULT_SCAN_IDS`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { runHygieneScan } from "../../../src/core/brain/hygiene/scan.ts";
import { HYGIENE_DETECTOR_IDS } from "../../../src/core/brain/hygiene/types.ts";
import type { HygieneFinding } from "../../../src/core/brain/hygiene/types.ts";
import { hygieneFindingId } from "../../../src/core/brain/hygiene/detectors/id.ts";
import { detectTags } from "../../../src/core/brain/hygiene/detectors/tags.ts";
import { TAG_RE, extractTagValues, stripCode } from "../../../src/core/tags.ts";
import { extractLinks } from "../../../src/core/search/links.ts";

let vault: string;

const NOW = new Date("2026-06-10T12:00:00Z");

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-hygiene-tags-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writeNote(rel: string, body: string, frontmatter?: string): void {
  const abs = join(vault, rel);
  mkdirSync(dirname(abs), { recursive: true });
  const head = frontmatter === undefined ? "" : `---\n${frontmatter}\n---\n\n`;
  writeFileSync(abs, `${head}${body}\n`, "utf8");
}

function tagsFindings(): HygieneFinding[] {
  return [...detectTags(vault)];
}

function byClass(findings: ReadonlyArray<HygieneFinding>, klass: string): HygieneFinding[] {
  return findings.filter((f) => f.evidence.class === klass);
}

describe("tags detector - malformed", () => {
  test("reports a body tag the looser Obsidian rule accepts but the index rule rejects", () => {
    writeNote("Brain/notes/a.md", "#shared start");
    writeNote("Brain/notes/b.md", "#shared and #2024notes here");
    const malformed = byClass(tagsFindings(), "malformed");
    expect(malformed).toHaveLength(1);
    const finding = malformed[0]!;
    expect(finding.detector).toBe("tags");
    expect(finding.severity).toBe("info");
    expect(finding.proposed_action).toBe("review");
    expect(finding.evidence.tag).toBe("#2024notes");
    expect(typeof finding.evidence.reason).toBe("string");
    expect(finding.targets).toEqual(["Brain/notes/b.md", "#2024notes"]);
    expect(finding.title).toBe("Malformed tag: the index will never match #2024notes");
  });

  test("the reported token is genuinely absent from the index extraction (the diff)", () => {
    const body = "#shared and #2024notes here";
    const values = extractLinks(body)
      .filter((l) => l.linkType === "tag")
      .map((l) => l.linkText);
    expect(values).toContain("shared");
    expect(values).not.toContain("2024notes");
  });

  test("tokens both rules reject (pure numeric) are not reported", () => {
    writeNote("Brain/notes/a.md", "#1234 ref");
    expect(tagsFindings()).toHaveLength(0);
  });

  test("slash-onset tokens are no tag in either rule and are not reported", () => {
    writeNote("Brain/notes/a.md", "#/x reference");
    expect(tagsFindings()).toHaveLength(0);
  });

  test("the same malformed token across documents is one finding; distinct tokens stay distinct", () => {
    writeNote("Brain/notes/a.md", "#2024notes one");
    writeNote("Brain/notes/b.md", "#2024notes two");
    writeNote("Brain/notes/c.md", "#3d-print two");
    const malformed = byClass(tagsFindings(), "malformed");
    expect(malformed).toHaveLength(2);
    const grouped = malformed.find((f) => f.evidence.tag === "#2024notes");
    expect(grouped!.targets).toEqual(["Brain/notes/a.md", "Brain/notes/b.md", "#2024notes"]);
  });

  test("code fences and inline code spans are never audited", () => {
    writeNote("Brain/notes/a.md", "```\n#2024infence\n```\n\nInline `#2024inline` stays out too.");
    expect(tagsFindings()).toHaveLength(0);
  });

  test("frontmatter content is out of scope, including a malformed-looking token", () => {
    writeNote("Brain/notes/a.md", "clean body", 'tags: ["#2024fm"]\nid: x');
    expect(tagsFindings()).toHaveLength(0);
  });
});

describe("tags detector - inconsistent", () => {
  test("case variants across documents are one inconsistent finding", () => {
    writeNote("Brain/notes/a.md", "#Foo");
    writeNote("Brain/notes/b.md", "#foo");
    const findings = tagsFindings();
    const inconsistent = byClass(findings, "inconsistent");
    expect(findings).toHaveLength(1);
    expect(inconsistent[0]!.evidence.variants).toEqual(["#Foo", "#foo"]);
    expect(inconsistent[0]!.evidence.key).toBe("#foo");
    expect(inconsistent[0]!.targets).toEqual(["Brain/notes/a.md", "Brain/notes/b.md", "#foo"]);
    expect(inconsistent[0]!.title).toBe("Inconsistent tag spellings: #Foo vs #foo");
    expect(inconsistent[0]!.severity).toBe("info");
    expect(inconsistent[0]!.proposed_action).toBe("review");
  });

  test("hierarchy-depth variants are one inconsistent finding", () => {
    writeNote("Brain/notes/a.md", "#a/b");
    writeNote("Brain/notes/b.md", "#a");
    const inconsistent = byClass(tagsFindings(), "inconsistent");
    expect(inconsistent).toHaveLength(1);
    expect(inconsistent[0]!.evidence.variants).toEqual(["#a", "#a/b"]);
    expect(inconsistent[0]!.evidence.key).toBe("#a");
  });

  test("deep chains collapse into one family; unrelated tags do not join", () => {
    writeNote("Brain/notes/a.md", "#x");
    writeNote("Brain/notes/b.md", "#x/y");
    writeNote("Brain/notes/c.md", "#x/y/z");
    writeNote("Brain/notes/d.md", "#unrelated");
    const findings = tagsFindings();
    const inconsistent = byClass(findings, "inconsistent");
    expect(inconsistent).toHaveLength(1);
    expect(inconsistent[0]!.evidence.variants).toEqual(["#x", "#x/y", "#x/y/z"]);
    // #unrelated is on exactly one document - the orphan class owns it.
    const orphans = byClass(findings, "orphan");
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.evidence.tag).toBe("#unrelated");
  });

  test("one spelling on one document is not inconsistent", () => {
    writeNote("Brain/notes/a.md", "#consistent");
    writeNote("Brain/notes/b.md", "#consistent");
    expect(byClass(tagsFindings(), "inconsistent")).toHaveLength(0);
  });
});

describe("tags detector - orphan", () => {
  test("a tag on exactly one document is orphan", () => {
    writeNote("Brain/notes/a.md", "#lonely");
    const orphans = byClass(tagsFindings(), "orphan");
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.evidence.tag).toBe("#lonely");
    expect(orphans[0]!.targets).toEqual(["Brain/notes/a.md", "#lonely"]);
    expect(orphans[0]!.title).toBe("Orphan tag #lonely appears on only one document");
    expect(orphans[0]!.severity).toBe("info");
    expect(orphans[0]!.proposed_action).toBe("review");
  });

  test("a tag shared across documents is not orphan", () => {
    writeNote("Brain/notes/a.md", "#shared");
    writeNote("Brain/notes/b.md", "#shared");
    expect(tagsFindings()).toHaveLength(0);
  });

  test("frontmatter tags arrays are not audited for orphanhood", () => {
    writeNote("Brain/notes/a.md", "no body tags", "tags: [fm-only]");
    expect(tagsFindings()).toHaveLength(0);
  });

  test("case-sharing counts as sharing: a lone #Foo next to #foo elsewhere is not orphan", () => {
    writeNote("Brain/notes/a.md", "#Foo");
    writeNote("Brain/notes/b.md", "#foo");
    const orphans = byClass(tagsFindings(), "orphan");
    expect(orphans).toHaveLength(0);
  });

  test("inconsistent family members are not separately reported as orphans", () => {
    writeNote("Brain/notes/a.md", "#Foo");
    writeNote("Brain/notes/b.md", "#foo");
    writeNote("Brain/notes/c.md", "#solo");
    const findings = tagsFindings();
    expect(findings).toHaveLength(2);
    expect(byClass(findings, "inconsistent")).toHaveLength(1);
    const orphans = byClass(findings, "orphan");
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.evidence.tag).toBe("#solo");
  });
});

describe("tags detector - finding ids", () => {
  test("ids are stable across runs and derived from the targets", () => {
    writeNote("Brain/notes/a.md", "#shared start");
    writeNote("Brain/notes/b.md", "#shared and #2024notes here");
    const first = tagsFindings();
    const second = tagsFindings();
    expect(first.map((f) => f.id)).toEqual(second.map((f) => f.id));
    for (const finding of first) {
      expect(finding.id).toBe(hygieneFindingId("tags", finding.targets));
    }
  });
});

describe("tags detector - empty vault", () => {
  test("reports nothing", () => {
    expect(tagsFindings()).toHaveLength(0);
  });
});

describe("the one shared tag rule", () => {
  test("TAG_RE keeps the incumbent pattern exactly (never widened)", () => {
    expect(TAG_RE.source).toBe("(^|[^\\w/])#([A-Za-z_][\\w\\-/]*)");
    expect(TAG_RE.flags).toContain("g");
  });

  test("the shared extraction matches the index behavior the links tests pin", () => {
    expect(extractTagValues("#foo word#nope #a/b")).toEqual(["foo", "a/b"]);
    expect(extractTagValues(stripCode("```\n#infence\n```\n\n#out"))).toEqual(["out"]);
    expect(extractTagValues(stripCode("inline `#coded` and #real"))).toEqual(["real"]);
  });
});

describe("tags scan integration", () => {
  test("the detector id is registered in the closed tuple", () => {
    expect(HYGIENE_DETECTOR_IDS).toContain("tags");
  });

  test("the frontmatter sibling is registered in the closed tuple (t_11ee559f)", () => {
    expect(HYGIENE_DETECTOR_IDS).toContain("frontmatter-tags");
  });

  test("the default sweep excludes tags (opt-in only)", () => {
    writeNote("Brain/notes/a.md", "#2024notes malformed");
    const report = runHygieneScan(vault, { now: NOW });
    expect(report.detectors_run).not.toContain("tags");
    expect(report.counts.tags).toBeUndefined();
    expect(report.findings.find((f) => f.detector === "tags")).toBeUndefined();
  });

  test("the default sweep excludes the frontmatter sibling too (t_11ee559f)", () => {
    writeNote("Brain/notes/fm.md", "body", "tags: [bad tag]");
    const report = runHygieneScan(vault, { now: NOW });
    expect(report.detectors_run).not.toContain("frontmatter-tags");
    expect(report.counts["frontmatter-tags"]).toBeUndefined();
    expect(report.findings.find((f) => f.detector === "frontmatter-tags")).toBeUndefined();
  });

  test("an explicit subset runs tags alone", () => {
    writeNote("Brain/notes/a.md", "#2024notes malformed");
    const report = runHygieneScan(vault, { detectors: ["tags"], now: NOW });
    expect(report.detectors_run).toEqual(["tags"]);
    expect(report.counts.tags).toBe(1);
    expect(report.errors).toHaveLength(0);
  });
});
