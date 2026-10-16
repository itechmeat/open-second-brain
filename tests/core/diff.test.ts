/**
 * Tests for src/core/diff.ts - the dependency-free unified-diff leaf
 * (t_b6bcd984 Task 1). The renderer moved here from
 * src/cli/brain/upgrade-render.ts so every guarded write lane (install
 * JSON-merge, protect, doctor repair) can attach a before/after diff to
 * its plan output; upgrade-render.ts keeps a re-export.
 */

import { describe, expect, test } from "bun:test";

import { renderUnifiedDiff } from "../../src/core/diff.ts";

describe("renderUnifiedDiff (core leaf)", () => {
  test("emits ---/+++/-/+ lines for a small before/after pair", () => {
    const diff = renderUnifiedDiff("keep\nold\nkeep\n", "keep\nnew\nkeep\n", "settings.json");
    const lines = diff.split("\n");
    expect(lines[0]).toContain("--- settings.json");
    expect(lines[1]).toContain("+++ settings.json");
    expect(lines).toContain("- old");
    expect(lines).toContain("+ new");
  });

  test("identical before and after renders an empty diff", () => {
    expect(renderUnifiedDiff("same\n", "same\n", "f.json")).toBe("");
  });

  test("a pure addition carries only + lines plus the header", () => {
    const diff = renderUnifiedDiff("a\n", "a\nb\n", "f.json");
    const lines = diff.split("\n");
    expect(lines.some((l) => l.startsWith("- "))).toBe(false);
    expect(lines).toContain("+ b");
  });

  test("matching context above and below is summarized, not repeated", () => {
    const before = "h1\nh2\nX\nh3\nh4";
    const after = "h1\nh2\nY\nh3\nh4";
    const diff = renderUnifiedDiff(before, after, "f.json");
    expect(diff).toContain("@@ context: 2 matching line(s) above @@");
    expect(diff).toContain("@@ context: 2 matching line(s) below @@");
    expect(diff).toContain("- X");
    expect(diff).toContain("+ Y");
  });

  test("an absent before file diffs against empty content", () => {
    const diff = renderUnifiedDiff("", '{\n  "mcpServers": {}\n}\n', "settings.json");
    const lines = diff.split("\n");
    expect(lines[0]).toContain("--- settings.json");
    expect(lines.some((l) => l.startsWith("+ "))).toBe(true);
  });
});
