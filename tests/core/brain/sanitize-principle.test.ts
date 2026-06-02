/**
 * Principle-text sanitizer (token-diet, t_40eb1de7): strips leaked
 * tool-call XML fragments and collapses multi-level backslash-quote
 * escaping at the write seam, so corrupted client payloads can no
 * longer poison `Brain/preferences/` frontmatter and every derived
 * view (active.md, digest, MCP resources).
 *
 * Fixture strings mirror the real corruption found on the live vault
 * on 2026-06-02 (see docs/brainstorm/token-diet/design.md).
 */

import { describe, expect, test } from "bun:test";

import { sanitisePrinciple } from "../../../src/core/brain/text/sanitize-principle.ts";

describe("sanitisePrinciple", () => {
  test("clean text passes through unchanged", () => {
    const s = 'Use "o2b search" before answering vault questions.';
    expect(sanitisePrinciple(s)).toBe(s);
  });

  test("collapses multi-level backslash-quote chains to a single quote", () => {
    const corrupted =
      'phrasing like \\\\\\"давай так:\\\\\\" or \\\\\\"пусть агент делает X\\\\\\"';
    expect(sanitisePrinciple(corrupted)).toBe(
      'phrasing like "давай так:" or "пусть агент делает X"',
    );
  });

  test("cuts a leaked closing tool-call tag and everything after it", () => {
    const corrupted =
      'everything else needs explicit per-edit approval.</principle>\\\\n<parameter name=\\\\\\"scope\\\\\\">collaboration';
    expect(sanitisePrinciple(corrupted)).toBe("everything else needs explicit per-edit approval.");
  });

  test("cuts at a leaked parameter-open fragment whose attributes carry escaped quotes", () => {
    const corrupted = 'real rule text<parameter name=\\"scope\\">writing';
    expect(sanitisePrinciple(corrupted)).toBe("real rule text");
  });

  test("legitimate prose mentioning <parameter> with plain quotes passes through", () => {
    const legit = 'Document tool calls as <parameter name="scope"> blocks in examples.';
    expect(sanitisePrinciple(legit)).toBe(legit);
  });

  test("a single escaped quote is legitimate prose and survives", () => {
    const legit = 'Inside JSON strings write \\" instead of a bare quote.';
    expect(sanitisePrinciple(legit)).toBe(legit);
  });

  test("a trailing literal newline escape outside a leak cut survives", () => {
    const legit = "End streamed lines with \\n";
    expect(sanitisePrinciple(legit)).toBe(legit);
  });

  test("idempotent: sanitizing twice equals sanitizing once", () => {
    const corrupted =
      'rule \\\\\\"with quotes\\\\\\" and tail</principle>\\\\n<parameter name=\\\\\\"scope\\\\\\">x';
    const once = sanitisePrinciple(corrupted);
    expect(sanitisePrinciple(once)).toBe(once);
  });

  test("non-string input coerces to empty string", () => {
    expect(sanitisePrinciple(undefined)).toBe("");
    expect(sanitisePrinciple(42)).toBe("");
  });
});
