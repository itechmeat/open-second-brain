/**
 * `listDangling`: the unresolved link targets themselves, not a count.
 *
 * The defect. The index could say HOW MANY links it could not resolve -
 * `linkResolutionCounts` returns `{ total, unresolved }` - and nothing
 * more. There was no way to ask WHICH targets those were, so every
 * consumer that wanted to act on a broken link (the repair lane's
 * `skip-missing-target`, the doctor's Brain-scoped `broken-backlinks`,
 * the synthesis pass's "write the missing note") either re-scanned the
 * vault itself or answered a narrower question. A number cannot be acted
 * on; a target plus its sources can.
 *
 * This file asserts the listing follows the SAME resolution ladder the
 * count does - a basename wikilink that Obsidian resolves is not dangling
 * just because `target_document_id` is NULL - because a listing under a
 * second definition would hand a caller notes to create that already
 * exist.
 *
 * Deliberately NOT covered here: the partial-resolution refusal, which is
 * a property of the READER and lives in the scaffold-stub test beside the
 * code that refuses; and any scaffolding, which this layer knows nothing
 * about.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { Store } from "../../../src/core/search/store.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  const v = createTempVault("dangling-links");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
});

afterEach(() => cleanup());

async function indexAndList(limit = 100) {
  const config = makeConfig({ vault, dbPath });
  await indexVault(config, { force: true });
  const store = await Store.open(config, { mode: "read" });
  try {
    return store.listDangling(limit);
  } finally {
    await store.close();
  }
}

test("names each unresolved target with the documents that reference it", async () => {
  writeMd(vault, "notes/a.md", "# A\n\nsee [[notes/ghost]] here\n");
  writeMd(vault, "notes/b.md", "# B\n\nalso [[notes/ghost]] and [[notes/other-ghost]]\n");

  const rows = await indexAndList();
  const ghost = rows.find((r) => r.target === "notes/ghost");
  expect(ghost).toBeDefined();
  expect([...ghost!.sources]).toEqual(["notes/a.md", "notes/b.md"]);
  expect(rows.map((r) => r.target)).toContain("notes/other-ghost");
});

test("a target the read-time ladder resolves is not reported as dangling", async () => {
  // The basename spelling an Obsidian-shaped vault is written in. It has
  // no materialized `target_document_id`, and the narrower predicate would
  // have called it broken - which is how a healthy edit raises a broken
  // count.
  writeMd(vault, "notes/target.md", "# Target\n\nbody\n");
  writeMd(vault, "notes/a.md", "# A\n\nsee [[target]]\n");

  const rows = await indexAndList();
  expect(rows.map((r) => r.target)).not.toContain("target");
});

test("a tag is not a dangling target - it has nothing to resolve to", async () => {
  writeMd(vault, "notes/a.md", "# A\n\n#some-tag and nothing else\n");
  const rows = await indexAndList();
  expect(rows.map((r) => r.target)).not.toContain("some-tag");
});

test("the listing is deterministic and honours its limit", async () => {
  writeMd(vault, "notes/a.md", "# A\n\n[[notes/z-ghost]] [[notes/a-ghost]] [[notes/m-ghost]]\n");
  const all = await indexAndList();
  expect(all.map((r) => r.target)).toEqual(["notes/a-ghost", "notes/m-ghost", "notes/z-ghost"]);
  const capped = await indexAndList(2);
  expect(capped).toHaveLength(2);
  expect(capped.map((r) => r.target)).toEqual(["notes/a-ghost", "notes/m-ghost"]);
});

test("an empty vault reports no dangling targets", async () => {
  writeMd(vault, "notes/a.md", "# A\n\nno links at all\n");
  expect(await indexAndList()).toEqual([]);
});
