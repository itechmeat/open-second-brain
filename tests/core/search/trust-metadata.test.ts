/**
 * Inline trust metadata (Search & Recall Quality Suite): with `trust`
 * set, each hit carries a computed-at-read-time `trust` object - age in
 * days plus the superseded / conflict flags read from the surfaced typed
 * relations. Off by default keeps the result shape byte-identical.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("trust-metadata"));
});
afterEach(() => cleanup());

const OLD_PAGE = [
  "---",
  "title: Old deploy decision",
  'superseded_by: "[[new-deploy]]"',
  "---",
  "# Old deploy decision",
  "",
  "We deploy with the blue-green rollout strategy on fridays.",
].join("\n");

const NEW_PAGE = [
  "---",
  "title: New deploy decision",
  "---",
  "# New deploy decision",
  "",
  "Deployment notes for the canary path.",
].join("\n");

test("no trust field by default", async () => {
  writeMd(vault, "plain.md", "# Plain\n\nThe quick brown fox jumps over the lazy dog.");
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg);
  const out = await search(cfg, { query: "fox", limit: 5 });
  expect(out.results.length).toBeGreaterThan(0);
  for (const r of out.results) expect(r.trust).toBeUndefined();
});

test("trust stamps age and a neutral status on a plain recent hit", async () => {
  writeMd(vault, "plain.md", "# Plain\n\nThe quick brown fox jumps over the lazy dog.");
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg);
  const out = await search(cfg, { query: "fox", limit: 5, trust: true });
  const hit = out.results.find((r) => r.path === "plain.md")!;
  expect(hit.trust).toBeDefined();
  expect(hit.trust!.age_days).toBeGreaterThanOrEqual(0);
  expect(hit.trust!.superseded).toBe(false);
  expect(hit.trust!.conflict).toBe(false);
});

test("trust marks a superseded predecessor", async () => {
  writeMd(vault, "old.md", OLD_PAGE);
  writeMd(vault, "new-deploy.md", NEW_PAGE);
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg);
  const out = await search(cfg, {
    query: "blue-green rollout strategy",
    limit: 5,
    trust: true,
    includeSuperseded: true,
  });
  const old = out.results.find((r) => r.path === "old.md")!;
  expect(old.trust).toBeDefined();
  expect(old.trust!.superseded).toBe(true);
});
