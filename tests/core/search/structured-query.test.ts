import { expect, test } from "bun:test";

import { parseStructuredRecallQueryDocument } from "../../../src/core/search/structured-query.ts";
import { SearchError } from "../../../src/core/search/types.ts";

test("parseStructuredRecallQueryDocument parses intent and typed lanes", () => {
  const parsed = parseStructuredRecallQueryDocument(`
intent: exact
lex: "release notes" -draft
vec: semantic memory recall
hyde: the accepted release decision mentions recall diagnostics
`);

  expect(parsed.intent).toBe("exact");
  expect(parsed.lex.include).toEqual(["release notes"]);
  expect(parsed.lex.exclude).toEqual(["draft"]);
  expect(parsed.vec).toEqual(["semantic memory recall"]);
  expect(parsed.hyde).toEqual(["the accepted release decision mentions recall diagnostics"]);
});

test("parseStructuredRecallQueryDocument allows repeated lanes", () => {
  const parsed = parseStructuredRecallQueryDocument(`
lex: alpha
lex: beta
vec: gamma
vec: delta
`);

  expect(parsed.lex.include).toEqual(["alpha", "beta"]);
  expect(parsed.vec).toEqual(["gamma", "delta"]);
});

test("parseStructuredRecallQueryDocument rejects malformed lane syntax", () => {
  let err: SearchError | null = null;
  try {
    parseStructuredRecallQueryDocument("lex without colon");
  } catch (e) {
    err = e as SearchError;
  }

  expect(err).toBeInstanceOf(SearchError);
  expect(err?.code).toBe("INVALID_INPUT");
  expect(err?.message).toContain("line 1");
});

test("parseStructuredRecallQueryDocument rejects unknown lanes", () => {
  expect(() => parseStructuredRecallQueryDocument("sql: drop table chunks")).toThrow(SearchError);
});

test("parseStructuredRecallQueryDocument rejects unterminated quotes", () => {
  expect(() => parseStructuredRecallQueryDocument('lex: "unfinished')).toThrow(SearchError);
});
