/**
 * Language-agnostic co-occurrence auto-relate (Recall & Working-Memory
 * Quality Suite, t_7a632707).
 *
 * Entities that are repeatedly co-referenced from the same notes get a
 * suggested relationship edge, scored by a structural PMI/document-
 * frequency metric over the wikilink graph. The derivation reads only
 * link structure - no natural-language word list in any language - so a
 * vault written in a non-Latin script produces structurally identical
 * scores. Suggestions never mutate notes; they persist to a versioned,
 * hashed artifact that re-validates on read and fails soft.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CO_OCCURRENCE_SCHEMA_VERSION,
  computeCoOccurrenceSuggestions,
  readCoOccurrenceSuggestions,
  writeCoOccurrenceSuggestions,
} from "../../../../src/core/brain/link-graph/co-occurrence.ts";

let vault: string;

function writeNote(rel: string, body: string): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-cooccurrence-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("computeCoOccurrenceSuggestions", () => {
  test("two notes co-referencing the same pair yield one suggestion", () => {
    writeNote("notes/m1.md", "# M1\n\nSee [[alpha]] and [[beta]].\n");
    writeNote("notes/m2.md", "# M2\n\nAlso [[alpha]] with [[beta]] again.\n");
    // An unrelated note enlarges the document universe so the alpha/beta
    // co-occurrence is more than chance (PMI > 0).
    writeNote("notes/m3.md", "# M3\n\nDifferent [[gamma]] and [[delta]].\n");
    writeNote("notes/alpha.md", "# Alpha\n\nStandalone.\n");
    writeNote("notes/beta.md", "# Beta\n\nStandalone.\n");
    const result = computeCoOccurrenceSuggestions(vault, { minCoDocuments: 2 });
    const pair = result.suggestions.find((s) => s.left === "alpha" && s.right === "beta");
    expect(pair).toBeDefined();
    expect(pair!.coDocumentCount).toBe(2);
    expect(pair!.score).toBeGreaterThan(0);
  });

  test("a pair co-referenced only once is below the min-co-document floor", () => {
    writeNote("notes/m1.md", "# M1\n\nSee [[alpha]] and [[beta]].\n");
    const result = computeCoOccurrenceSuggestions(vault, { minCoDocuments: 2 });
    expect(result.suggestions.some((s) => s.left === "alpha" && s.right === "beta")).toBe(false);
  });

  test("an already directly-linked pair is not re-suggested", () => {
    // alpha links beta directly, so a co-reference must not re-propose them.
    writeNote("notes/m1.md", "# M1\n\nSee [[alpha]] and [[beta]].\n");
    writeNote("notes/alpha.md", "# Alpha\n\nLinks [[beta]] directly.\n");
    writeNote("notes/beta.md", "# Beta\n\nStandalone.\n");
    const result = computeCoOccurrenceSuggestions(vault, { minCoDocuments: 1 });
    expect(result.suggestions.some((s) => s.left === "alpha" && s.right === "beta")).toBe(false);
  });

  test("scores are language-agnostic: a non-Latin vault scores identically", () => {
    writeNote("notes/m1.md", "# M1\n\nSee [[alpha]] and [[beta]].\n");
    writeNote("notes/m2.md", "# M2\n\nAlso [[alpha]] with [[beta]].\n");
    writeNote("notes/m3.md", "# M3\n\nDifferent [[gamma]] and [[delta]].\n");
    const latin = computeCoOccurrenceSuggestions(vault, { minCoDocuments: 2 });

    rmSync(vault, { recursive: true, force: true });
    vault = mkdtempSync(join(tmpdir(), "o2b-cooccurrence-cjk-"));
    writeNote("notes/m1.md", "# M1\n\nSee [[行列]] and [[共鳴]].\n");
    writeNote("notes/m2.md", "# M2\n\nAlso [[行列]] with [[共鳴]].\n");
    writeNote("notes/m3.md", "# M3\n\nDifferent [[勾配]] and [[時系列]].\n");
    const cjk = computeCoOccurrenceSuggestions(vault, { minCoDocuments: 2 });

    expect(latin.suggestions[0]!.score).toBeGreaterThan(0);
    expect(cjk.suggestions).toHaveLength(latin.suggestions.length);
    expect(cjk.suggestions[0]!.coDocumentCount).toBe(latin.suggestions[0]!.coDocumentCount);
    expect(cjk.suggestions[0]!.score).toBe(latin.suggestions[0]!.score);
  });

  test("is deterministic: identical vault yields identical suggestions and order", () => {
    writeNote("notes/m1.md", "# M1\n\n[[a]] [[b]] [[c]]\n");
    writeNote("notes/m2.md", "# M2\n\n[[a]] [[b]] [[c]]\n");
    const first = computeCoOccurrenceSuggestions(vault, { minCoDocuments: 2 });
    const second = computeCoOccurrenceSuggestions(vault, { minCoDocuments: 2 });
    expect(JSON.stringify(first.suggestions)).toBe(JSON.stringify(second.suggestions));
  });

  test("multi-word entity names round-trip through the pair key intact", () => {
    // Canonical keys keep internal spaces; the pair key/split must not
    // corrupt them (regression: a single-space separator split at the first
    // space and mangled multi-word titles).
    writeNote("notes/m1.md", "# M1\n\nSee [[Project Alpha]] and [[Meeting Notes]].\n");
    writeNote("notes/m2.md", "# M2\n\nAlso [[Project Alpha]] with [[Meeting Notes]].\n");
    writeNote("notes/m3.md", "# M3\n\nDifferent [[gamma]] and [[delta]].\n");
    const result = computeCoOccurrenceSuggestions(vault, { minCoDocuments: 2 });
    const pair = result.suggestions.find(
      (s) => s.left === "meeting notes" && s.right === "project alpha",
    );
    expect(pair).toBeDefined();
    expect(pair!.coDocumentCount).toBe(2);
  });

  test("the limit caps the number of suggestions", () => {
    writeNote("notes/m1.md", "# M1\n\n[[a]] [[b]] [[c]] [[d]]\n");
    writeNote("notes/m2.md", "# M2\n\n[[a]] [[b]] [[c]] [[d]]\n");
    const result = computeCoOccurrenceSuggestions(vault, { minCoDocuments: 2, limit: 2 });
    expect(result.suggestions.length).toBeLessThanOrEqual(2);
  });
});

describe("persistence", () => {
  test("write then read round-trips the suggestions", () => {
    writeNote("notes/m1.md", "# M1\n\n[[alpha]] [[beta]]\n");
    writeNote("notes/m2.md", "# M2\n\n[[alpha]] [[beta]]\n");
    const result = computeCoOccurrenceSuggestions(vault, { minCoDocuments: 2 });
    writeCoOccurrenceSuggestions(vault, result, { generatedAt: "2026-06-14T00:00:00.000Z" });
    const reloaded = readCoOccurrenceSuggestions(vault);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.schema).toBe(CO_OCCURRENCE_SCHEMA_VERSION);
    expect(JSON.stringify(reloaded!.suggestions)).toBe(JSON.stringify(result.suggestions));
  });

  test("a missing artifact reads as null (fail-soft)", () => {
    expect(readCoOccurrenceSuggestions(vault)).toBeNull();
  });

  test("a corrupt artifact reads as null (fail-soft)", () => {
    mkdirSync(join(vault, "Brain", "link-graph"), { recursive: true });
    writeFileSync(join(vault, "Brain", "link-graph", "co-occurrence.json"), "{not json", "utf8");
    expect(readCoOccurrenceSuggestions(vault)).toBeNull();
  });

  test("a drifted schema version reads as null", () => {
    mkdirSync(join(vault, "Brain", "link-graph"), { recursive: true });
    writeFileSync(
      join(vault, "Brain", "link-graph", "co-occurrence.json"),
      JSON.stringify({ schema: "o2b.cooccurrence.v999", suggestions: [] }),
      "utf8",
    );
    expect(readCoOccurrenceSuggestions(vault)).toBeNull();
  });
});
