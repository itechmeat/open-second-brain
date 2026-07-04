import { describe, expect, test } from "bun:test";

import {
  assessGraphHealth,
  summarizeGraphHealth,
  type GraphHealthCode,
} from "../../../src/core/partner/codegraph-health.ts";

function codes(input: Parameters<typeof assessGraphHealth>[0]): GraphHealthCode[] {
  return assessGraphHealth(input).warnings.map((w) => w.code);
}

describe("assessGraphHealth", () => {
  test("healthy indexed graph -> ok, no warnings", () => {
    const r = assessGraphHealth({ nodeCount: 12, edgeCount: 40 });
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  test("zero nodes -> empty-graph (and no collapsed-edges double-warn)", () => {
    const c = codes({ nodeCount: 0, edgeCount: 0 });
    expect(c).toContain("empty-graph");
    expect(c).not.toContain("collapsed-edges");
  });

  test("nodes but zero edges -> collapsed-edges", () => {
    const r = assessGraphHealth({ nodeCount: 100, edgeCount: 0 });
    expect(r.ok).toBe(false);
    expect(r.warnings.map((w) => w.code)).toEqual(["collapsed-edges"]);
    expect(r.warnings[0]!.message).toContain("100");
  });

  test("dangling references surfaced only when the count is provided and > 0", () => {
    expect(codes({ nodeCount: 5, edgeCount: 5 })).not.toContain("dangling-references");
    expect(codes({ nodeCount: 5, edgeCount: 5, danglingRefs: 0 })).not.toContain(
      "dangling-references",
    );
    expect(codes({ nodeCount: 5, edgeCount: 5, danglingRefs: 3 })).toContain("dangling-references");
  });

  test("self-loops surfaced only when the count is provided and > 0", () => {
    expect(codes({ nodeCount: 5, edgeCount: 5 })).not.toContain("self-loops");
    expect(codes({ nodeCount: 5, edgeCount: 5, selfLoops: 0 })).not.toContain("self-loops");
    expect(codes({ nodeCount: 5, edgeCount: 5, selfLoops: 2 })).toContain("self-loops");
  });

  test("cache-root mismatch when index root differs from worktree root", () => {
    const r = assessGraphHealth({
      nodeCount: 5,
      edgeCount: 5,
      indexRoot: "/repo",
      worktreeRoot: "/repo/.worktrees/x",
    });
    expect(r.warnings.map((w) => w.code)).toContain("cache-root-mismatch");
    expect(r.warnings.find((w) => w.code === "cache-root-mismatch")!.message).toContain("/repo");
  });

  test("matching roots (trailing-slash insensitive) -> no mismatch", () => {
    expect(
      codes({ nodeCount: 5, edgeCount: 5, indexRoot: "/repo", worktreeRoot: "/repo/" }),
    ).not.toContain("cache-root-mismatch");
  });

  test("missing roots never fabricate a mismatch", () => {
    expect(
      codes({ nodeCount: 5, edgeCount: 5, indexRoot: null, worktreeRoot: "/repo" }),
    ).not.toContain("cache-root-mismatch");
    expect(codes({ nodeCount: 5, edgeCount: 5 })).not.toContain("cache-root-mismatch");
  });

  test("multiple findings are ordered deterministically", () => {
    const r = assessGraphHealth({
      nodeCount: 0,
      edgeCount: 0,
      danglingRefs: 1,
      selfLoops: 1,
      indexRoot: "/a",
      worktreeRoot: "/b",
    });
    expect(r.warnings.map((w) => w.code)).toEqual([
      "empty-graph",
      "dangling-references",
      "self-loops",
      "cache-root-mismatch",
    ]);
  });

  test("non-finite counts are treated as zero, not NaN comparisons", () => {
    const r = assessGraphHealth({ nodeCount: Number.NaN, edgeCount: Number.NaN });
    expect(r.warnings.map((w) => w.code)).toEqual(["empty-graph"]);
  });
});

describe("summarizeGraphHealth", () => {
  test("clean report -> ok", () => {
    expect(summarizeGraphHealth({ ok: true, warnings: [] })).toBe("ok");
  });

  test("warnings -> count and codes", () => {
    const report = assessGraphHealth({ nodeCount: 10, edgeCount: 0, selfLoops: 1 });
    expect(summarizeGraphHealth(report)).toBe("2 warning(s) [collapsed-edges, self-loops]");
  });
});
