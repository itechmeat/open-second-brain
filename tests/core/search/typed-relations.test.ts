/**
 * Typed frontmatter relationships (typed graph semantics, unit 2).
 *
 * A page declares semantic relationships in frontmatter
 * (`related` / `extends` / `contradicts` / `superseded_by`). The indexer
 * turns those into typed edges in the links table (relation set via the
 * single vocabulary boundary), and a search result for the declaring
 * page surfaces them inline.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { Store } from "../../../src/core/search/store.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("typed-relations"));
});
afterEach(() => cleanup());

const PAGE_A = [
  "---",
  "title: Alpha",
  "contradicts: [[b]]",
  'superseded_by: "[[c]]"',
  "related: [d, e]",
  "---",
  "# Alpha",
  "",
  "A note about quantum foxes and their habits.",
].join("\n");

test("frontmatter relation fields become typed edges in the links table", async () => {
  writeMd(vault, "a.md", PAGE_A);
  writeMd(vault, "b.md", "# Beta\n\nunrelated body");
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg);

  const store = await Store.open(cfg, { mode: "read", loadVec: false });
  try {
    const aId = store.getDocumentIdByPath("a.md");
    expect(aId).not.toBeNull();
    const rels = store.typedRelationsForDocuments([aId!]).get(aId!) ?? [];
    const got = rels.map((r) => `${r.relation}:${r.target}`).toSorted();
    // The lightweight frontmatter parser mangles `[[b]]` -> `[b]`; the
    // target normaliser must recover the bare id either way.
    expect(got).toEqual(
      ["contradicts:b", "related:d", "related:e", "superseded_by:c"].toSorted(),
    );
  } finally {
    await store.close();
  }
});

test("a plain page with no relation frontmatter produces no typed edges", async () => {
  writeMd(vault, "plain.md", "# Plain\n\njust prose, links to [[other]] in body");
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg);

  const store = await Store.open(cfg, { mode: "read", loadVec: false });
  try {
    const id = store.getDocumentIdByPath("plain.md")!;
    const rels = store.typedRelationsForDocuments([id]).get(id) ?? [];
    expect(rels).toHaveLength(0); // the body wikilink is a plain edge, no relation
  } finally {
    await store.close();
  }
});

test("search surfaces a result page's declared relations inline", async () => {
  writeMd(vault, "a.md", PAGE_A);
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg);

  const out = await search(cfg, { query: "quantum foxes", limit: 5 });
  const hit = out.results.find((r) => r.path === "a.md");
  expect(hit).toBeDefined();
  const summary = (hit!.relations ?? []).map((r) => `${r.relation}:${r.target}`).toSorted();
  expect(summary).toContain("contradicts:b");
  expect(summary).toContain("superseded_by:c");
});
