/**
 * Task Q3 (t_9bee8f0b): graph-degree cardinality predicates in the
 * filter DSL.
 *
 * Acceptance coverage (parser + pure filter):
 *   - filters select notes by backlink/outlink count with all six
 *     comparison operators (orphans `= 0`, hubs `>= N`);
 *   - invalid predicate syntax rejects with a typed SearchError;
 *   - an empty predicate list is a byte-identical pass-through.
 */

import { describe, expect, test } from "bun:test";

import {
  applyDegreeFilters,
  parseDegreePredicate,
  type DegreePredicate,
} from "../../../src/core/search/property-filter.ts";
import { SearchError } from "../../../src/core/search/types.ts";

describe("parseDegreePredicate", () => {
  test("parses every operator and both fields", () => {
    expect(parseDegreePredicate("backlinks=0")).toEqual({
      field: "backlinks",
      op: "=",
      value: 0,
    });
    expect(parseDegreePredicate("outlinks>=5")).toEqual({
      field: "outlinks",
      op: ">=",
      value: 5,
    });
    expect(parseDegreePredicate("backlinks!=2")).toEqual({
      field: "backlinks",
      op: "!=",
      value: 2,
    });
    expect(parseDegreePredicate("outlinks<10")).toEqual({ field: "outlinks", op: "<", value: 10 });
    expect(parseDegreePredicate("backlinks<=3")).toEqual({
      field: "backlinks",
      op: "<=",
      value: 3,
    });
    expect(parseDegreePredicate("outlinks>1")).toEqual({ field: "outlinks", op: ">", value: 1 });
  });

  test("tolerates surrounding whitespace", () => {
    expect(parseDegreePredicate("  backlinks >= 2 ")).toEqual({
      field: "backlinks",
      op: ">=",
      value: 2,
    });
  });

  test.each([
    "links=0", // unknown field
    "backlinks", // no operator
    "backlinks==2", // malformed operator
    "outlinks>=-1", // negative value
    "outlinks>=1.5", // non-integer
    "backlinks>=abc", // non-numeric
    "", // empty
  ])("rejects %p with a typed SearchError", (expr) => {
    let err: unknown;
    try {
      parseDegreePredicate(expr);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SearchError);
    expect((err as SearchError).code).toBe("INVALID_INPUT");
  });
});

describe("applyDegreeFilters", () => {
  const rows = [{ path: "hub.md" }, { path: "a.md" }, { path: "b.md" }, { path: "orphan.md" }];
  const degrees: Record<string, { backlinks: number; outlinks: number }> = {
    "hub.md": { backlinks: 0, outlinks: 2 },
    "a.md": { backlinks: 1, outlinks: 1 },
    "b.md": { backlinks: 2, outlinks: 0 },
    "orphan.md": { backlinks: 0, outlinks: 0 },
  };
  const degreeOf = (path: string) => degrees[path] ?? { backlinks: 0, outlinks: 0 };

  const run = (preds: DegreePredicate[]) =>
    applyDegreeFilters(rows, preds, degreeOf).map((r) => r.path);

  test("empty predicate list passes through byte-identically", () => {
    const out = applyDegreeFilters(rows, [], degreeOf);
    expect(out.map((r) => r.path)).toEqual(rows.map((r) => r.path));
  });

  test("orphans: backlinks = 0", () => {
    expect(run([parseDegreePredicate("backlinks=0")])).toEqual(["hub.md", "orphan.md"]);
  });

  test("hubs: outlinks >= 2", () => {
    expect(run([parseDegreePredicate("outlinks>=2")])).toEqual(["hub.md"]);
  });

  test("!= operator", () => {
    expect(run([parseDegreePredicate("backlinks!=0")])).toEqual(["a.md", "b.md"]);
  });

  test("< and <= operators", () => {
    expect(run([parseDegreePredicate("outlinks<1")])).toEqual(["b.md", "orphan.md"]);
    expect(run([parseDegreePredicate("backlinks<=1")])).toEqual(["hub.md", "a.md", "orphan.md"]);
  });

  test("multiple predicates are ANDed", () => {
    expect(run([parseDegreePredicate("backlinks=0"), parseDegreePredicate("outlinks>=1")])).toEqual(
      ["hub.md"],
    );
  });
});
