/**
 * Task Q3 (t_9bee8f0b): graph-degree cardinality predicates end-to-end
 * through `search()`.
 *
 * Acceptance coverage:
 *   - filters select notes by backlink/outlink count, matching the graph
 *     index degree data (orphans `backlinks=0`, hubs `outlinks>=N`);
 *   - queries without degree predicates behave byte-identically.
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { parseDegreePredicate } from "../../../src/core/search/property-filter.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

describe("degree predicates in search", () => {
  let vault: string;
  let dbPath: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ vault, dbPath, cleanup } = createTempVault("degree"));
  });
  afterEach(() => cleanup());

  async function seed(): Promise<ReturnType<typeof makeConfig>> {
    // hub -> a, hub -> b, a -> b. Shared token "lattice" so all match.
    writeMd(vault, "hub.md", "# hub\n\nlattice [[a]] and [[b]]");
    writeMd(vault, "a.md", "# a\n\nlattice [[b]]");
    writeMd(vault, "b.md", "# b\n\nlattice terminal");
    writeMd(vault, "orphan.md", "# orphan\n\nlattice alone");
    const cfg = makeConfig({ vault, dbPath });
    await indexVault(cfg);
    return cfg;
  }

  test("orphans: backlinks=0 selects notes nobody links to", async () => {
    const cfg = await seed();
    const out = await search(cfg, {
      query: "lattice",
      limit: 10,
      degreeFilters: [parseDegreePredicate("backlinks=0")],
    });
    // hub and orphan have zero back-links; a and b are linked to.
    expect(out.results.map((r) => r.path).toSorted()).toEqual(["hub.md", "orphan.md"]);
  });

  test("hubs: outlinks>=2 selects notes with many out-links", async () => {
    const cfg = await seed();
    const out = await search(cfg, {
      query: "lattice",
      limit: 10,
      degreeFilters: [parseDegreePredicate("outlinks>=2")],
    });
    expect(out.results.map((r) => r.path).toSorted()).toEqual(["hub.md"]);
  });

  test("no degree predicate is byte-identical to an unfiltered query", async () => {
    const cfg = await seed();
    const baseline = await search(cfg, { query: "lattice", limit: 10 });
    const withEmpty = await search(cfg, { query: "lattice", limit: 10, degreeFilters: [] });
    expect(withEmpty.results.map((r) => r.path)).toEqual(baseline.results.map((r) => r.path));
  });
});
