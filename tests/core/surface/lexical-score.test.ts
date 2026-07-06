import { test, expect } from "bun:test";

import { tokenize, scoreDescriptors } from "../../../src/core/surface/lexical-score.ts";
import type { SurfaceDescriptor } from "../../../src/core/surface/descriptor.ts";

function d(name: string, description: string, tags: string[] = []): SurfaceDescriptor {
  return Object.freeze({
    kind: "tool" as const,
    name,
    description,
    group: "test",
    tags: Object.freeze(tags),
  });
}

const CORPUS = [
  d("brain_search", "Hybrid keyword and semantic vault search.", ["search", "recall"]),
  d("brain_feedback", "Record one Brain taste signal into the inbox.", ["memory", "signal"]),
  d("vault_health", "Run vault, config, and plugin manifest health checks.", ["diagnostics"]),
  d("schema_inspect", "Inspect Brain schema vocabulary and graph.", ["schema"]),
];

test("tokenize lowercases, splits punctuation, drops 1-char tokens", () => {
  expect(tokenize("Hybrid keyword+semantic, X search!")).toEqual([
    "hybrid",
    "keyword",
    "semantic",
    "search",
  ]);
});

test("a CJK run longer than 2 chars also emits overlapping bigrams", () => {
  // Han text has no spaces, so a query like "...的实现方式" only matches a
  // skill trigger "实现方式" if both share the "实现" / "方式" bigrams.
  expect(tokenize("实现方式")).toEqual(["实现", "现方", "方式", "实现方式"]);
});

test("a 2-char CJK token is kept whole without extra bigrams", () => {
  expect(tokenize("实现")).toEqual(["实现"]);
});

test("bigrams come only from the Han span of a mixed token, not across the boundary", () => {
  // A spaceless mixed token like "gbrain实现" should share the Han bigram
  // "实现" with a query, but must NOT emit the cross-script window "n实"
  // (inert noise that inflates term frequency / document length).
  expect(tokenize("gbrain实现")).toEqual(["实现", "gbrain实现"]);
});

test("a 2-char Han run embedded in a longer mixed token still emits its bigram", () => {
  // Gated by the Han run, not the total token length: "ab实现cd" yields "实现"
  // even though the token as a whole is > 2 chars of mostly ASCII.
  expect(tokenize("ab实现cd")).toEqual(["实现", "ab实现cd"]);
});

test("ASCII tokenization is unaffected by the CJK bigram pass", () => {
  expect(tokenize("Hello World")).toEqual(["hello", "world"]);
});

test("CJK bigram overlap lets a spaceless query match a tag token", () => {
  const corpus = [
    d("doc_a", "documentation", ["实现方式"]),
    d("doc_b", "documentation", ["其他内容"]),
  ];
  const ranked = scoreDescriptors("新的实现方式", corpus);
  expect(ranked).toHaveLength(1);
  expect(ranked[0]!.descriptor.name).toBe("doc_a");
});

test("query matching a description ranks that descriptor first", () => {
  const ranked = scoreDescriptors("semantic vault search", CORPUS);
  expect(ranked[0]!.descriptor.name).toBe("brain_search");
  expect(ranked[0]!.score).toBeGreaterThan(0);
});

test("a name-token match outranks a description-only match", () => {
  const corpus = [
    d("alpha_tool", "useful for searching widget catalogs", []),
    d("widget_tool", "a generic helper", []),
  ];
  const ranked = scoreDescriptors("widget", corpus);
  expect(ranked[0]!.descriptor.name).toBe("widget_tool");
});

test("zero-score descriptors are filtered out", () => {
  const ranked = scoreDescriptors("nonexistent-term-xyz", CORPUS);
  expect(ranked).toHaveLength(0);
});

test("empty query and empty corpus return empty rankings", () => {
  expect(scoreDescriptors("", CORPUS)).toHaveLength(0);
  expect(scoreDescriptors("   ", CORPUS)).toHaveLength(0);
  expect(scoreDescriptors("search", [])).toHaveLength(0);
});

test("ties break by descriptor name ascending (deterministic)", () => {
  const corpus = [d("zz_same", "identical body text", []), d("aa_same", "identical body text", [])];
  const ranked = scoreDescriptors("identical body", corpus);
  expect(ranked.map((r) => r.descriptor.name)).toEqual(["aa_same", "zz_same"]);
});

test("scoring is reproducible across calls", () => {
  const a = scoreDescriptors("brain schema", CORPUS);
  const b = scoreDescriptors("brain schema", CORPUS);
  expect(a.map((r) => `${r.descriptor.name}:${r.score.toFixed(6)}`)).toEqual(
    b.map((r) => `${r.descriptor.name}:${r.score.toFixed(6)}`),
  );
});

test("tag tokens contribute to the score", () => {
  const corpus = [d("plain_tool", "does things", []), d("tagged_tool", "does things", ["recall"])];
  const ranked = scoreDescriptors("recall", corpus);
  expect(ranked).toHaveLength(1);
  expect(ranked[0]!.descriptor.name).toBe("tagged_tool");
});
