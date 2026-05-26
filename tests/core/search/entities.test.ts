/**
 * Deterministic, language-agnostic entity extraction. Candidates come
 * from structural Unicode cues only - wikilink targets/aliases, quoted
 * spans, capitalized token runs, CamelCase, ALLCAPS, and digit-bearing
 * tokens. No NER dependency, no per-language word list, so extraction
 * is identical across locales and bit-stable across Syncthing peers.
 */

import { test, expect } from "bun:test";

import { extractEntities } from "../../../src/core/search/entities.ts";

test("extracts a capitalized multi-word run", () => {
  const e = extractEntities("Open Second Brain ships a recall suite.");
  expect(e).toContain("open second brain");
});

test("extracts wikilink target and alias display text", () => {
  const e = extractEntities("See [[Pay Memory]] and [[notes/ledger.md|Receipt Ledger]].");
  expect(e).toContain("pay memory");
  expect(e).toContain("receipt ledger");
});

test("extracts CamelCase identifiers", () => {
  const e = extractEntities("Route every write through writePreferenceTxn please.");
  expect(e).toContain("writepreferencetxn");
});

test("extracts ALLCAPS acronyms and digit-bearing tokens", () => {
  const e = extractEntities("It fuses FTS5 keyword scoring with MMR diversity.");
  expect(e).toContain("fts5");
  expect(e).toContain("mmr");
});

test("extracts a double-quoted span", () => {
  const e = extractEntities('The term "second brain" matters here.');
  expect(e).toContain("second brain");
});

test("uses Unicode categories, not an English word list (Cyrillic name)", () => {
  const e = extractEntities("Автор Сергей пишет код.");
  expect(e).toContain("сергей");
});

test("dedupes and drops single-character noise", () => {
  const e = extractEntities(
    "Alpha runs first. Alpha runs again. Open Second Brain ships, then Open Second Brain ships once more. A lone letter.",
  );
  expect(e.filter((x) => x === "alpha")).toHaveLength(1);
  expect(e).not.toContain("a");
  expect(e.filter((x) => x === "open second brain")).toHaveLength(1);
});

test("returns a frozen array", () => {
  expect(Object.isFrozen(extractEntities("Open Second Brain"))).toBe(true);
});
