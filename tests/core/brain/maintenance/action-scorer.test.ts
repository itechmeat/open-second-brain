import { describe, expect, test } from "bun:test";

import { scoreActions } from "../../../../src/core/brain/maintenance/action-scorer.ts";

describe("scoreActions", () => {
  test("empty inputs return empty list", () => {
    expect(scoreActions({})).toEqual([]);
  });

  test("dedup impact scales linearly with secondaryCount", () => {
    const items = scoreActions({
      dedupCandidates: [
        { canonicalId: "pref-a", secondaryCount: 1 },
        { canonicalId: "pref-b", secondaryCount: 3 },
      ],
    });
    expect(items.length).toBe(2);
    // pref-b (3 secondaries) outranks pref-a (1 secondary)
    expect(items[0]!.target).toBe("pref-b");
    expect(items[1]!.target).toBe("pref-a");
    expect(items[0]!.impact).toBeGreaterThan(items[1]!.impact);
  });

  test("stale lifecycle impact scales with age", () => {
    const items = scoreActions({
      staleByLifecycle: [
        { id: "pref-old", ageDays: 365 * 2 },
        { id: "pref-fresh-stale", ageDays: 200 },
      ],
    });
    expect(items[0]!.target).toBe("pref-old");
  });

  test("broken links bucket by source path", () => {
    const items = scoreActions({
      brokenLinks: [
        { path: "/x/log/a.md", from: "pref-x" },
        { path: "/x/log/a.md", from: "pref-y" },
        { path: "/x/log/b.md", from: "pref-z" },
      ],
    });
    expect(items.length).toBe(2);
    const a = items.find((i) => i.target === "/x/log/a.md")!;
    const b = items.find((i) => i.target === "/x/log/b.md")!;
    expect(a.impact).toBeGreaterThan(b.impact);
  });

  test("token footprint excess is zero below threshold", () => {
    const items = scoreActions({
      tokenFootprint: { total: 100, warnThreshold: 200_000 },
    });
    expect(items.length).toBe(0);
  });

  test("token footprint excess emits a single capped action", () => {
    const items = scoreActions({
      tokenFootprint: { total: 250_000, warnThreshold: 200_000 },
    });
    expect(items.length).toBe(1);
    expect(items[0]!.category).toBe("token-footprint");
    expect(items[0]!.target).toBe("vault");
  });

  test("topN caps the result", () => {
    const items = scoreActions(
      {
        dedupCandidates: Array.from({ length: 15 }, (_, i) => ({
          canonicalId: `pref-${i}`,
          secondaryCount: 1,
        })),
      },
      { topN: 5 },
    );
    expect(items.length).toBe(5);
  });

  test("results are ordered by impact descending then deterministic", () => {
    const items = scoreActions({
      dedupCandidates: [{ canonicalId: "pref-d1", secondaryCount: 1 }],
      brokenLinks: [
        { path: "/x/log/c.md", from: "pref-x" },
        { path: "/x/log/c.md", from: "pref-y" },
      ],
    });
    // both impacts: dedup = 1*8 = 8, brokenLinks bucket = 2*5 = 10
    expect(items[0]!.category).toBe("merged-link");
    expect(items[1]!.category).toBe("dedup");
  });

  test("dedupCandidate with zero secondaries is ignored", () => {
    const items = scoreActions({
      dedupCandidates: [{ canonicalId: "pref-a", secondaryCount: 0 }],
    });
    expect(items.length).toBe(0);
  });
});
