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
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  NEAR_DUPLICATE_CODE,
  NEAR_DUPLICATE_JACCARD,
  NEAR_DUPLICATE_MAX_CANDIDATES,
  PAGE_LINT_KEY,
  PAGE_LINT_MAX_FINDINGS,
  PAGE_LINT_SKIP_REASON,
  PAGE_LINT_UNAVAILABLE_CODE,
  comparePageLintFindings,
  lintPagesWithContext,
  lintWrittenPages,
  pageLintField,
  type LintContext,
  type NearDuplicateCandidate,
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

/** The report's near-duplicate findings, filtered by the one detector code. */
function nearDuplicateFindings(report: ReturnType<typeof lintWrittenPages>) {
  return report.findings.filter((f) => f.code === NEAR_DUPLICATE_CODE);
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
      nearDuplicateCandidates: new Map<string, ReadonlyArray<NearDuplicateCandidate>>(),
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

/**
 * The near-duplicate detector (t_d30c0548). A write that closely matches an
 * existing page in the SAME directory and the SAME composite scope bucket is
 * reported on the receipt as a `near-duplicate` finding - never gating the
 * write, never touching frontmatter, and never normalizing the body. The
 * comparison reuses the shared `tokenise`/`jaccard` primitives against the
 * named NEAR_DUPLICATE_JACCARD constant.
 */
describe("lintWrittenPages - near-duplicate findings", () => {
  const ALPHA_BODY = "alpha beta gamma delta epsilon";

  function alphaNote(title: string, frontmatterLines: string[] = []): string {
    const lines = ["---", `title: ${title}`, ...frontmatterLines, "---", "", ALPHA_BODY, ""];
    return lines.join("\n");
  }

  test("NEAR_DUPLICATE_JACCARD is the designed threshold, a named constant", () => {
    expect(NEAR_DUPLICATE_JACCARD).toBe(0.8);
  });

  test("a write closely matching a same-directory same-scope page yields the finding", () => {
    const first = writeNote("Notes/Alpha.md", alphaNote("Alpha"));
    const rel = writeNote("Notes/Beta.md", alphaNote("Beta"));
    const report = lintWrittenPages(vault, [rel]);
    const findings = nearDuplicateFindings(report);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: "warning",
      page: rel,
      path: first,
    });
    // Evidence is in the message: the pair and the exact score.
    expect(findings[0]!.message).toContain(first);
    expect(findings[0]!.message).toContain("jaccard=1.000");
    // An advisory with a content-judgement repair carries no registered exit.
    expect(findings[0]!.next_command).toBeUndefined();
  });

  test("a resemblance at exactly the threshold is reported, carrying its score", () => {
    // 4 shared tokens over a 5-token union is exactly 4/5 = 0.8.
    writeNote("Notes/Alpha.md", `---\ntitle: Alpha\n---\n\n${ALPHA_BODY}\n`);
    const rel = writeNote("Notes/Beta.md", "---\ntitle: Beta\n---\n\nalpha beta gamma delta\n");
    const report = lintWrittenPages(vault, [rel]);
    const findings = nearDuplicateFindings(report);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain("jaccard=0.800");
  });

  test("a below-threshold resemblance yields nothing", () => {
    writeNote("Notes/Alpha.md", alphaNote("Alpha"));
    const rel = writeNote("Notes/Beta.md", "---\ntitle: Beta\n---\n\nalpha zeta eta theta iota\n");
    const report = lintWrittenPages(vault, [rel]);
    expect(report.findings).toEqual([]);
    expect(pageLintField(report)).toEqual({});
  });

  test("a same-body page in a different directory is not a candidate", () => {
    writeNote("Elsewhere/Alpha.md", alphaNote("Alpha"));
    const rel = writeNote("Notes/Beta.md", alphaNote("Beta"));
    const report = lintWrittenPages(vault, [rel]);
    expect(report.findings).toEqual([]);
  });

  test("a same-body page in a different scope bucket is not a candidate", () => {
    writeNote("Notes/Alpha.md", alphaNote("Alpha", ["session: atlas"]));
    const rel = writeNote("Notes/Beta.md", alphaNote("Beta"));
    const report = lintWrittenPages(vault, [rel]);
    expect(report.findings).toEqual([]);
  });

  test("a same-body page in the SAME scope bucket is a candidate", () => {
    writeNote("Notes/Alpha.md", alphaNote("Alpha", ["session: atlas"]));
    const rel = writeNote("Notes/Beta.md", alphaNote("Beta", ["session: atlas"]));
    const report = lintWrittenPages(vault, [rel]);
    expect(nearDuplicateFindings(report)).toHaveLength(1);
  });

  test("frontmatter is never compared: differing frontmatter does not suppress the finding", () => {
    // Same authored body, different non-scope frontmatter. (`owner` would
    // be a REAL difference - it is a scope axis - so it must not appear here.)
    writeNote("Notes/Alpha.md", `---\ntitle: Alpha\ntype: note\n---\n\n${ALPHA_BODY}\n`);
    const rel = writeNote("Notes/Beta.md", alphaNote("Beta"));
    const report = lintWrittenPages(vault, [rel]);
    expect(nearDuplicateFindings(report)).toHaveLength(1);
  });

  test("frontmatter is never compared: identical frontmatter alone creates no finding", () => {
    writeNote("Notes/Alpha.md", "---\ntitle: Same\ntype: note\n---\n\none kind of prose\n");
    const rel = writeNote(
      "Notes/Beta.md",
      "---\ntitle: Same\ntype: note\n---\n\nanother kind entirely\n",
    );
    const report = lintWrittenPages(vault, [rel]);
    expect(report.findings).toEqual([]);
  });

  test("a directory over the candidate cap reads only the newest siblings and counts the rest", () => {
    const extra = 3;
    const oldest = Date.parse("2026-01-01T00:00:00Z");
    for (let i = 0; i < NEAR_DUPLICATE_MAX_CANDIDATES + extra; i++) {
      const rel = writeNote(`Notes/Filler-${i}.md`, `---\ntitle: F${i}\n---\n\nfiller ${i}\n`);
      const at = new Date(oldest + i * 1000);
      utimesSync(join(vault, rel), at, at);
    }
    const rel = writeNote("Notes/Beta.md", alphaNote("Beta"));
    const report = lintWrittenPages(vault, [rel]);
    // The written page is the newest sibling, so the cap leaves out the oldest fillers.
    expect(report.candidates_skipped).toBe(extra + 1);
    expect(pageLintField(report)).toHaveProperty("lint");
  });

  test("the written page never resembles itself", () => {
    const rel = writeNote("Notes/Alpha.md", alphaNote("Alpha"));
    const report = lintWrittenPages(vault, [rel]);
    expect(report.findings).toEqual([]);
  });

  test("two near-identical pages written in one call report each other", () => {
    const first = writeNote("Notes/Alpha.md", alphaNote("Alpha"));
    const second = writeNote("Notes/Beta.md", alphaNote("Beta"));
    const report = lintWrittenPages(vault, [first, second]);
    const pairs = nearDuplicateFindings(report)
      .map((f) => `${f.page} -> ${f.path}`)
      .toSorted();
    expect(pairs).toEqual([`${first} -> ${second}`, `${second} -> ${first}`]);
  });

  test("a candidate that cannot be read is excluded by name, not a lint failure", () => {
    // A DIRECTORY named like a page: reading it throws EISDIR. It cannot
    // provide evidence, so it is not a candidate - the same posture the
    // write-conflict advisory takes toward corrupt preference files.
    mkdirSync(join(vault, "Notes", "Stuck.md"), { recursive: true });
    const rel = writeNote("Notes/Beta.md", alphaNote("Beta"));
    const report = lintWrittenPages(vault, [rel]);
    expect(report.unavailable).toBeUndefined();
    expect(report.findings).toEqual([]);
    // Excluded by name, with the errno code, never silently.
    expect(report.candidates_unreadable).toEqual([{ page: "Notes/Stuck.md", detail: "EISDIR" }]);
  });

  test("a candidate over the artifact byte cap is not read as a candidate", () => {
    const filler = `${ALPHA_BODY} `.repeat(ARTIFACT_MAX_BYTES / ALPHA_BODY.length + 1);
    writeNote("Notes/Alpha.md", `---\ntitle: Alpha\n---\n\n${filler}\n`);
    const rel = writeNote("Notes/Beta.md", alphaNote("Beta"));
    const report = lintWrittenPages(vault, [rel]);
    expect(report.unavailable).toBeUndefined();
    expect(report.findings).toEqual([]);
    // The skip list stays reserved for WRITTEN pages.
    expect(report.skipped).toEqual([]);
  });

  test("a page spelled outside the vault collects no candidates from outside it", () => {
    // The write kernel refuses traversal, so this spelling can only reach
    // the lint from a caller; the candidate walk must still stop at the
    // vault boundary instead of reading the vault's parent directory.
    const outside = mkdtempSync(join(tmpdir(), "o2b-page-lint-out-"));
    try {
      const alphaNoteText = alphaNote("Sibling");
      writeFileSync(join(outside, "Sibling.md"), alphaNoteText, "utf8");
      writeFileSync(join(outside, "Escaped.md"), alphaNoteText, "utf8");
      // vault/../Escaped.md IS the file written above - the same bytes as
      // its neighbor, yet no near-duplicate may be reported about them.
      const report = lintWrittenPages(vault, ["../Escaped.md"]);
      expect(report.unavailable).toBeUndefined();
      expect(report.findings.filter((f) => f.code === NEAR_DUPLICATE_CODE)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

/**
 * A caller already holding the indexes can lint with them - including the
 * near-duplicate candidate index, so the seam stays honest about what is
 * precomputed per call versus read per page.
 */
describe("lintPagesWithContext - caller-supplied near-duplicate candidates", () => {
  test("a candidate in the index drives the same finding", () => {
    const rel = writeNote(
      "Notes/Beta.md",
      "---\ntitle: Beta\n---\n\nalpha beta gamma delta epsilon\n",
    );
    const candidates: ReadonlyArray<NearDuplicateCandidate> = [
      {
        page: "Notes/Alpha.md",
        scopeKey: "",
        tokens: new Set(["alpha", "beta", "gamma", "delta", "epsilon"]),
      },
    ];
    const ctx: LintContext = {
      basenames: new Set<string>(),
      vocabulary: loadSchemaPack(vault).vocabulary,
      nearDuplicateCandidates: new Map([["Notes", candidates]]),
      mergedLinks: { resolve: () => ({ canonical: null, unresolvable: null }) },
    };
    const report = lintPagesWithContext(vault, ctx, [rel]);
    const findings = report.findings.filter((f) => f.code === NEAR_DUPLICATE_CODE);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ page: rel, path: "Notes/Alpha.md" });
  });

  test("a written page is never its own candidate, even when indexed", () => {
    const rel = writeNote(
      "Notes/Beta.md",
      "---\ntitle: Beta\n---\n\nalpha beta gamma delta epsilon\n",
    );
    const candidates: ReadonlyArray<NearDuplicateCandidate> = [
      {
        page: rel,
        scopeKey: "",
        tokens: new Set(["alpha", "beta", "gamma", "delta", "epsilon"]),
      },
    ];
    const ctx: LintContext = {
      basenames: new Set<string>(),
      vocabulary: loadSchemaPack(vault).vocabulary,
      nearDuplicateCandidates: new Map([["Notes", candidates]]),
      mergedLinks: { resolve: () => ({ canonical: null, unresolvable: null }) },
    };
    expect(lintPagesWithContext(vault, ctx, [rel]).findings).toEqual([]);
  });
});
