import { test, expect, afterEach } from "bun:test";

import {
  containsCjk,
  extractTrigramTerms,
  isLowSelectivity,
  planTrigramPrefilter,
} from "../../../src/core/search/trigram-prefilter.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/index.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

// ─── pure planner ────────────────────────────────────────────────────────────

test("planTrigramPrefilter skips a short query (no term >= 3 chars)", () => {
  expect(planTrigramPrefilter("a b cd").mode).toBe("skip");
  const plan = planTrigramPrefilter("ab");
  expect(plan).toEqual({ mode: "skip", reason: "short" });
});

test("planTrigramPrefilter skips a CJK query", () => {
  expect(planTrigramPrefilter("日本語").mode).toBe("skip");
  expect(planTrigramPrefilter("mix 日本").mode).toBe("skip");
  expect(containsCjk("hello")).toBe(false);
});

test("planTrigramPrefilter builds a conjunctive FTS query for qualifying terms", () => {
  const plan = planTrigramPrefilter("Hello World");
  expect(plan.mode).toBe("match");
  if (plan.mode !== "match") throw new Error("expected match");
  expect(plan.terms).toEqual(["hello", "world"]);
  expect(plan.ftsQuery).toBe('"hello" AND "world"');
});

test("extractTrigramTerms drops sub-trigram tokens", () => {
  expect(extractTrigramTerms("go to the sea")).toEqual(["the", "sea"]);
});

test("isLowSelectivity compares candidate fraction to the threshold", () => {
  expect(isLowSelectivity(60, 100, 0.5)).toBe(true);
  expect(isLowSelectivity(40, 100, 0.5)).toBe(false);
  expect(isLowSelectivity(5, 0, 0.5)).toBe(false);
});

// ─── integration: strict-superset + fallback ─────────────────────────────────

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

async function fixture() {
  const v = createTempVault("trigram");
  cleanups.push(v.cleanup);
  // "reindexing" contains the substring "index" but the word tokenizer
  // stores it as one token, so a keyword MATCH on "index" misses it.
  writeMd(v.vault, "a.md", "# Ops\n\nReindexing the vault can be slow on large corpora.");
  writeMd(v.vault, "b.md", "# Turtles\n\nGreen turtles migrate across oceans.");
  return v;
}

test("enabled trigram prefilter surfaces a substring match the keyword lane misses", async () => {
  const v = await fixture();
  const off = makeConfig({ vault: v.vault, dbPath: v.dbPath });
  await indexVault(off, {});

  const disabled = await search(off, { query: "index", limit: 10 });
  const enabledCfg = makeConfig({
    vault: v.vault,
    dbPath: v.dbPath,
    trigramPrefilterEnabled: true,
    trigramPrefilterMinChunks: 0,
  });
  const enabled = await search(enabledCfg, { query: "index", limit: 10 });

  const disabledPaths = new Set(disabled.results.map((r) => r.path));
  const enabledPaths = new Set(enabled.results.map((r) => r.path));

  // Strict superset: every disabled result is still present when enabled.
  for (const p of disabledPaths) expect(enabledPaths.has(p)).toBe(true);
  // And the substring-only document now surfaces (it did not before).
  expect(disabledPaths.has("a.md")).toBe(false);
  expect(enabledPaths.has("a.md")).toBe(true);
});

test("short and CJK queries fall back (byte-identical to disabled)", async () => {
  const v = await fixture();
  const enabledCfg = makeConfig({
    vault: v.vault,
    dbPath: v.dbPath,
    trigramPrefilterEnabled: true,
    trigramPrefilterMinChunks: 0,
  });
  await indexVault(enabledCfg, {});
  const offCfg = makeConfig({ vault: v.vault, dbPath: v.dbPath });

  for (const q of ["ab", "海"]) {
    const on = await search(enabledCfg, { query: q, limit: 10 });
    const off = await search(offCfg, { query: q, limit: 10 });
    expect(on.results.map((r) => r.path)).toEqual(off.results.map((r) => r.path));
  }
});
