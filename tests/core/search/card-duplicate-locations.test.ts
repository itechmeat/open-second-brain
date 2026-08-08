/**
 * A layer-1 card reports the exact duplicates that were merged into it
 * (what-the-index-already-knew, task D follow-up).
 *
 * The design states: "Merged-away locations are reported on the surviving
 * row, never silently dropped." That held on the `full` path only. A
 * `SearchCard` carried no duplicate field at all, so `toSearchCard`
 * discarded a value the pipeline had already computed: three byte-identical
 * copies returned one card naming one path, with nothing saying two others
 * had been folded away. Cards mode is reachable from both the CLI and MCP.
 *
 * A card exists to be small, so it carries the merged-away locations as
 * `path:Lstart-Lend` POINTERS - the same grammar as its own `pointer`
 * field, and the same rendering the full transcript already uses - rather
 * than the full location records. The passage is byte-identical by
 * construction, so a caller never needs to expand a folded copy; it needs
 * to know where else the bytes live.
 *
 * House discipline for an optional field: ABSENT, not null and not empty,
 * when nothing was merged.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { serializeSearchCard } from "../../../src/core/search/serialize.ts";
import { toSearchCard } from "../../../src/core/search/cards.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";
import type { DuplicatePassageLocation } from "../../../src/core/search/search-result.ts";
import type { BrainSearchResult, ResolvedSearchConfig } from "../../../src/core/search/types.ts";

const QUERY = "quantum entanglement";

/** The passage duplicated verbatim across files below. */
const PASSAGE =
  "# Quantum entanglement\n\n" +
  "Quantum entanglement links two particles so that measuring one fixes " +
  "the other, regardless of the distance separating them. The correlation " +
  "is not a signal and carries no information on its own.\n";

const FOLDED: DuplicatePassageLocation = Object.freeze({
  documentId: 7,
  chunkId: 42,
  path: "archive/entanglement-copy.md",
  title: "Entanglement (copy)",
  startLine: 3,
  endLine: 9,
});

function resultWith(duplicates?: ReadonlyArray<DuplicatePassageLocation>): BrainSearchResult {
  return Object.freeze({
    documentId: 1,
    chunkId: 1,
    path: "physics/entanglement.md",
    title: "Entanglement",
    content: "Quantum entanglement links two particles at a distance.",
    startLine: 1,
    endLine: 9,
    score: 1.5,
    keywordScore: 1.5,
    semanticScore: 0,
    linkBoost: 0,
    recencyBoost: 0,
    searchType: "keyword" as const,
    reasons: Object.freeze(["keyword: 1.50"]),
    ...(duplicates !== undefined ? { duplicates: Object.freeze(duplicates) } : {}),
  });
}

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  const v = createTempVault("card-duplicate-locations");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
});

afterEach(() => {
  cleanup();
});

test("the projection carries the folded locations as line pointers", () => {
  const card = toSearchCard(resultWith([FOLDED]), QUERY);
  expect(card.duplicatePointers).toEqual([
    `${FOLDED.path}:L${FOLDED.startLine}-L${FOLDED.endLine}`,
  ]);
});

test("a card with nothing merged carries no duplicate key at all", () => {
  const card = toSearchCard(resultWith(), QUERY);
  expect(Object.hasOwn(card, "duplicatePointers")).toBe(false);
  const wire = serializeSearchCard(card);
  expect(Object.hasOwn(wire, "duplicate_pointers")).toBe(false);
  // Absent from the bytes, not merely undefined on the object.
  expect(JSON.stringify(wire)).not.toContain("duplicate");
});

test("the wire projection names the folded locations under a snake_case key", () => {
  const wire = serializeSearchCard(toSearchCard(resultWith([FOLDED]), QUERY));
  expect(wire["duplicate_pointers"]).toEqual([
    `${FOLDED.path}:L${FOLDED.startLine}-L${FOLDED.endLine}`,
  ]);
});

test("three byte-identical copies return one card naming the two folded paths", async () => {
  writeMd(vault, "a/entanglement.md", PASSAGE);
  writeMd(vault, "b/entanglement.md", PASSAGE);
  writeMd(vault, "c/entanglement.md", PASSAGE);
  const cfg: ResolvedSearchConfig = makeConfig({ vault, dbPath });
  await indexVault(cfg);

  const outcome = await search(cfg, { query: QUERY, limit: 10, disclosure: "cards" });
  expect(outcome.cards).toBeDefined();
  expect(outcome.cards!.length).toBe(1);
  const card = outcome.cards![0]!;
  const pointers = card.duplicatePointers ?? [];
  expect(pointers.length).toBe(2);
  const named = [card.path, ...pointers.map((p) => p.slice(0, p.lastIndexOf(":")))].toSorted();
  expect(named).toEqual(["a/entanglement.md", "b/entanglement.md", "c/entanglement.md"]);
  for (const pointer of pointers) expect(pointer).toMatch(/:L\d+(-L\d+)?$/);
});

test("a corpus with no duplicates produces cards with no duplicate key", async () => {
  writeMd(vault, "one.md", "# Alpha\n\nQuantum alpha notes about the first topic entirely.\n");
  writeMd(vault, "two.md", "# Beta\n\nQuantum beta notes about the second topic entirely.\n");
  const cfg: ResolvedSearchConfig = makeConfig({ vault, dbPath });
  await indexVault(cfg);

  const outcome = await search(cfg, { query: "quantum notes", limit: 10, disclosure: "cards" });
  expect(outcome.cards!.length).toBe(2);
  for (const card of outcome.cards!) {
    expect(Object.hasOwn(card, "duplicatePointers")).toBe(false);
    expect(JSON.stringify(serializeSearchCard(card))).not.toContain("duplicate");
  }
});
