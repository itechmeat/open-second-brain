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
