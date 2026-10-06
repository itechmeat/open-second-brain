/**
 * The query-embed gateway (honest-query-embed-and-safe-upgrades, tasks 2-3).
 *
 * Two questions every paid query embed shares, answered once:
 *
 *   - what text is sent: the query cut to the effective input window,
 *     with the prefix the backend actually sends charged against it under
 *     the CEILING estimate, so the cut never sends more than the window;
 *   - whether it is sent at all: a caller that is not local, under a
 *     positive `embedding_cost_gate_usd`, on a model nobody priced, is
 *     refused before any provider exists.
 */

import { expect, test } from "bun:test";

import { fitQueryToWindow } from "../../../src/core/search/embeddings/query-embed.ts";
import {
  estimateTokens,
  textExtent,
  tokenEstimateCeiling,
  tokenEstimateFloor,
} from "../../../src/core/search/embeddings/signature.ts";

const PREFIX = "query: ";

function ceiling(text: string): number {
  return tokenEstimateCeiling(textExtent(text));
}

/** The code point after `text` in `query`, or undefined at the end. */
function nextCodePoint(query: string, text: string): string | undefined {
  return [...query][[...text].length];
}

// ── task 2: the fit ──────────────────────────────────────────────────────────

test("a null window returns the query unchanged", () => {
  const query = "x".repeat(10_000);
  const fit = fitQueryToWindow(query, PREFIX, null);
  expect(fit.text).toBe(query);
  expect(fit.truncated).toBe(false);
});

test("a query that fits a known window is not cut", () => {
  const fit = fitQueryToWindow("short query", PREFIX, 512);
  expect(fit.text).toBe("short query");
  expect(fit.truncated).toBe(false);
});

test("an ASCII query over the window is cut to the longest prefix that fits", () => {
  const window = 16;
  const query = "abcdefghij".repeat(20);
  const fit = fitQueryToWindow(query, PREFIX, window);
  expect(fit.truncated).toBe(true);
  expect(query.startsWith(fit.text)).toBe(true);
  expect(ceiling(PREFIX + fit.text)).toBeLessThanOrEqual(window);
  const next = nextCodePoint(query, fit.text);
  expect(next).toBeDefined();
  expect(ceiling(PREFIX + fit.text + next!)).toBeGreaterThan(window);
});

test("a Han query is cut under the ceiling bound, never the floor", () => {
  const window = 32;
  const query = "知识管理系统".repeat(20);
  const fit = fitQueryToWindow(query, PREFIX, window);
  expect(fit.truncated).toBe(true);
  expect(ceiling(PREFIX + fit.text)).toBeLessThanOrEqual(window);
  expect(ceiling(PREFIX + fit.text + nextCodePoint(query, fit.text)!)).toBeGreaterThan(window);
  // The floor would have admitted roughly four times as much Han text.
  const floorCut = [...query].slice(0, (window - 2) * 4).join("");
  expect(tokenEstimateFloor(textExtent(PREFIX + floorCut))).toBeLessThanOrEqual(window);
  expect([...fit.text].length).toBeLessThan([...floorCut].length);
});

test("a cut never splits a surrogate pair", () => {
  // Astral-plane characters: each is one code point and two UTF-16 units.
  for (let window = 3; window <= 12; window++) {
    const query = "😀".repeat(40);
    const fit = fitQueryToWindow(query, "", window);
    expect(fit.truncated).toBe(true);
    // A lone high surrogate would round-trip as U+FFFD.
    expect(fit.text.length % 2).toBe(0);
    expect(fit.text).toBe("😀".repeat([...fit.text].length));
    expect(Buffer.from(fit.text, "utf8").toString("utf8")).toBe(fit.text);
  }
});

test("a prefix that alone fills the window gives an empty text, truncated", () => {
  const prefix = "an instruction prefix far longer than the window allows: ";
  const fit = fitQueryToWindow("the actual question", prefix, 4);
  expect(fit.text).toBe("");
  expect(fit.truncated).toBe(true);
  // Nothing is sent, so nothing is counted.
  expect(fit.sentTokens).toBe(0);
});

test("sentTokens counts the prefix, with the shared spend estimator", () => {
  const uncut = fitQueryToWindow("hello world", PREFIX, null);
  expect(uncut.sentTokens).toBe(estimateTokens([PREFIX + "hello world"]));
  expect(uncut.sentTokens).toBeGreaterThan(estimateTokens(["hello world"]));
  const cut = fitQueryToWindow("abcdefghij".repeat(20), PREFIX, 16);
  expect(cut.sentTokens).toBe(estimateTokens([PREFIX + cut.text]));
});
