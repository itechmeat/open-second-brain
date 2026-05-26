/**
 * End-to-end header-anchored chunking: a query whose terms appear only
 * in a chunk's heading breadcrumb (not its body) still recalls the
 * chunk via the dedicated heading FTS column - and the heading text
 * never leaks into the returned display content.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { indexVault, search } from "../../../src/core/search/index.ts";
import { makeConfig, createTempVault } from "../../helpers/search-fixtures.ts";

let tmp: ReturnType<typeof createTempVault>;

beforeEach(async () => {
  tmp = createTempVault("heading-recall");
  mkdirSync(join(tmp.vault, "notes"), { recursive: true });
  // A long section whose later chunk's body never repeats the heading
  // word "Kingfisher"; only the heading carries it.
  // Long enough (> default 800-token chunk budget) to split into
  // multiple chunks, so later chunks carry no heading word in their body.
  const body = Array.from(
    { length: 220 },
    (_, i) => `Sentence number ${i} about diving and water.`,
  ).join("\n\n");
  writeFileSync(
    join(tmp.vault, "notes", "birds.md"),
    `---\ntitle: Birds\n---\n\n# Kingfisher\n\n${body}\n`,
  );
  const config = makeConfig({ vault: tmp.vault, dbPath: tmp.dbPath, maxHops: 0 });
  await indexVault(config, {});
});

afterEach(() => {
  tmp.cleanup();
});

test("a chunk is recalled by a heading-only term and content stays clean", async () => {
  const config = makeConfig({ vault: tmp.vault, dbPath: tmp.dbPath, maxHops: 0 });
  const out = await search(config, { query: "Kingfisher diving", limit: 20 });
  expect(out.results.length).toBeGreaterThan(0);
  // At least one recalled chunk's body does NOT contain the heading word,
  // proving the match came from the heading_path column rather than the
  // body - and that the breadcrumb is not appended to display content.
  const headingOnly = out.results.find((r) => !r.content.includes("Kingfisher"));
  expect(headingOnly).toBeDefined();
});
