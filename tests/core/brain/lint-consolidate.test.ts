import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { lintConsolidate } from "../../../src/core/brain/lint-consolidate.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-lint-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writePref(slug: string, fields: Record<string, string>) {
  const lines = ["---", `id: pref-${slug}`];
  for (const [k, v] of Object.entries(fields)) lines.push(`${k}: ${v}`);
  lines.push("---", "");
  writeFileSync(join(vault, "Brain", "preferences", `pref-${slug}.md`), lines.join("\n"));
}

describe("lintConsolidate — fix-merged-link", () => {
  test("rewrites wikilinks pointing at a secondary", () => {
    writePref("canon", { topic: "x", principle: "y" });
    writePref("dup", { topic: "x", principle: "y", merged_into: "pref-canon" });
    writeFileSync(join(vault, "Brain", "log", "2026-05-25.md"), "saw [[pref-dup]] today\n");

    const dry = lintConsolidate(vault, { apply: false });
    expect(dry.fixes.length).toBe(1);
    expect(dry.fixes[0]!.from).toBe("pref-dup");
    expect(dry.fixes[0]!.to).toBe("pref-canon");
    expect(dry.applied).toBe(false);
    // dry-run does not write
    expect(readFileSync(join(vault, "Brain", "log", "2026-05-25.md"), "utf8")).toContain(
      "[[pref-dup]]",
    );

    const apply = lintConsolidate(vault, { apply: true });
    expect(apply.applied).toBe(true);
    expect(apply.filesWritten).toBeGreaterThan(0);
    expect(readFileSync(join(vault, "Brain", "log", "2026-05-25.md"), "utf8")).toContain(
      "[[pref-canon]]",
    );
  });

  test("preserves wikilink aliases and anchors when rewriting", () => {
    writePref("canon", { topic: "x", principle: "y" });
    writePref("dup", { topic: "x", principle: "y", merged_into: "pref-canon" });
    writeFileSync(
      join(vault, "Brain", "log", "2026-05-25.md"),
      "[[pref-dup|the rule]] and [[pref-dup#section]]\n",
    );
    lintConsolidate(vault, { apply: true });
    const content = readFileSync(join(vault, "Brain", "log", "2026-05-25.md"), "utf8");
    expect(content).toContain("[[pref-canon|the rule]]");
    expect(content).toContain("[[pref-canon#section]]");
  });

  test("a two-step merge converges in ONE pass", () => {
    // A -> B -> C. The single-hop merge map rewrote [[pref-a]] to
    // [[pref-b]], reported a `to` that was itself merged away, and needed
    // a second run to converge; the canonical-id resolver walks the chain.
    writePref("c", { topic: "x", principle: "y" });
    writePref("b", { topic: "x", principle: "y", merged_into: "pref-c" });
    writePref("a", { topic: "x", principle: "y", merged_into: "pref-b" });
    writeFileSync(join(vault, "Brain", "log", "2026-05-25.md"), "saw [[pref-a]] today\n");

    const report = lintConsolidate(vault, { apply: true });
    expect(report.fixes.map((f) => [f.from, f.to])).toEqual([["pref-a", "pref-c"]]);
    const content = readFileSync(join(vault, "Brain", "log", "2026-05-25.md"), "utf8");
    expect(content).toContain("[[pref-c]]");

    // Idempotent: a second pass finds nothing left to converge.
    const second = lintConsolidate(vault, { apply: true });
    expect(second.fixes.length).toBe(0);
    expect(second.filesWritten).toBe(0);
  });

  test("a merge cycle is declared as unresolved rather than silently skipped", () => {
    writePref("loop-a", { topic: "x", principle: "y", merged_into: "pref-loop-b" });
    writePref("loop-b", { topic: "x", principle: "y", merged_into: "pref-loop-a" });
    writeFileSync(join(vault, "Brain", "log", "2026-05-25.md"), "saw [[pref-loop-a]]\n");

    const report = lintConsolidate(vault, { apply: true });
    expect(report.fixes.length).toBe(0);
    expect(report.unresolved.map((u) => u.target)).toEqual(["pref-loop-a"]);
    expect(report.unresolved[0]!.reason).toContain("cycle");
    // The link is left exactly where it is.
    expect(readFileSync(join(vault, "Brain", "log", "2026-05-25.md"), "utf8")).toContain(
      "[[pref-loop-a]]",
    );
  });

  test("a merged_into value the id grammar rejects is declared, not swallowed", () => {
    // A hand edit or an external tool can leave a `merged_into:` value the
    // page-id grammar refuses. The chain then terminates in nothing: the
    // link can neither be followed nor honestly left alone. Reporting
    // nothing for it printed a clean vault over a link pointing at a page
    // that has been merged away, which is the silence this pass exists to
    // break. Distinct from a malformed link TARGET, which is simply not
    // this resolver's business and stays silent - the case below.
    writePref("bad-hop", { topic: "x", principle: "y", merged_into: "pref_B" });
    writeFileSync(join(vault, "Brain", "log", "2026-05-25.md"), "saw [[pref-bad-hop]]\n");

    const report = lintConsolidate(vault, { apply: true });
    expect(report.fixes.length).toBe(0);
    expect(report.unresolved.map((u) => u.target)).toEqual(["pref-bad-hop"]);
    expect(readFileSync(join(vault, "Brain", "log", "2026-05-25.md"), "utf8")).toContain(
      "[[pref-bad-hop]]",
    );
  });

  test("a link whose own id is outside the merge namespace stays silent", () => {
    // The other half of the same discriminator: `sig-` artifacts are not
    // merge-namespace ids at all, so the resolver saying "not my business"
    // is correct and must not become a finding.
    writeFileSync(join(vault, "Brain", "log", "2026-05-26.md"), "saw [[sig-2026-05-01-x]]\n");

    const report = lintConsolidate(vault, { apply: false });
    expect(report.fixes.length).toBe(0);
    expect(report.unresolved.length).toBe(0);
  });

  test("does not rewrite wikilinks that merely share a prefix", () => {
    writePref("canon", { topic: "x", principle: "y" });
    writePref("dup", { topic: "x", principle: "y", merged_into: "pref-canon" });
    writeFileSync(
      join(vault, "Brain", "log", "2026-05-25.md"),
      "real [[pref-dup]] vs [[pref-dup-extra]] vs [[pref-duplicate]]\n",
    );
    const report = lintConsolidate(vault, { apply: true });
    expect(report.fixes.length).toBe(1);
    const content = readFileSync(join(vault, "Brain", "log", "2026-05-25.md"), "utf8");
    expect(content).toContain("[[pref-canon]]");
    expect(content).toContain("[[pref-dup-extra]]");
    expect(content).toContain("[[pref-duplicate]]");
    expect(content).not.toMatch(/\[\[pref-dup\]\]/);
  });
});

describe("lintConsolidate — demote-stale-stable", () => {
  test("flags stable preferences older than the threshold", () => {
    writePref("old", {
      topic: "x",
      principle: "y",
      created_at: "2025-01-01T00:00:00Z",
      _lifecycle: "stable",
    });
    writePref("recent", {
      topic: "x",
      principle: "y",
      created_at: "2026-05-01T00:00:00Z",
      _lifecycle: "stable",
    });
    const report = lintConsolidate(vault, {
      apply: false,
      now: new Date("2026-05-25T00:00:00Z"),
    });
    expect(report.demotions.map((d) => d.id)).toEqual(["pref-old"]);
  });

  test("does not demote stable preferences with recent evidence", () => {
    writePref("evidenced", {
      topic: "x",
      principle: "y",
      created_at: "2024-01-01T00:00:00Z",
      _lifecycle: "stable",
      _last_evidence_at: "2026-05-01T00:00:00Z",
    });
    const report = lintConsolidate(vault, {
      apply: false,
      now: new Date("2026-05-25T00:00:00Z"),
    });
    expect(report.demotions.length).toBe(0);
  });

  test("apply writes _lifecycle: draft on the demoted file", () => {
    writePref("old", {
      topic: "x",
      principle: "y",
      created_at: "2025-01-01T00:00:00Z",
      _lifecycle: "stable",
    });
    lintConsolidate(vault, {
      apply: true,
      now: new Date("2026-05-25T00:00:00Z"),
    });
    const yaml = readFileSync(join(vault, "Brain", "preferences", "pref-old.md"), "utf8");
    expect(yaml).toContain("_lifecycle: draft");
    expect(yaml).not.toContain("_lifecycle: stable");
  });

  test("never demotes verified or deprecated lifecycles", () => {
    writePref("verified", {
      topic: "x",
      principle: "y",
      created_at: "2025-01-01T00:00:00Z",
      _lifecycle: "verified",
    });
    writePref("deprecated", {
      topic: "x",
      principle: "y",
      created_at: "2025-01-01T00:00:00Z",
      _lifecycle: "deprecated",
    });
    const report = lintConsolidate(vault, {
      apply: false,
      now: new Date("2026-05-25T00:00:00Z"),
    });
    expect(report.demotions.length).toBe(0);
  });

  test("custom staleDays override is honoured", () => {
    writePref("borderline", {
      topic: "x",
      principle: "y",
      created_at: "2026-04-01T00:00:00Z",
      _lifecycle: "stable",
    });
    const r = lintConsolidate(vault, {
      apply: false,
      staleDays: 30,
      now: new Date("2026-05-25T00:00:00Z"),
    });
    expect(r.demotions.length).toBe(1);
  });
});

describe("lintConsolidate — empty vault", () => {
  test("reports zero across the board", () => {
    const r = lintConsolidate(vault, { apply: false });
    expect(r.fixes.length).toBe(0);
    expect(r.demotions.length).toBe(0);
    expect(r.unresolved.length).toBe(0);
    expect(r.filesWritten).toBe(0);
  });
});
