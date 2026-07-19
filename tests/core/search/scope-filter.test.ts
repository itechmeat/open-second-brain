/**
 * Optional composite search scope filters (t_37c05a34): a query may opt into
 * session/project scope filtering; omitting the filter is byte-identical.
 */

import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  const v = createTempVault("scope-filter");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
});

afterEach(() => {
  cleanup();
});

async function indexed() {
  writeMd(vault, "s1.md", "---\nsession: s1\n---\n\nwidgets in session one.");
  writeMd(vault, "s2.md", "---\nsession: s2\n---\n\nwidgets in session two.");
  writeMd(vault, "shared.md", "# Shared\n\nwidgets everywhere, no scope.");
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg);
  return cfg;
}

test("a session scope filter returns only that scope plus unscoped pages", async () => {
  const cfg = await indexed();
  const outcome = await search(cfg, { query: "widgets", scope: { session: "s1" } });
  const paths = outcome.results.map((r) => r.path).toSorted();
  expect(paths).toEqual(["s1.md", "shared.md"]);
});

test("omitting the scope filter is byte-identical (every page reachable)", async () => {
  const cfg = await indexed();
  // Freeze the clock across both calls: recency decay is a continuous
  // function of wall-clock time, so two real Date.now() reads even a
  // millisecond apart would perturb the low-order digits of `score` /
  // `recencyBoost` and make a full-object comparison flaky for reasons
  // that have nothing to do with the scope filter under test.
  const nowMs = Date.now();
  const dateNowSpy = spyOn(Date, "now").mockReturnValue(nowMs);
  try {
    const withOut = await search(cfg, { query: "widgets" });
    const withEmpty = await search(cfg, { query: "widgets", scope: {} });
    // Full-projection equality: same result objects, in the same order, not
    // just the same set of paths - byte-identical means byte-identical.
    expect(withEmpty.results).toEqual(withOut.results);
    expect(withOut.results.map((r) => r.path).toSorted()).toEqual(["s1.md", "s2.md", "shared.md"]);
  } finally {
    dateNowSpy.mockRestore();
  }
});

test("a project scope filter is independent of the session axis", async () => {
  writeMd(vault, "p1.md", "---\nproject: alpha\n---\n\nwidgets project alpha.");
  writeMd(vault, "p2.md", "---\nproject: beta\n---\n\nwidgets project beta.");
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg);
  const outcome = await search(cfg, { query: "widgets", scope: { project: "alpha" } });
  expect(outcome.results.map((r) => r.path).toSorted()).toEqual(["p1.md"]);
});
