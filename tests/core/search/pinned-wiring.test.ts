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
import { utimesSync } from "node:fs";

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
  const pinnedPath = writeMd(
    vault,
    "notes/pinned.md",
    ["---", "pinned: true", "---", "", "robin finch body."].join("\n"),
  );
  const plainPath = writeMd(
    vault,
    "notes/plain.md",
    ["---", "pinned: false", "---", "", "robin finch body."].join("\n"),
  );
  // One shared mtime. The indexer records whole seconds and the Weibull
  // recency layer decays continuously from there, so two writes that
  // straddle a second boundary would perturb the exact-cap difference the
  // assertion below demands - a wall-clock artifact, not the pin.
  const shared = new Date(1_750_000_000_000);
  utimesSync(pinnedPath, shared, shared);
  utimesSync(plainPath, shared, shared);
  await indexVault(makeConfig({ vault, dbPath }));
}

test("the store facade serves only the pinned candidates", async () => {
  await build();
  const store = await Store.open(makeConfig({ vault, dbPath }), { mode: "read", loadVec: false });
  try {
    const pinnedId = store.getDocumentIdByPath("notes/pinned.md")!;
    const plainId = store.getDocumentIdByPath("notes/plain.md")!;
    expect(store.pinnedDocumentIds([pinnedId, plainId])).toEqual(new Set([pinnedId]));
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
  // The unpinned result keeps its pre-feature shape: no pinned key.
  expect(second!.breakdown).not.toHaveProperty("pinned");
  expect(first!.score - second!.score).toBeCloseTo(PINNED_BOOST_CAP, 9);
});
