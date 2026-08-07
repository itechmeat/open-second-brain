/**
 * Exact-duplicate passage merge (what-the-index-already-knew, task D).
 *
 * `chunks.content_hash` has been written on every chunk since schema v1
 * and never read back. Two byte-identical passages therefore occupied two
 * result slots: MMR demoted the second one, but demotion still costs a
 * slot in the caller's window. The merge folds them into one row that
 * names every location the passage was found at, and it runs before the
 * diversity rerank so the quadratic Jaccard loop sees the shrunken pool.
 *
 * What must NOT change: a near-duplicate (different bytes, different
 * hash) is untouched and still handled by MMR; two distinct passages in
 * one file stay two rows; a corpus with no duplicates produces rows that
 * carry no `duplicates` key at all.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";
import type { BrainSearchResult, ResolvedSearchConfig } from "../../../src/core/search/types.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  const v = createTempVault("duplicate-passage-merge");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
});

afterEach(() => {
  cleanup();
});

/** The passage duplicated verbatim across files in the tests below. */
const PASSAGE =
  "# Quantum entanglement\n\n" +
  "Quantum entanglement links two particles so that measuring one fixes " +
  "the other, regardless of the distance separating them. The correlation " +
  "is not a signal and carries no information on its own.\n";

async function indexed(overrides: Partial<Parameters<typeof makeConfig>[0]> = {}) {
  const cfg: ResolvedSearchConfig = makeConfig({ vault, dbPath, ...overrides });
  await indexVault(cfg);
  return cfg;
}

function locations(r: BrainSearchResult): ReadonlyArray<string> {
  return (r.duplicates ?? []).map((d) => d.path);
}

test("two byte-identical passages in two files return one row naming both locations", async () => {
  writeMd(vault, "physics/entanglement.md", PASSAGE);
  writeMd(vault, "archive/entanglement-copy.md", PASSAGE);
  const cfg = await indexed();

  const outcome = await search(cfg, { query: "quantum entanglement", limit: 10 });
  const hits = outcome.results.filter(
    (r) => r.path.endsWith("entanglement.md") || r.path.endsWith("entanglement-copy.md"),
  );

  expect(hits.length).toBe(1);
  const survivor = hits[0]!;
  const named = [survivor.path, ...locations(survivor)].toSorted();
  expect(named).toEqual(["archive/entanglement-copy.md", "physics/entanglement.md"]);
  expect(survivor.duplicates![0]!.startLine).toBeGreaterThan(0);
  expect(survivor.duplicates![0]!.chunkId).not.toBe(survivor.chunkId);
});

test("the same passage at three paths is reported as three locations on one row", async () => {
  writeMd(vault, "a/entanglement.md", PASSAGE);
  writeMd(vault, "b/entanglement.md", PASSAGE);
  writeMd(vault, "c/entanglement.md", PASSAGE);
  const cfg = await indexed();

  const outcome = await search(cfg, { query: "quantum entanglement", limit: 10 });
  expect(outcome.results.length).toBe(1);
  const survivor = outcome.results[0]!;
  expect([survivor.path, ...locations(survivor)].toSorted()).toEqual([
    "a/entanglement.md",
    "b/entanglement.md",
    "c/entanglement.md",
  ]);
});

/** A section long enough to become a chunk of its own at chunkSize 800. */
function section(label: string): string {
  return `## ${label}\n\n` + `Quantum ${label} is discussed here at length. `.repeat(20) + "\n";
}

test("two distinct passages from one file still return two rows", async () => {
  // chunkSize 800 / chunkMinSize 100: two sections well past the minimum
  // split into two chunks of the same document.
  writeMd(vault, "physics/notes.md", `${section("superposition")}\n${section("decoherence")}\n`);
  const cfg = await indexed();

  const outcome = await search(cfg, { query: "quantum", limit: 10 });
  const rows = outcome.results.filter((r) => r.path === "physics/notes.md");
  expect(rows.length).toBeGreaterThan(1);
  for (const r of rows) expect(r.duplicates).toBeUndefined();
});

test("a near-duplicate has a different hash, is not merged, and both rows survive", async () => {
  writeMd(vault, "physics/entanglement.md", PASSAGE);
  // One word differs: different bytes, different sha256, no merge.
  writeMd(vault, "archive/entanglement-near.md", PASSAGE.replace("particles", "photons"));
  const cfg = await indexed();

  const outcome = await search(cfg, { query: "quantum entanglement", limit: 10 });
  const paths = outcome.results.map((r) => r.path).toSorted();
  expect(paths).toEqual(["archive/entanglement-near.md", "physics/entanglement.md"]);
  for (const r of outcome.results) expect(r.duplicates).toBeUndefined();
});

test("two records sharing a body but not their frontmatter are two rows, not one", async () => {
  // Frontmatter is stripped before chunking, so these two chunks hash
  // identically - but they are distinct records, and the ranker scores
  // them differently on the strength of exactly the frontmatter the chunk
  // hash cannot see. The document hash is what keeps them apart.
  writeMd(vault, "left.md", `---\ntitle: Left\nfreshness_trend: stable\n---\n\n${PASSAGE}`);
  writeMd(vault, "right.md", `---\ntitle: Right\nfreshness_trend: weakening\n---\n\n${PASSAGE}`);
  const cfg = await indexed();

  const outcome = await search(cfg, { query: "quantum entanglement", limit: 10 });
  expect(outcome.results.map((r) => r.path).toSorted()).toEqual(["left.md", "right.md"]);
  for (const r of outcome.results) expect(r.duplicates).toBeUndefined();
});

test("a corpus with no duplicates carries no duplicates key on any row", async () => {
  writeMd(vault, "one.md", "# Alpha\n\nQuantum alpha notes about the first topic entirely.\n");
  writeMd(vault, "two.md", "# Beta\n\nQuantum beta notes about the second topic entirely.\n");
  const cfg = await indexed();

  const outcome = await search(cfg, { query: "quantum notes", limit: 10 });
  expect(outcome.results.length).toBe(2);
  for (const r of outcome.results) {
    // Absent, not present-and-empty: the key is missing from the row and
    // from the bytes any surface would serialize it to.
    expect(Object.hasOwn(r, "duplicates")).toBe(false);
    expect(JSON.stringify(r)).not.toContain("duplicates");
  }
});

/**
 * Window sizes the shortfall is checked at: at both, the two duplicates
 * are the top-ranked candidates and fill part of a pool capped at `limit`.
 */
const LIMITS_UNDER_TEST = [2, 3] as const;

/** A weaker match: the query terms occur once, buried in unrelated prose. */
function weakMatch(label: string): string {
  const filler = "Assorted laboratory bookkeeping and scheduling minutes for the reading group. ";
  return `# Reading group ${label}\n\n${filler.repeat(12)}One quantum entanglement item, ${label}.\n`;
}

test("a limit-N request over a pool holding duplicates still returns N rows", async () => {
  // MMR and traversal off: the rank pool collapses to exactly `limit`, so
  // the two top-ranked duplicates fill the whole window and merging them
  // shrinks the answer below `limit` unless the pool widens and re-runs.
  writeMd(vault, "dup-one.md", PASSAGE);
  writeMd(vault, "dup-two.md", PASSAGE);
  writeMd(vault, "other-a.md", weakMatch("alpha"));
  writeMd(vault, "other-b.md", weakMatch("beta"));
  const cfg = await indexed({ mmrLambda: 1, maxHops: 0 });

  const outcomes = await Promise.all(
    LIMITS_UNDER_TEST.map((limit) => search(cfg, { query: "quantum entanglement", limit })),
  );
  for (const [i, outcome] of outcomes.entries()) {
    const limit = LIMITS_UNDER_TEST[i]!;
    expect(outcome.results.length).toBe(limit);
    expect(new Set(outcome.results.map((r) => r.chunkId)).size).toBe(limit);
  }
});
