import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  writeFileSync(
    join(vault, "Brain", "preferences", `pref-${slug}.md`),
    lines.join("\n"),
  );
}

describe("lintConsolidate — fix-merged-link", () => {
  test("rewrites wikilinks pointing at a secondary", () => {
    writePref("canon", { topic: "x", principle: "y" });
    writePref("dup", { topic: "x", principle: "y", merged_into: "pref-canon" });
    writeFileSync(
      join(vault, "Brain", "log", "2026-05-25.md"),
      "saw [[pref-dup]] today\n",
    );

    const dry = lintConsolidate(vault, { apply: false });
    expect(dry.fixes.length).toBe(1);
    expect(dry.fixes[0]!.from).toBe("pref-dup");
    expect(dry.fixes[0]!.to).toBe("pref-canon");
    expect(dry.applied).toBe(false);
    // dry-run does not write
    expect(
      readFileSync(join(vault, "Brain", "log", "2026-05-25.md"), "utf8"),
    ).toContain("[[pref-dup]]");

    const apply = lintConsolidate(vault, { apply: true });
    expect(apply.applied).toBe(true);
    expect(apply.filesWritten).toBeGreaterThan(0);
    expect(
      readFileSync(join(vault, "Brain", "log", "2026-05-25.md"), "utf8"),
    ).toContain("[[pref-canon]]");
  });

  test("preserves wikilink aliases and anchors when rewriting", () => {
    writePref("canon", { topic: "x", principle: "y" });
    writePref("dup", { topic: "x", principle: "y", merged_into: "pref-canon" });
    writeFileSync(
      join(vault, "Brain", "log", "2026-05-25.md"),
      "[[pref-dup|the rule]] and [[pref-dup#section]]\n",
    );
    lintConsolidate(vault, { apply: true });
    const content = readFileSync(
      join(vault, "Brain", "log", "2026-05-25.md"),
      "utf8",
    );
    expect(content).toContain("[[pref-canon|the rule]]");
    expect(content).toContain("[[pref-canon#section]]");
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
    const content = readFileSync(
      join(vault, "Brain", "log", "2026-05-25.md"),
      "utf8",
    );
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
    const yaml = readFileSync(
      join(vault, "Brain", "preferences", "pref-old.md"),
      "utf8",
    );
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
    expect(r.filesWritten).toBe(0);
  });
});
