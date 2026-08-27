/**
 * Content visibility scoping (typed graph semantics, unit 3).
 *
 * A page tagged with a non-default `visibility:` is hidden from a
 * default search and reachable only when the caller requests that
 * visibility. Untagged pages are unaffected (zero regression).
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";

import {
  REMOTE_DENY_VISIBILITY_TOKEN,
  isVisible,
  normalizeVisibilityScope,
  pageVisibility,
} from "../../../src/core/graph/visibility.ts";
import { TRANSPORT_REACH } from "../../../src/core/graph/transport-reach.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";
import { rmSync } from "node:fs";
import { join } from "node:path";

describe("visibility rule (pure)", () => {
  test("a page with no visibility tag is always reachable", () => {
    expect(pageVisibility({ title: "x" })).toEqual([]);
    expect(isVisible([], normalizeVisibilityScope([]))).toBe(true);
    expect(isVisible([], normalizeVisibilityScope(["private"]))).toBe(true);
  });

  test("a tagged page is reachable only when its tag is in scope", () => {
    const tags = pageVisibility({ visibility: ["Private"] });
    expect(tags).toEqual(["private"]); // normalised
    expect(isVisible(tags, normalizeVisibilityScope([]))).toBe(false);
    expect(isVisible(tags, normalizeVisibilityScope(["private"]))).toBe(true);
    expect(isVisible(tags, normalizeVisibilityScope(["team"]))).toBe(false);
  });
});

describe("visibility scoping in search", () => {
  let vault: string;
  let dbPath: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ vault, dbPath, cleanup } = createTempVault("visibility"));
  });
  afterEach(() => cleanup());

  test("a private page is excluded by default and included when requested", async () => {
    writeMd(vault, "public.md", "# Public\n\nshared lattice notes about widgets");
    writeMd(
      vault,
      "secret.md",
      "---\nvisibility: [private]\n---\n# Secret\n\nclassified lattice notes about widgets",
    );
    const cfg = makeConfig({ vault, dbPath });
    await indexVault(cfg);

    const def = await search(cfg, { query: "lattice widgets", limit: 10 });
    const defPaths = def.results.map((r) => r.path).toSorted();
    expect(defPaths).toEqual(["public.md"]);

    // The caller argument still lifts the page for a caller this server
    // established local access for - the operator's own CLI, unchanged.
    const scoped = await search(cfg, {
      query: "lattice widgets",
      limit: 10,
      visibility: [REMOTE_DENY_VISIBILITY_TOKEN],
      transportReach: TRANSPORT_REACH.local,
    });
    const scopedPaths = scoped.results.map((r) => r.path).toSorted();
    expect(scopedPaths).toEqual(["public.md", "secret.md"]);
  });

  test("the caller argument narrows only: it cannot lift the reserved token", async () => {
    writeMd(vault, "public.md", "# Public\n\nshared lattice notes about widgets");
    writeMd(
      vault,
      "secret.md",
      "---\nvisibility: [private]\n---\n# Secret\n\nclassified lattice notes about widgets",
    );
    const cfg = makeConfig({ vault, dbPath });
    await indexVault(cfg);

    const asked = await search(cfg, {
      query: "lattice widgets",
      limit: 10,
      visibility: [REMOTE_DENY_VISIBILITY_TOKEN],
      transportReach: TRANSPORT_REACH.remote,
    });
    expect(asked.results.map((r) => r.path).toSorted()).toEqual(["public.md"]);
  });

  test("an unmeasurable page is withheld at remote reach and kept at local", async () => {
    // A document still in the index whose file was deleted since the last
    // run has an UNREADABLE visibility claim, and an unreadable claim is
    // not the absence of one. Fail closed at remote reach; the local
    // caller, who could read the file directly anyway, keeps the row.
    writeMd(vault, "gone.md", "# Gone\n\nlattice widget vanishing");
    writeMd(vault, "here.md", "# Here\n\nlattice widget staying");
    const cfg = makeConfig({ vault, dbPath });
    await indexVault(cfg);
    rmSync(join(vault, "gone.md"));

    const remote = await search(cfg, {
      query: "lattice widget",
      limit: 10,
      transportReach: TRANSPORT_REACH.remote,
    });
    expect(remote.results.map((r) => r.path).toSorted()).toEqual(["here.md"]);

    const local = await search(cfg, {
      query: "lattice widget",
      limit: 10,
      transportReach: TRANSPORT_REACH.local,
    });
    expect(local.results.map((r) => r.path).toSorted()).toEqual(["gone.md", "here.md"]);
  });

  test("default scope backfills untagged matches when tagged pages crowd a narrow pool", async () => {
    // Recall layers off (mmrLambda=1, maxHops=0) -> the narrow rank cap
    // would otherwise let tagged pages truncate the window below `limit`.
    // The backfill must still surface `limit` untagged matches.
    for (let i = 0; i < 6; i++) {
      writeMd(
        vault,
        `secret-${i}.md`,
        "---\nvisibility: [private]\n---\nlattice widget secret " + i,
      );
    }
    for (let i = 0; i < 4; i++) {
      writeMd(vault, `public-${i}.md`, "# Public " + i + "\n\nlattice widget public " + i);
    }
    const cfg = makeConfig({ vault, dbPath });
    await indexVault(cfg);

    const out = await search(cfg, { query: "lattice widget", limit: 4, mmrLambda: 1, maxHops: 0 });
    const paths = out.results.map((r) => r.path).toSorted();
    expect(paths).toEqual(["public-0.md", "public-1.md", "public-2.md", "public-3.md"]);
    expect(out.results.every((r) => r.path.startsWith("public-"))).toBe(true);
  });

  test("an all-untagged vault is unaffected by the default scope", async () => {
    writeMd(vault, "a.md", "# A\n\nlattice alpha");
    writeMd(vault, "b.md", "# B\n\nlattice beta");
    const cfg = makeConfig({ vault, dbPath });
    await indexVault(cfg);

    const out = await search(cfg, { query: "lattice", limit: 10 });
    expect(out.results.map((r) => r.path).toSorted()).toEqual(["a.md", "b.md"]);
  });
});
