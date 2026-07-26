/**
 * Unit F: an index run reports the frontmatter lines its scanner dropped.
 *
 * The reader is a line scanner, not a YAML parser, so unsupported grammar
 * never fails the run - the file indexes and the field silently vanishes.
 * These tests pin that the file still indexes (control flow unchanged) and
 * that the drop now reaches `IndexStats` as a named notice.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { DEGRADATION_CODE } from "../../../src/core/integrity/degradation.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  const v = createTempVault("indexer-fm-notices");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
});

afterEach(() => {
  cleanup();
});

test("a vault with no malformed frontmatter reports no notices", async () => {
  writeFileSync(
    join(vault, "clean.md"),
    "---\ntitle: Clean\ntype: note\ntags:\n  - a\n  - b\n---\n\nBody text here.\n",
  );
  const stats = await indexVault(makeConfig({ vault, dbPath }));
  expect(stats.added).toBe(1);
  expect(stats.frontmatterNotices).toEqual([]);
  expect(stats.errors).toEqual([]);
});

test("an unsupported frontmatter line is named in the run stats and the note still indexes", async () => {
  writeFileSync(
    join(vault, "odd.md"),
    "---\ntitle: Odd\n-foo\ntype: note\n---\n\nBody text here.\n",
  );
  writeMd(vault, "good.md", "plain content");
  const stats = await indexVault(makeConfig({ vault, dbPath }));

  // Control flow is unchanged: both notes index, nothing is an error.
  expect(stats.added).toBe(2);
  expect(stats.errors).toEqual([]);

  expect(stats.frontmatterNotices).toHaveLength(1);
  const notice = stats.frontmatterNotices[0]!;
  expect(notice.code).toBe(DEGRADATION_CODE.frontmatterLineDropped);
  expect(notice.path).toBe("odd.md");
  expect(notice.detail).toContain("-foo");
});
