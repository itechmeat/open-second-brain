import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { Store } from "../../../src/core/search/store.ts";
import { planReadShortlist } from "../../../src/core/search/graph-prepass.ts";
import { makeConfig } from "../../helpers/search-fixtures.ts";
import type { ResolvedSearchConfig } from "../../../src/core/search/types.ts";

let vault: string;
let config: ResolvedSearchConfig;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-graph-prepass-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
  config = makeConfig({ vault, dbPath: join(vault, "index.sqlite") });
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

// A link chain hub -> mid -> leaf, so `leaf` is reachable from `hub` only
// via two hops. Plus an unrelated note.
function writeChain(): void {
  writeFileSync(join(vault, "hub.md"), "# Alpha Topic\n\nThe entry point. See [[mid]].\n");
  writeFileSync(join(vault, "mid.md"), "# Middle Note\n\nBridges onward to [[leaf]].\n");
  writeFileSync(join(vault, "leaf.md"), "# Leaf Detail\n\nThe deep conclusion.\n");
  writeFileSync(join(vault, "other.md"), "# Turtles\n\nUnrelated content about oceans.\n");
}

test("should_read ranks the title match first and reaches a 2-hop note via BFS", async () => {
  writeChain();
  await indexVault(config);
  const store = await Store.open(config, { mode: "read" });
  try {
    const plan = planReadShortlist(store, "Alpha Topic", { maxHops: 2, hopDecay: 0.5 });
    expect(plan.mode).toBe("should_read");
    const paths = plan.shortlist.map((e) => e.path);
    // The title match is the top seed.
    expect(paths[0]).toBe("hub.md");
    // `leaf.md` is reachable only through hub -> mid -> leaf (2 hops).
    const leaf = plan.shortlist.find((e) => e.path === "leaf.md");
    expect(leaf).toBeDefined();
    expect(leaf!.hops).toBe(2);
    expect(leaf!.reasons).toContain("bfs:2");
    // The unrelated note is not surfaced by this query.
    expect(paths).not.toContain("other.md");
  } finally {
    await store.close();
  }
});

test("index_only answers from metadata with zero note bodies read", async () => {
  writeChain();
  await indexVault(config);
  const store = await Store.open(config, { mode: "read" });
  try {
    const plan = planReadShortlist(store, "Alpha Topic", { indexOnly: true, maxHops: 2 });
    expect(plan.mode).toBe("index_only");
    expect(plan.notesRead).toBe(0);
    expect(plan.shortlist.length).toBeGreaterThan(0);
    // No summaries hydrated in index-only mode.
    for (const e of plan.shortlist) expect(e.summary).toBeNull();
    expect(plan.shortlist[0]!.path).toBe("hub.md");
  } finally {
    await store.close();
  }
});

test("should_read hydrates a bounded number of summaries (bodies read > 0)", async () => {
  writeChain();
  await indexVault(config);
  const store = await Store.open(config, { mode: "read" });
  try {
    const plan = planReadShortlist(store, "Alpha Topic", { maxHops: 1 });
    expect(plan.notesRead).toBeGreaterThan(0);
    const hub = plan.shortlist.find((e) => e.path === "hub.md");
    expect(hub!.summary).toContain("entry point");
  } finally {
    await store.close();
  }
});

test("a query matching nothing yields an empty shortlist", async () => {
  writeChain();
  await indexVault(config);
  const store = await Store.open(config, { mode: "read" });
  try {
    const plan = planReadShortlist(store, "zzzznomatch", { maxHops: 2 });
    expect(plan.shortlist.length).toBe(0);
  } finally {
    await store.close();
  }
});
