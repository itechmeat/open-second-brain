/**
 * Per-page write-time lint (evidence-at-the-boundary, task A4).
 *
 * The vault-wide pass is 359 ms and cannot run per write, so this module
 * re-uses the detectors that already exist against exactly the pages one
 * write touched. These tests pin the properties the envelope promises:
 * a clean page contributes NO key at all, a truncated list declares its
 * truncation, an over-cap page is skipped rather than dropped, and a
 * failure of the lint itself is a named `unavailable` rather than an
 * absence that would read as clean.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PAGE_LINT_KEY,
  PAGE_LINT_MAX_FINDINGS,
  PAGE_LINT_SKIP_REASON,
  PAGE_LINT_UNAVAILABLE_CODE,
  comparePageLintFindings,
  lintWrittenPages,
  pageLintField,
} from "../../../src/core/brain/page-lint.ts";
import { LINT_CONSOLIDATE_KIND } from "../../../src/core/brain/lint-consolidate.ts";
import { ARTIFACT_MAX_BYTES } from "../../../src/core/brain/write-session/validate.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-page-lint-"));
  for (const dir of ["preferences", "retired", "log", "inbox"]) {
    mkdirSync(join(vault, "Brain", dir), { recursive: true });
  }
  mkdirSync(join(vault, "Notes"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writeNote(rel: string, text: string): string {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, text, "utf8");
  return rel;
}

function writePref(slug: string, fields: Record<string, string> = {}): void {
  const lines = ["---", `id: pref-${slug}`, "topic: x", "principle: y"];
  for (const [k, v] of Object.entries(fields)) lines.push(`${k}: ${v}`);
  lines.push("---", "");
  writeFileSync(join(vault, "Brain", "preferences", `pref-${slug}.md`), lines.join("\n"), "utf8");
}

describe("lintWrittenPages - the clean path", () => {
  test("a valid page with no broken links yields nothing to say", () => {
    const rel = writeNote("Notes/Clean.md", "---\ntitle: Clean\n---\n\nplain prose\n");
    const report = lintWrittenPages(vault, [rel]);
    expect(report.findings).toEqual([]);
    expect(report.total).toBe(0);
    expect(report.returned).toBe(0);
    expect(report.truncated).toBe(false);
    expect(report.skipped).toEqual([]);
    expect(report.unavailable).toBeUndefined();
    expect(pageLintField(report)).toEqual({});
  });

  test("a wikilink to a non-Brain note is nobody's business here", () => {
    writeNote("Notes/Other.md", "---\ntitle: Other\n---\n\nx\n");
    const rel = writeNote("Notes/Links.md", "---\ntitle: Links\n---\n\nsee [[Other]]\n");
    expect(lintWrittenPages(vault, [rel]).findings).toEqual([]);
  });
});

describe("lintWrittenPages - findings", () => {
  test("a broken Brain wikilink is one warning carrying a next command", () => {
    const rel = writeNote("Notes/Broken.md", "---\ntitle: B\n---\n\nsee [[pref-ghost]]\n");
    const report = lintWrittenPages(vault, [rel]);
    expect(report.findings.length).toBe(1);
    expect(report.findings[0]).toMatchObject({
      severity: "warning",
      code: "broken-wikilink",
      page: rel,
      path: "pref-ghost",
      next_command: "o2b brain doctor --repair --apply",
    });
    expect(report.total).toBe(1);
    expect(report.returned).toBe(1);
    expect(report.truncated).toBe(false);
  });

  test("a link to a merged page names the FULLY resolved canonical target", () => {
    writePref("canon");
    writePref("mid", { merged_into: "pref-canon" });
    writePref("dup", { merged_into: "pref-mid" });
    const rel = writeNote("Notes/Merged.md", "---\ntitle: M\n---\n\nsee [[pref-dup]]\n");
    const report = lintWrittenPages(vault, [rel]);
    expect(report.findings.length).toBe(1);
    expect(report.findings[0]).toMatchObject({
      severity: "warning",
      code: LINT_CONSOLIDATE_KIND.mergedLink,
      page: rel,
      path: "pref-dup",
    });
    expect(report.findings[0]!.message).toContain("pref-canon");
    expect(report.findings[0]!.next_command).toBe("o2b brain lint --consolidate --apply --yes");
  });

  test("an invalid document reports error findings, ranked ahead of warnings", () => {
    const rel = writeNote("Notes/Invalid.md", "no frontmatter at all, see [[pref-ghost]]\n");
    const report = lintWrittenPages(vault, [rel]);
    expect(report.findings.length).toBeGreaterThanOrEqual(2);
    expect(report.findings[0]!.severity).toBe("error");
    expect(report.findings[0]!.code).toBe("frontmatter-missing");
    expect(report.findings.at(-1)!.severity).toBe("warning");
    expect(pageLintField(report)).toMatchObject({ [PAGE_LINT_KEY]: { total: report.total } });
  });

  test("a declared type outside the schema pack is an error finding", () => {
    const rel = writeNote("Notes/Typed.md", "---\ntitle: T\ntype: not-a-declared-type\n---\n\nx\n");
    const codes = lintWrittenPages(vault, [rel]).findings.map((f) => f.code);
    expect(codes).toContain("schema-type-unknown");
  });
});

describe("lintWrittenPages - bounds", () => {
  test("a page over the artifact byte cap is skipped with a reason, never dropped", () => {
    const filler = "x".repeat(ARTIFACT_MAX_BYTES + 1024);
    const rel = writeNote("Notes/Huge.md", `---\ntitle: H\n---\n\n${filler}\n`);
    const report = lintWrittenPages(vault, [rel]);
    expect(report.findings).toEqual([]);
    expect(report.skipped).toEqual([
      { page: rel, reason: PAGE_LINT_SKIP_REASON.overByteCap, detail: expect.any(String) },
    ]);
    expect(pageLintField(report)).toMatchObject({ [PAGE_LINT_KEY]: { skipped: report.skipped } });
  });

  test("a truncated finding list declares total, returned and truncated", () => {
    const links = Array.from(
      { length: PAGE_LINT_MAX_FINDINGS + 5 },
      (_, i) => `see [[pref-ghost-${i}]]`,
    ).join("\n");
    const rel = writeNote("Notes/Many.md", `---\ntitle: M\n---\n\n${links}\n`);
    const report = lintWrittenPages(vault, [rel]);
    expect(report.total).toBe(PAGE_LINT_MAX_FINDINGS + 5);
    expect(report.returned).toBe(PAGE_LINT_MAX_FINDINGS);
    expect(report.findings.length).toBe(PAGE_LINT_MAX_FINDINGS);
    expect(report.truncated).toBe(true);
  });

  test("an unreadable page is skipped with its own reason", () => {
    const report = lintWrittenPages(vault, ["Notes/NeverWritten.md"]);
    expect(report.findings).toEqual([]);
    expect(report.skipped.map((s) => s.reason)).toEqual([PAGE_LINT_SKIP_REASON.unreadable]);
  });
});

describe("lintWrittenPages - failure is named, never absent", () => {
  test("a lint that cannot run reports unavailable rather than a missing key", () => {
    // `Brain/_brain.yaml` as a directory: the schema pack read throws
    // EISDIR, which is a failure of the LINT, not of the page.
    mkdirSync(join(vault, "Brain", "_brain.yaml"), { recursive: true });
    const rel = writeNote("Notes/Any.md", "---\ntitle: A\n---\n\nx\n");
    const report = lintWrittenPages(vault, [rel]);
    expect(report.unavailable).toMatchObject({ code: PAGE_LINT_UNAVAILABLE_CODE });
    expect(report.unavailable!.message.length).toBeGreaterThan(0);
    expect(report.total).toBe(0);
    expect(report.returned).toBe(0);
    expect(report.truncated).toBe(false);
    expect(report.skipped).toEqual([]);
    // The whole point: the key is PRESENT, so absence still means clean.
    expect(pageLintField(report)).toMatchObject({
      [PAGE_LINT_KEY]: { unavailable: report.unavailable },
    });
  });
});

describe("comparePageLintFindings", () => {
  test("errors sort ahead of warnings, then by page, then by code", () => {
    const warning = {
      severity: "warning",
      code: "broken-wikilink",
      page: "a.md",
      path: "pref-x",
      message: "m",
    } as const;
    const error = {
      severity: "error",
      code: "tags-malformed",
      page: "z.md",
      path: "tags",
      message: "m",
    } as const;
    expect(comparePageLintFindings(warning, error)).toBeGreaterThan(0);
    expect(comparePageLintFindings(error, warning)).toBeLessThan(0);
    expect(comparePageLintFindings(error, error)).toBe(0);
  });
});

describe("pageLintField", () => {
  test("null contributes no key whatsoever", () => {
    expect(pageLintField(null)).toEqual({});
    expect(PAGE_LINT_KEY in pageLintField(null)).toBe(false);
  });
});
