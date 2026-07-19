import { test, expect } from "bun:test";

import { parseRelationalQuery } from "../../../src/core/search/relational-query.ts";
import { DEFAULT_RELATION_TYPES } from "../../../src/core/graph/relation-vocab.ts";

const VOCAB = [...DEFAULT_RELATION_TYPES];

test("detects a relationship shape: seed wikilink plus an edge-type token", () => {
  const parsed = parseRelationalQuery("what contradicts [[Thesis A]]", VOCAB);
  expect(parsed).not.toBeNull();
  expect(parsed!.seeds).toEqual(["Thesis A"]);
  expect(parsed!.edgeTypes).toEqual(["contradicts"]);
});

test("collects only edge tokens in the vocabulary (subset validation)", () => {
  const parsed = parseRelationalQuery("frobnicate depends_on [[X]] and extends it", VOCAB);
  expect(parsed!.edgeTypes.toSorted()).toEqual(["depends_on", "extends"]);
});

test("returns null without a seed", () => {
  expect(parseRelationalQuery("what contradicts the thesis", VOCAB)).toBeNull();
});

test("returns null without an edge-type token (a bare wikilink is not relational)", () => {
  expect(parseRelationalQuery("[[Thesis A]] overview", VOCAB)).toBeNull();
});

test("returns null when the vocabulary is empty", () => {
  expect(parseRelationalQuery("contradicts [[X]]", [])).toBeNull();
});

test("dedupes seeds and edge types deterministically", () => {
  const parsed = parseRelationalQuery("[[X]] extends [[X]] extends [[Y]]", VOCAB);
  expect(parsed!.seeds).toEqual(["X", "Y"]);
  expect(parsed!.edgeTypes).toEqual(["extends"]);
});
