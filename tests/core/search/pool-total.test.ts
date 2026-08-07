/**
 * `SearchOutcome.total` is the pre-truncation ranked pool size
 * (what-the-index-already-knew, task F).
 *
 * Before this unit `total` was assigned the length of the returned array,
 * so it carried no information at all: a caller could not tell "the vault
 * holds three matches" from "the vault holds thirty and you were handed
 * three". The pool the final `limit` slice cuts from is a property of the
 * answer, not a diagnostic, so it is reported inline on every outcome.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

/** Matching notes, comfortably above the `limit` the queries below use. */
const MATCHING_NOTES = 12;
const LIMIT = 3;

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(async () => {
  ({ vault, dbPath, cleanup } = createTempVault("pool-total"));
  for (let i = 0; i < MATCHING_NOTES; i += 1) {
    writeMd(
      vault,
      `notes/note-${i}.md`,
      `---\ntitle: Note ${i}\n---\n\n# Note ${i}\n\nThe widget calibration routine number ${i}.\n`,
    );
  }
  await indexVault(makeConfig({ vault, dbPath, maxHops: 0 }), {});
});

afterEach(() => cleanup());

function config() {
  return makeConfig({ vault, dbPath, maxHops: 0 });
}

test("total is the ranked pool the limit slice cut from, not the row count", async () => {
  const out = await search(config(), { query: "widget calibration", limit: LIMIT });

  expect(out.results.length).toBe(LIMIT);
  expect(out.total).toBeGreaterThan(out.results.length);
  // The pool is the candidate set retrieval actually ranked, which is
  // widened past `limit` but still bounded by the lane fetch - so it is a
  // lower bound on the corpus matches, never an over-count.
  expect(out.total).toBeLessThanOrEqual(MATCHING_NOTES);
});

test("a limit wider than the pool reports the pool, so total never exceeds the corpus", async () => {
  const out = await search(config(), { query: "widget calibration", limit: MATCHING_NOTES + 5 });

  expect(out.results.length).toBe(MATCHING_NOTES);
  expect(out.total).toBe(MATCHING_NOTES);
});

test("cards disclosure reports the same pool as the full path", async () => {
  const full = await search(config(), { query: "widget calibration", limit: LIMIT });
  const cards = await search(config(), {
    query: "widget calibration",
    limit: LIMIT,
    disclosure: "cards",
  });

  expect(cards.cards!.length).toBe(LIMIT);
  expect(cards.total).toBe(full.total);
  expect(cards.total).toBeGreaterThan(cards.cards!.length);
});

test("a query with no candidates still reports zero", async () => {
  const out = await search(config(), { query: "zzzznonexistentterm", limit: LIMIT });

  expect(out.results).toEqual([]);
  expect(out.total).toBe(0);
});
