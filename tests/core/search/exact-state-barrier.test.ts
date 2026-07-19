import { test, expect, beforeEach, afterEach } from "bun:test";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { Store } from "../../../src/core/search/store.ts";
import { search } from "../../../src/core/search/search.ts";
import { applyExactStateBarrier } from "../../../src/core/search/result-filters.ts";
import { writeExactState } from "../../../src/core/brain/exact-state.ts";
import type { BrainSearchResult } from "../../../src/core/search/types.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  const v = createTempVault("exact-state-barrier");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
});

afterEach(() => {
  cleanup();
});

function result(path: string): BrainSearchResult {
  return { path, chunkId: 1, documentId: 1, score: 1, reasons: [] } as unknown as BrainSearchResult;
}

test("barrier drops exact-state lane results and keeps everything else", () => {
  const kept = [result("notes/a.md"), result("Brain/preferences/pref-x.md")];
  const withLane = [...kept, result("Brain/state/deploy-target.md")];
  const filtered = applyExactStateBarrier(withLane);
  expect(filtered.map((r) => r.path)).toEqual(["notes/a.md", "Brain/preferences/pref-x.md"]);
});

test("barrier is a no-op (same reference) when no lane result is present", () => {
  const rows = [result("notes/a.md")];
  expect(applyExactStateBarrier(rows)).toBe(rows);
});

test("lane artifacts never enter the search index; non-lane content is untouched", async () => {
  writeMd(vault, "note.md", "# Note\n\nordinary indexable prose about widgets.");
  writeMd(vault, "Brain/preferences/pref-x.md", "---\nid: pref-x\n---\n\nprefer widgets.");
  writeExactState(vault, "deploy-target", "widgets staging cluster");
  const cfg = makeConfig({ vault, dbPath });

  await indexVault(cfg);
  const store = await Store.open(cfg, { mode: "read" });
  try {
    const paths = [...store.listDocuments().keys()];
    expect(paths).toContain("note.md");
    expect(paths).toContain("Brain/preferences/pref-x.md");
    expect(paths.some((p) => p.startsWith("Brain/state/"))).toBe(false);
  } finally {
    await store.close();
  }
});

test("regression: exact-state text does not resurface through recall", async () => {
  writeMd(vault, "note.md", "# Note\n\nwidgets are great.");
  writeExactState(vault, "deploy-target", "widgets staging cluster");
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg);

  const outcome = await search(cfg, { query: "widgets" });
  expect(outcome.results.some((r) => r.path.startsWith("Brain/state/"))).toBe(false);
  expect(outcome.results.some((r) => r.path === "note.md")).toBe(true);
});
