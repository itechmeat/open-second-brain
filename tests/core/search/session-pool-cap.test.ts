/**
 * The per-source-session pool cap (t_bb6ce095): a pure phase over ranked
 * rows that bounds how many rows one SOURCE import session may
 * contribute to the pool the diversity rerank and the caller's window
 * draw from.
 *
 * "Source session" is the import that produced a note, never the
 * caller's conversation: imported signal notes carry `session_ref`
 * frontmatter and handoff notes carry `session_id`. Identity is read
 * through the per-call frontmatter cache the assemble stage already
 * builds, so the cap adds no new read shape to the pipeline. Rows
 * without identity and rows whose file could not be read pass through
 * uncapped, mirroring the `duplicateKey` null handling.
 */

import { afterEach, expect, test } from "bun:test";

import { applySessionPoolCap } from "../../../src/core/search/pipeline/session-pool-cap.ts";
import { type FrontmatterCache } from "../../../src/core/search/result-filters.ts";
import type { BrainSearchResult } from "../../../src/core/search/types.ts";
import { createTempVault, writeMd } from "../../helpers/search-fixtures.ts";

let nextId = 1;
function res(path: string, score: number): BrainSearchResult {
  const id = nextId++;
  return Object.freeze({
    documentId: id,
    chunkId: id,
    path,
    title: `Doc ${id}`,
    content: `body ${id}`,
    startLine: 1,
    endLine: 1,
    score,
    keywordScore: score,
    semanticScore: 0,
    linkBoost: 0,
    recencyBoost: 0,
    searchType: "keyword" as const,
    reasons: Object.freeze([`fts5_bm25: ${score.toFixed(3)}`]),
  });
}

let vault = "";
let cleanup: () => void = () => {};

/** A vault exercising every identity side the cap distinguishes. */
function seedVault(): string {
  const v = createTempVault("session-pool-cap");
  vault = v.vault;
  cleanup = v.cleanup;
  writeMd(vault, "a-1.md", "---\ntitle: A1\nsession_ref: sess-a\n---\n\nbody\n");
  writeMd(vault, "a-2.md", "---\ntitle: A2\nsession_ref: sess-a\n---\n\nbody\n");
  writeMd(vault, "a-3.md", "---\ntitle: A3\nsession_ref: sess-a\n---\n\nbody\n");
  writeMd(vault, "b-1.md", "---\ntitle: B1\nsession_ref: sess-b\n---\n\nbody\n");
  writeMd(vault, "b-2.md", "---\ntitle: B2\nsession_ref: sess-b\n---\n\nbody\n");
  writeMd(vault, "h-1.md", "---\ntitle: H1\nsession_id: handoff-1\n---\n\nbody\n");
  writeMd(vault, "h-2.md", "---\ntitle: H2\nsession_id: handoff-1\n---\n\nbody\n");
  writeMd(vault, "plain-1.md", "---\ntitle: P1\n---\n\nbody\n");
  writeMd(vault, "plain-2.md", "---\ntitle: P2\n---\n\nbody\n");
  // An empty string and a non-string are both ABSENT identity: only a
  // non-empty string names a session.
  writeMd(vault, "empty-ref.md", '---\ntitle: E\nsession_ref: ""\n---\n\nbody\n');
  writeMd(vault, "numeric-ref.md", "---\ntitle: N\nsession_ref: 42\n---\n\nbody\n");
  return vault;
}

afterEach(() => cleanup());

test("ranked order is preserved and only the first rows per session survive", () => {
  const v = seedVault();
  const input = [
    res("a-1.md", 0.9),
    res("a-2.md", 0.8),
    res("b-1.md", 0.7),
    res("a-3.md", 0.6),
    res("plain-1.md", 0.5),
  ];

  const out = applySessionPoolCap(input, {
    vault: v,
    capPerSession: 2,
    frontmatterCache: new Map(),
  });

  expect(out.results.map((r) => r.path)).toEqual(["a-1.md", "a-2.md", "b-1.md", "plain-1.md"]);
  expect(out.dropped).toBe(1);
});

test("rows carrying only session_id group by it", () => {
  const v = seedVault();
  const input = [res("h-1.md", 0.9), res("h-2.md", 0.8), res("plain-1.md", 0.7)];

  const out = applySessionPoolCap(input, {
    vault: v,
    capPerSession: 1,
    frontmatterCache: new Map(),
  });

  expect(out.results.map((r) => r.path)).toEqual(["h-1.md", "plain-1.md"]);
  expect(out.dropped).toBe(1);
});

test("session_ref wins over session_id when a row carries both", () => {
  const v = seedVault();
  writeMd(v, "both.md", "---\ntitle: B\nsession_ref: sess-a\nsession_id: handoff-1\n---\n\nbody\n");
  const input = [res("both.md", 0.9), res("a-1.md", 0.8), res("h-1.md", 0.7)];

  const out = applySessionPoolCap(input, {
    vault: v,
    capPerSession: 1,
    frontmatterCache: new Map(),
  });

  // `both` and `a-1` share sess-a, so the second drops; the session_id
  // row is a different session and survives.
  expect(out.results.map((r) => r.path)).toEqual(["both.md", "h-1.md"]);
  expect(out.dropped).toBe(1);
});

test("no-identity rows and unreadable files pass through uncapped", () => {
  const v = seedVault();
  // `ghost.md` is not on disk, so its frontmatter read is unreadable -
  // the cap knows nothing about it and must not guess an identity.
  const input = [res("plain-1.md", 0.9), res("plain-2.md", 0.8), res("ghost.md", 0.7)];

  const out = applySessionPoolCap(input, {
    vault: v,
    capPerSession: 1,
    frontmatterCache: new Map(),
  });

  expect(out.results.map((r) => r.path)).toEqual(["plain-1.md", "plain-2.md", "ghost.md"]);
  expect(out.dropped).toBe(0);
});

test("an empty or non-string frontmatter value counts as absent identity", () => {
  const v = seedVault();
  const input = [res("empty-ref.md", 0.9), res("numeric-ref.md", 0.8)];

  const out = applySessionPoolCap(input, {
    vault: v,
    capPerSession: 1,
    frontmatterCache: new Map(),
  });

  expect(out.results.map((r) => r.path)).toEqual(["empty-ref.md", "numeric-ref.md"]);
  expect(out.dropped).toBe(0);
});

test("the drop count sums across sessions", () => {
  const v = seedVault();
  const input = [
    res("a-1.md", 0.9),
    res("a-2.md", 0.8),
    res("a-3.md", 0.7),
    res("b-1.md", 0.6),
    res("b-2.md", 0.5),
  ];

  const out = applySessionPoolCap(input, {
    vault: v,
    capPerSession: 1,
    frontmatterCache: new Map(),
  });

  expect(out.results.map((r) => r.path)).toEqual(["a-1.md", "b-1.md"]);
  expect(out.dropped).toBe(3);
});

test("the phase is pure: same inputs, same outputs, reads only through the cache", () => {
  const v = seedVault();
  const input = [res("a-1.md", 0.9), res("a-2.md", 0.8), res("b-1.md", 0.7), res("a-3.md", 0.6)];
  const cache: FrontmatterCache = new Map();

  const first = applySessionPoolCap(input, { vault: v, capPerSession: 2, frontmatterCache: cache });
  const warmed = applySessionPoolCap(input, {
    vault: v,
    capPerSession: 2,
    frontmatterCache: cache,
  });
  const fresh = applySessionPoolCap(input, {
    vault: v,
    capPerSession: 2,
    frontmatterCache: new Map(),
  });

  // Survivors are the input rows themselves, in order - not copies.
  expect(first.results[0]).toBe(input[0]);
  expect(first.results[1]).toBe(input[1]);
  expect(first.results.map((r) => r.path)).toEqual(["a-1.md", "a-2.md", "b-1.md"]);
  expect(first.dropped).toBe(1);
  // A warm cache answers identically, and a cold cache reaches the same
  // rows: the only cache effect is the read-through fill.
  expect(warmed).toEqual(first);
  expect(fresh).toEqual(first);
  expect(cache.get("a-1.md")?.meta["session_ref"]).toBe("sess-a");
});
