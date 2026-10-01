/**
 * Query-side pinned wiring (t_f7bef96a, query half landed with Task 5): the
 * `documents.pinned` column reaches ranking through the store's
 * pinned-documents lookup, so the bounded always-on boost layer goes live on
 * the shipped pipeline - a note the indexer measured as `pinned: true`
 * outranks its unpinned twin by exactly the cap and says why.
 *
 * Pinned here:
 *   - the store facade serves the MEASURED map (unmeasured rows absent);
 *   - an end-to-end search surfaces the pinned reason and breakdown entry;
 *   - the flag reaches ranking from frontmatter through the index, with no
 *     query-time file reads.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";

import { PINNED_BOOST_CAP } from "../../../src/core/search/ranker.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { Store } from "../../../src/core/search/store.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  const v = createTempVault("pinned-wiring");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
});

afterEach(() => {
  cleanup();
});

async function build(): Promise<void> {
  // Byte-identical bodies: the pin is the only ranking difference.
  writeMd(
    vault,
    "notes/pinned.md",
    ["---", "pinned: true", "---", "", "robin finch body."].join("\n"),
  );
  writeMd(
    vault,
    "notes/plain.md",
    ["---", "pinned: false", "---", "", "robin finch body."].join("\n"),
  );
  await indexVault(makeConfig({ vault, dbPath }));
}

test("the store facade serves the measured pinned map", async () => {
  await build();
  const store = await Store.open(makeConfig({ vault, dbPath }), { mode: "read", loadVec: false });
  try {
    const pinned = store.pinnedDocuments();
    expect(pinned.size).toBe(2);
    expect([...pinned.values()].toSorted()).toEqual([false, true]);
  } finally {
    await store.close();
  }
});

test("a pinned note outranks its unpinned twin by exactly the cap, and says why", async () => {
  await build();
  const outcome = await search(makeConfig({ vault, dbPath }), { query: "robin finch" });
  expect(outcome.results.length).toBe(2);
  const [first, second] = outcome.results;
  expect(first!.path).toBe("notes/pinned.md");
  expect(first!.reasons).toContain(`pinned: ${PINNED_BOOST_CAP.toFixed(3)}`);
  expect(first!.breakdown!.pinned).toBe(PINNED_BOOST_CAP);
  expect(second!.path).toBe("notes/plain.md");
  expect(second!.breakdown!.pinned).toBe(0);
  expect(first!.score - second!.score).toBeCloseTo(PINNED_BOOST_CAP, 9);
});
