/**
 * Unit tests for `filterByProperties`. Pure post-FTS phase that
 * drops rows whose frontmatter scalars don't match a requested
 * filter map. Multi-value filter on the same key = OR; multiple
 * keys = AND.
 */

import { describe, expect, test } from "bun:test";

import { filterByProperties } from "../../../src/core/search/property-filter.ts";

interface Row {
  readonly path: string;
  readonly score: number;
}

const FM = new Map<string, Record<string, unknown>>([
  ["a.md", { type: "decision", status: "open", tags: ["urgent"] }],
  ["b.md", { type: "decision", status: "closed", tags: ["normal"] }],
  ["c.md", { type: "note", status: "open", tags: ["urgent", "fyi"] }],
  ["d.md", { type: "note", status: "draft" }],
]);

function reader(path: string): Record<string, unknown> | null {
  return FM.get(path) ?? null;
}

const ROWS: ReadonlyArray<Row> = [
  { path: "a.md", score: 1 },
  { path: "b.md", score: 1 },
  { path: "c.md", score: 1 },
  { path: "d.md", score: 1 },
];

describe("filterByProperties - shape", () => {
  test("empty filter map returns rows unchanged", () => {
    const r = filterByProperties(ROWS, new Map(), reader);
    expect(r.length).toBe(4);
  });

  test("returned array is frozen", () => {
    const r = filterByProperties(ROWS, new Map([["type", ["decision"]]]), reader);
    expect(Object.isFrozen(r)).toBe(true);
  });
});

describe("filterByProperties - single-key filter", () => {
  test("scalar match: type=decision", () => {
    const r = filterByProperties(ROWS, new Map([["type", ["decision"]]]), reader);
    expect(r.map((x) => x.path).toSorted()).toEqual(["a.md", "b.md"]);
  });

  test("multi-value filter (OR within key): status=open|closed", () => {
    const r = filterByProperties(ROWS, new Map([["status", ["open", "closed"]]]), reader);
    expect(r.map((x) => x.path).toSorted()).toEqual(["a.md", "b.md", "c.md"]);
  });

  test("array frontmatter value intersects requested set: tags=urgent", () => {
    const r = filterByProperties(ROWS, new Map([["tags", ["urgent"]]]), reader);
    expect(r.map((x) => x.path).toSorted()).toEqual(["a.md", "c.md"]);
  });
});

describe("filterByProperties - multi-key filter (AND across keys)", () => {
  test("type=decision AND status=open returns only a.md", () => {
    const r = filterByProperties(
      ROWS,
      new Map([
        ["type", ["decision"]],
        ["status", ["open"]],
      ]),
      reader,
    );
    expect(r.map((x) => x.path)).toEqual(["a.md"]);
  });

  test("contradictory filter returns empty list", () => {
    const r = filterByProperties(
      ROWS,
      new Map([
        ["type", ["decision"]],
        ["status", ["draft"]],
      ]),
      reader,
    );
    expect(r).toEqual([]);
  });
});

describe("filterByProperties - missing keys + null frontmatter", () => {
  test("missing key in row's frontmatter excludes the row", () => {
    const r = filterByProperties(ROWS, new Map([["tags", ["urgent"]]]), reader);
    // d.md has no `tags`, should be dropped.
    expect(r.map((x) => x.path).toSorted()).toEqual(["a.md", "c.md"]);
  });

  test("frontmatter reader returning null excludes the row", () => {
    const r = filterByProperties(
      [{ path: "missing.md", score: 1 }],
      new Map([["type", ["decision"]]]),
      () => null,
    );
    expect(r).toEqual([]);
  });
});
