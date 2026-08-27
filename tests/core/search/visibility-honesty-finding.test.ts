/**
 * The visibility honesty finding on `search check`
 * (nothing-writes-silently, unit H, form B).
 *
 * The claims pinned here:
 *
 *   1. A vault with no `visibility:` frontmatter anywhere gets no
 *      finding at all - the field is absent, not a zero count.
 *   2. A vault with at least one `visibility:`-tagged page gets the
 *      finding, and its counts are exactly
 *      `excludedCallableVisibilitySurfaces().length` /
 *      `callableVisibilitySurfaces().length` - never a hand-written
 *      number that could drift from the registry backing it.
 *   3. An index that does not exist yet gets no finding (nothing was
 *      measured, so nothing is claimed).
 *   4. The denominator counts CALLABLE surfaces only: the registry's
 *      `index_store` row is a structural fact about the index's own
 *      storage, and counting it as a surface an operator could call
 *      inflates a number reported to operators by one.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";

import { indexCheck, indexVault } from "../../../src/core/search/indexer.ts";
import {
  callableVisibilitySurfaces,
  excludedCallableVisibilitySurfaces,
  excludedVisibilitySurfaces,
  VISIBILITY_SURFACE_KIND,
  VISIBILITY_SURFACE_REGISTRY,
} from "../../../src/core/search/visibility-surface-registry.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  const v = createTempVault("visibility-honesty");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
});

afterEach(() => {
  cleanup();
});

test("a vault that never uses visibility: gets no finding at all", async () => {
  writeMd(vault, "a.md", "# A\n\nAn ordinary note.");
  await indexVault(makeConfig({ vault, dbPath }));

  const report = await indexCheck(makeConfig({ vault, dbPath }));
  expect(report.visibilityHonesty).toBeUndefined();
});

test("a vault with one visibility-tagged page gets the finding, counted from the registry", async () => {
  writeMd(vault, "a.md", "---\nvisibility: private\n---\n\n# A\n\nA private page.");
  await indexVault(makeConfig({ vault, dbPath }));

  const report = await indexCheck(makeConfig({ vault, dbPath }));
  expect(report.visibilityHonesty).toBeDefined();
  expect(report.visibilityHonesty?.excludedSurfaceCount).toBe(
    excludedCallableVisibilitySurfaces().length,
  );
  expect(report.visibilityHonesty?.totalSurfaceCount).toBe(callableVisibilitySurfaces().length);
  // Not a trivial zero-of-zero: the registry actually carries excluded rows.
  expect(report.visibilityHonesty!.excludedSurfaceCount).toBeGreaterThan(0);
  // ...and the covered half is no longer the two surfaces it started as.
  expect(report.visibilityHonesty!.totalSurfaceCount).toBeGreaterThan(
    excludedCallableVisibilitySurfaces().length,
  );
});

test("the document counts come from the index, not from a hand-written number", async () => {
  writeMd(vault, "open.md", "# Open\n\nAn ordinary note.");
  writeMd(vault, "a.md", "---\nvisibility: private\n---\n\n# A\n\nA reserved page.");
  writeMd(vault, "b.md", "---\nvisibility: private\n---\n\n# B\n\nAnother reserved page.");
  writeMd(vault, "team.md", "---\nvisibility: team\n---\n\n# T\n\nA team page.");
  await indexVault(makeConfig({ vault, dbPath }));

  const report = await indexCheck(makeConfig({ vault, dbPath }));
  // Only the reserved token counts - a non-reserved one is not withheld.
  expect(report.visibilityHonesty?.reservedDocumentCount).toBe(2);
  // Every page here has a frontmatter chunk the index could read.
  expect(report.visibilityHonesty?.unmeasuredDocumentCount).toBe(0);
});

test("the denominator leaves out the row the registry itself calls not a surface", async () => {
  writeMd(vault, "a.md", "---\nvisibility: private\n---\n\n# A\n\nA private page.");
  await indexVault(makeConfig({ vault, dbPath }));

  const indexStoreRows = VISIBILITY_SURFACE_REGISTRY.filter(
    (row) => row.kind === VISIBILITY_SURFACE_KIND.indexStore,
  );
  expect(indexStoreRows).toHaveLength(1);

  const report = await indexCheck(makeConfig({ vault, dbPath }));
  expect(report.visibilityHonesty?.totalSurfaceCount).toBe(
    VISIBILITY_SURFACE_REGISTRY.length - indexStoreRows.length,
  );
  // ...and it is an excluded row, so it would have moved both counts.
  expect(report.visibilityHonesty?.excludedSurfaceCount).toBe(
    excludedVisibilitySurfaces().length - indexStoreRows.length,
  );
});

test("an index that does not exist yet gets no finding", async () => {
  const report = await indexCheck(makeConfig({ vault, dbPath }));
  expect(report.visibilityHonesty).toBeUndefined();
});
