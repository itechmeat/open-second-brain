/**
 * The relation vocabulary is the single validation boundary for typed
 * graph semantics. It owns the open/extensible set of semantic relation
 * names and the one normalize/classify function every edge producer and
 * consumer reads from - no relation string is hardcoded across call
 * sites.
 */

import { test, expect } from "bun:test";

import {
  DEFAULT_RELATION_TYPES,
  isKnownRelation,
  normalizeRelation,
  relationFromFrontmatterField,
} from "../../../src/core/graph/relation-vocab.ts";

test("the default vocabulary covers the declared relation types", () => {
  const actual: string[] = [...DEFAULT_RELATION_TYPES];
  expect(actual.toSorted()).toEqual([
    "contradicts",
    "depends_on",
    "extends",
    "refines",
    "related",
    "superseded_by",
  ]);
});

test("normalizeRelation is NFC + trimmed + lower-cased", () => {
  expect(normalizeRelation("  Superseded_By  ")).toBe("superseded_by");
  expect(normalizeRelation("CONTRADICTS")).toBe("contradicts");
});

test("isKnownRelation accepts the vocabulary and rejects anything else", () => {
  for (const r of DEFAULT_RELATION_TYPES) expect(isKnownRelation(r)).toBe(true);
  expect(isKnownRelation("Contradicts")).toBe(true); // normalized before lookup
  expect(isKnownRelation("supersedes")).toBe(false); // not a frontmatter relation field
  expect(isKnownRelation("bogus")).toBe(false);
  expect(isKnownRelation("")).toBe(false);
});

test("relationFromFrontmatterField maps a known relation field to its relation, else null", () => {
  expect(relationFromFrontmatterField("contradicts")).toBe("contradicts");
  expect(relationFromFrontmatterField("Depends_On")).toBe("depends_on");
  expect(relationFromFrontmatterField("refines")).toBe("refines");
  expect(relationFromFrontmatterField("Superseded_By")).toBe("superseded_by");
  expect(relationFromFrontmatterField("title")).toBeNull();
  expect(relationFromFrontmatterField("aliases")).toBeNull();
});

test("DEFAULT_RELATION_TYPES is frozen so the vocabulary can't drift at runtime", () => {
  expect(Object.isFrozen(DEFAULT_RELATION_TYPES)).toBe(true);
});
