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
 *      `excludedVisibilitySurfaces().length` /
 *      `VISIBILITY_SURFACE_REGISTRY.length` - never a hand-written
 *      number that could drift from the registry backing it.
 *   3. An index that does not exist yet gets no finding (nothing was
 *      measured, so nothing is claimed).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";

import { indexCheck, indexVault } from "../../../src/core/search/indexer.ts";
import {
  excludedVisibilitySurfaces,
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
  expect(report.visibilityHonesty?.excludedSurfaceCount).toBe(excludedVisibilitySurfaces().length);
  expect(report.visibilityHonesty?.totalSurfaceCount).toBe(VISIBILITY_SURFACE_REGISTRY.length);
  // Not a trivial zero-of-zero: the registry actually carries excluded rows.
  expect(report.visibilityHonesty!.excludedSurfaceCount).toBeGreaterThan(0);
});

test("an index that does not exist yet gets no finding", async () => {
  const report = await indexCheck(makeConfig({ vault, dbPath }));
  expect(report.visibilityHonesty).toBeUndefined();
});
