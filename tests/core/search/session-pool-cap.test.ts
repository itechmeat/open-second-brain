/**
 * The per-source-session pool cap (t_bb6ce095): a pure phase over ranked
 * rows that bounds how many rows one group may contribute to the
 * filtered pool the caller's window is cut from.
 *
 * A row's group key is its SOURCE import session when the note states
 * one - `session_ref` frontmatter on imported signal notes, `session_id`
 * on handoff notes - and the row's own PATH otherwise. The fallback is
 * the review fix (M2): the crowding the cap was built to measure comes
 * from material that carries no session frontmatter at all (bench
 * session notes, and the several chunks of one long note), so grouping
 * by frontmatter alone capped nothing there. Identity is read through
 * the per-call frontmatter cache the assemble stage already builds, so
 * the cap adds no new read shape to the pipeline.
 */

import { afterEach, expect, test } from "bun:test";

import {
  applySessionPoolCap,
  resolveSessionPoolCap,
} from "../../../src/core/search/pipeline/session-pool-cap.ts";
import { SearchError } from "../../../src/core/search/types.ts";
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
  writeMd(vault, "empty-ref-2.md", '---\ntitle: E2\nsession_ref: ""\n---\n\nbody\n');
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

test("rows without frontmatter identity group by path, so chunks of one note share a group", () => {
  const v = seedVault();
  // Two chunks of one frontmatter-less note (distinct chunk ids, one
  // path) beside a chunk of another: the path fallback is the group, so
  // the cap keeps one chunk per note.
  const first = res("plain-1.md", 0.9);
  const third = res("plain-2.md", 0.7);
  const input = [first, res("plain-1.md", 0.8), third];

  const out = applySessionPoolCap(input, {
    vault: v,
    capPerSession: 1,
    frontmatterCache: new Map(),
  });

  expect(out.results).toEqual([first, third]);
  expect(out.dropped).toBe(1);
});

test("distinct frontmatter-less notes are distinct path groups", () => {
  const v = seedVault();
  const input = [res("plain-1.md", 0.9), res("plain-2.md", 0.8), res("plain-3.md", 0.7)];

  const out = applySessionPoolCap(input, {
    vault: v,
    capPerSession: 1,
    frontmatterCache: new Map(),
  });

  expect(out.results.map((r) => r.path)).toEqual(["plain-1.md", "plain-2.md", "plain-3.md"]);
  expect(out.dropped).toBe(0);
});

test("a session value that begins with the path prefix stays in its own key space", () => {
  const v = seedVault();
  // The session value is literally the fallback key of another note: the
  // two kinds must never fuse regardless of the value, or this session's
  // quota would be spent on the unrelated note's chunks.
  writeMd(v, "trap.md", '---\ntitle: T\nsession_ref: "path:plain-1.md"\n---\n\nbody\n');
  const firstChunk = res("plain-1.md", 0.8);
  const input = [res("trap.md", 0.9), firstChunk, res("plain-1.md", 0.7)];

  const out = applySessionPoolCap(input, {
    vault: v,
    capPerSession: 1,
    frontmatterCache: new Map(),
  });

  // `trap` is its own session group; the two plain-1 chunks are the
  // note's own path group - so the second chunk drops, not both.
  expect(out.results.map((r) => r.path)).toEqual(["trap.md", "plain-1.md"]);
  expect(out.results[1]).toBe(firstChunk);
  expect(out.dropped).toBe(1);
});

test("an unreadable file's rows group by its path too", () => {
  const v = seedVault();
  // `ghost.md` is not on disk, so its frontmatter read is unreadable -
  // but the path is still a real identity, and the two ghost chunks are
  // one group for the same reason chunks of one readable note are.
  const first = res("ghost.md", 0.9);
  const third = res("plain-1.md", 0.7);
  const input = [first, res("ghost.md", 0.8), third];

  const out = applySessionPoolCap(input, {
    vault: v,
    capPerSession: 1,
    frontmatterCache: new Map(),
  });

  expect(out.results).toEqual([first, third]);
  expect(out.dropped).toBe(1);
});

test("an empty or non-string frontmatter value falls back to the path group", () => {
  const v = seedVault();
  // The empty-identity rows sit BESIDE capped rows: each names no
  // session, so each is its own path group and survives past the cap -
  // while the real sess-a rows are capped to one. A non-string value is
  // absent identity the same way.
  const input = [
    res("empty-ref.md", 0.9),
    res("empty-ref-2.md", 0.85),
    res("a-1.md", 0.8),
    res("a-2.md", 0.7),
    res("numeric-ref.md", 0.6),
  ];

  const out = applySessionPoolCap(input, {
    vault: v,
    capPerSession: 1,
    frontmatterCache: new Map(),
  });

  expect(out.results.map((r) => r.path)).toEqual([
    "empty-ref.md",
    "empty-ref-2.md",
    "a-1.md",
    "numeric-ref.md",
  ]);
  expect(out.dropped).toBe(1);
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

test("the widest group's occupancy is reported for the re-widen contract", () => {
  const v = seedVault();
  // Three rows in one session beside a lone path-grouped row: the width
  // the M3 re-widen needs is computed from the heaviest group the pass
  // observed, dropped-from or not.
  const out = applySessionPoolCap(
    [res("a-1.md", 0.9), res("a-2.md", 0.8), res("a-3.md", 0.7), res("plain-1.md", 0.6)],
    { vault: v, capPerSession: 2, frontmatterCache: new Map() },
  );
  expect(out.widestGroupRows).toBe(3);

  const uncrowded = applySessionPoolCap([res("a-1.md", 0.9), res("b-1.md", 0.8)], {
    vault: v,
    capPerSession: 2,
    frontmatterCache: new Map(),
  });
  expect(uncrowded.widestGroupRows).toBe(1);
});

test("a fractional, negative or non-finite cap value is refused by name", () => {
  // The per-query override used to bypass the config validation, so 1.5
  // turned the cap on with a fractional comparison and NaN read as off.
  // The same named refusal the config key gets, at the read site.
  expect(() => resolveSessionPoolCap(1.5)).toThrow(SearchError);
  expect(() => resolveSessionPoolCap(1.5)).toThrow(/poolMaxPerSession/);
  expect(() => resolveSessionPoolCap(-1)).toThrow(/poolMaxPerSession.*>= 0/);
  expect(() => resolveSessionPoolCap(Number.NaN)).toThrow(/poolMaxPerSession.*finite/);
  expect(() => resolveSessionPoolCap(Number.POSITIVE_INFINITY)).toThrow(/poolMaxPerSession/);
  // The off value and a positive integer stay legal.
  expect(resolveSessionPoolCap(0)).toBe(0);
  expect(resolveSessionPoolCap(2)).toBe(2);
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
