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
  const e = extractEntities("See [[Vector Store]] and [[notes/ledger.md|Recall Ledger]].");
  expect(e).toContain("vector store");
  expect(e).toContain("recall ledger");
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

test("a long unbroken letter run does not make extraction backtrack catastrophically", () => {
  // A Han, Thai or Lao paragraph is one unbroken `\p{L}` run carrying no
  // digits, which is the worst input for a naive `\p{L}+\p{N}+`: the engine
  // retries every shorter prefix at every start position. Measured on this
  // exact input before the alternatives were made atomic: 11.7 seconds and
  // zero matches. A 500-note Chinese vault could not be indexed at all.
  //
  // The bound is deliberately loose - two orders of magnitude above the
  // post-fix cost - so this asserts "not catastrophic" rather than a
  // machine-specific number, and cannot flake on a slow runner.
  const CATASTROPHE_GUARD_MS = 1000;
  const han = "中".repeat(2160);

  const started = performance.now();
  const entities = extractEntities(han);
  const elapsed = performance.now() - started;

  // Non-vacuous: this input really does drive the alternative that used to
  // backtrack, and really does yield nothing, so the guard is timing the
  // failure path rather than an early exit.
  expect(entities).toEqual([]);
  expect(`${elapsed < CATASTROPHE_GUARD_MS} in ${Math.round(elapsed)}ms`).toBe(
    `true in ${Math.round(elapsed)}ms`,
  );
});

test("making the letter run atomic changed no extraction result", () => {
  // The guard above only says the regex is fast. This says it is the same
  // regex: every shape the mixed-script alternatives exist to catch still
  // comes back, across scripts.
  expect(extractEntities("H2O and GPT4 and v2 and NASA")).toEqual(["h2o", "gpt4", "nasa", "v2"]);
  expect(extractEntities("東京2020 and 2020東京")).toEqual(["東京2020", "2020東京"]);
  expect(extractEntities("тест2 and 2тест")).toEqual(["тест2", "2тест"]);
  expect(extractEntities("abc123def456")).toEqual(["abc123", "def456"]);
});
