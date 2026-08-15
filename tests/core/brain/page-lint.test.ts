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
  lintPagesWithContext,
  lintWrittenPages,
  pageLintField,
  type LintContext,
} from "../../../src/core/brain/page-lint.ts";
import { LINT_CONSOLIDATE_KIND } from "../../../src/core/brain/lint-consolidate.ts";
import { loadSchemaPack } from "../../../src/core/brain/schema-pack.ts";
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

/**
 * The report crosses the MCP wire on all four write tools, so it obeys the
 * rule the rest of this release applies to that channel: identifiers and
 * integers, never a path and never a kernel sentence. Node renders an errno
 * as `ENOENT: no such file or directory, stat '/home/<user>/<vault>/x.md'`,
 * which is the operator's home directory in a write receipt.
 */
describe("lintWrittenPages - nothing of the operator's filesystem crosses the wire", () => {
  test("an unreadable page carries the errno CODE, not the kernel's sentence", () => {
    const report = lintWrittenPages(vault, ["Notes/NeverWritten.md"]);
    expect(report.skipped).toEqual([
      {
        page: "Notes/NeverWritten.md",
        reason: PAGE_LINT_SKIP_REASON.unreadable,
        detail: "ENOENT",
      },
    ]);
    expect(JSON.stringify(report)).not.toContain(vault);
  });

  test("a lint that cannot start names its errno code and no path", () => {
    mkdirSync(join(vault, "Brain", "_brain.yaml"), { recursive: true });
    const rel = writeNote("Notes/Any.md", "---\ntitle: A\n---\n\nx\n");
    const report = lintWrittenPages(vault, [rel]);
    expect(report.unavailable!.message).not.toContain(vault);
    expect(report.unavailable!.message).toMatch(/could not start: [A-Za-z][A-Za-z0-9_]*$/);
  });

  test("an over-cap skip is stated in bytes, which name nothing on disk", () => {
    const rel = writeNote("Notes/Huge.md", "x".repeat(ARTIFACT_MAX_BYTES + 8));
    const report = lintWrittenPages(vault, [rel]);
    expect(report.skipped[0]!.reason).toBe(PAGE_LINT_SKIP_REASON.overByteCap);
    expect(JSON.stringify(report)).not.toContain(vault);
  });
});

/**
 * A page the lint THREW on is one page's worth of bad news, not the whole
 * report's. The failure is accumulated per page so the findings already
 * collected survive and the pages after it are still linted - the report
 * already has an honest shape for saying part of it could not be produced.
 *
 * No filesystem state reaches this branch (every reader inside `lintOnePage`
 * either cannot throw or catches its own errors), so it is exercised through
 * the context seam with a resolver that throws.
 */
describe("lintPagesWithContext - one page's failure is not the report's", () => {
  function throwingContext(reason: Error): LintContext {
    return {
      basenames: new Set<string>(),
      vocabulary: loadSchemaPack(vault).vocabulary,
      mergedLinks: {
        resolve() {
          throw reason;
        },
      },
    };
  }

  test("the failing page is a skip and the pages around it still report", () => {
    const first = writeNote("Notes/First.md", "---\ntitle: F\n---\n\nsee [[pref-ghost]]\n");
    const second = writeNote("Notes/Second.md", "no frontmatter at all\n");
    const report = lintPagesWithContext(
      vault,
      throwingContext(Object.assign(new Error("read failed"), { code: "EIO" })),
      [first, second],
    );
    expect(report.skipped).toEqual([
      { page: first, reason: PAGE_LINT_SKIP_REASON.lintFailed, detail: "EIO" },
    ]);
    // The second page never reaches the resolver (it has no wikilink), so its
    // finding is the proof that the walk continued past the failure.
    expect(report.findings.map((f) => f.code)).toEqual(["frontmatter-missing"]);
    expect(report.total).toBe(1);
    expect(report.unavailable).toBeUndefined();
  });

  test("a failure carrying no errno is named by its class, never by its message", () => {
    const rel = writeNote("Notes/Third.md", "---\ntitle: T\n---\n\nsee [[pref-ghost]]\n");
    const report = lintPagesWithContext(vault, throwingContext(new TypeError("/home/x/vault/x")), [
      rel,
    ]);
    expect(report.skipped).toEqual([
      { page: rel, reason: PAGE_LINT_SKIP_REASON.lintFailed, detail: "TypeError" },
    ]);
    expect(JSON.stringify(report)).not.toContain("/home/x/vault");
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
