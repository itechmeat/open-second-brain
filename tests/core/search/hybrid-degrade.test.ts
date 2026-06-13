/**
 * Hybrid-degrade warning (Search & Recall Quality Suite): when a caller
 * wants the semantic lane but it cannot run (here: no embeddings indexed),
 * search() serves keyword-only and appends ONE greppable
 * `hybrid_degraded:` warning. A keyword-only-by-choice query and a
 * genuine hybrid query never carry it.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  const v = createTempVault("hybrid-degrade");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
  writeMd(vault, "Notes/foo.md", "# Foo\n\nThe quick brown fox jumps over the lazy dog.");
});

afterEach(() => {
  cleanup();
});

function semanticEnabledConfig() {
  // Semantic is enabled in config, but the index below is built WITHOUT
  // embeddings, so the semantic lane degrades out at query time.
  return makeConfig({
    vault,
    dbPath,
    semantic: { enabled: true, provider: "local", model: "local", dimension: 8 },
  });
}

test("semantic wanted but unavailable -> keyword-only with a hybrid_degraded warning", async () => {
  const cfg = semanticEnabledConfig();
  await indexVault(cfg, {}); // no embeddings
  const out = await search(cfg, { query: "fox", limit: 5, semantic: true });
  expect(out.results.length).toBeGreaterThan(0);
  expect(out.warnings.some((w) => w.startsWith("hybrid_degraded:"))).toBe(true);
});

test("keyword-only by choice carries no hybrid_degraded warning", async () => {
  const cfg = semanticEnabledConfig();
  await indexVault(cfg, {});
  const out = await search(cfg, { query: "fox", limit: 5, keywordOnly: true });
  expect(out.warnings.some((w) => w.startsWith("hybrid_degraded:"))).toBe(false);
});

test("a vault with semantic disabled in config carries no hybrid_degraded warning", async () => {
  const cfg = makeConfig({ vault, dbPath }); // semantic disabled (default)
  await indexVault(cfg, {});
  const out = await search(cfg, { query: "fox", limit: 5 });
  expect(out.warnings.some((w) => w.startsWith("hybrid_degraded:"))).toBe(false);
});
