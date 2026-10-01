/**
 * Relational rerank pin (t_d9f863e9): the opt-in
 * `search_relational_rerank_pin` config key expresses the pin at the
 * cross-encoder hand-off through a protect rule - rerank may PROMOTE
 * relational-origin candidates, never SINK them below their pre-rerank
 * heuristic order - without a second floor beside `minScore`, which keeps
 * applying unchanged.
 *
 * Pinned here:
 *   - a relational-origin candidate (the typed-edge arm contributed it)
 *     never lands below its pre-rerank position when the pin is on; it may
 *     rise, and rows the pin moved carry a reason naming the floor;
 *   - the pin off keeps rerank behavior byte-identical;
 *   - the key resolves off by default through `resolveSearchConfig`.
 */

import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyRelationalRerankPin } from "../../../src/core/search/pipeline/relational-arm.ts";
import { resolveSearchConfig } from "../../../src/core/search/index.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";
import type { BrainSearchResult } from "../../../src/core/search/search-result.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Pure protect rule
// ─────────────────────────────────────────────────────────────────────────────

function row(chunkId: number, relational: boolean, reasons: string[] = []): BrainSearchResult {
  return Object.freeze({
    documentId: chunkId * 10,
    chunkId,
    path: `doc${chunkId}.md`,
    title: null,
    content: `chunk ${chunkId}`,
    startLine: 1,
    endLine: 1,
    score: 1,
    keywordScore: 0,
    semanticScore: 0,
    linkBoost: 0,
    recencyBoost: 0,
    searchType: "link",
    ...(relational ? { relationalOrigin: true } : {}),
    reasons: Object.freeze([...reasons]),
  });
}

test("a sunk relational-origin candidate is floored at its pre-rerank position", () => {
  const pre = [row(1, true), row(2, false)];
  const post = [row(2, false), row(1, true)]; // the cross-encoder sank candidate 1
  const pinned = applyRelationalRerankPin(pre, post);
  expect(pinned.map((r) => r.chunkId)).toEqual([1, 2]);
  const moved = pinned.find((r) => r.chunkId === 1)!;
  expect(moved.reasons).toContain("relational_pin: floored at pre-rerank position 0");
});

test("a risen relational-origin candidate is left alone and gains no pin reason", () => {
  const pre = [row(1, false), row(2, true)];
  const post = [row(2, true), row(1, false)]; // the cross-encoder promoted candidate 2
  const pinned = applyRelationalRerankPin(pre, post);
  expect(pinned.map((r) => r.chunkId)).toEqual([2, 1]);
  expect(pinned[0]!.reasons.some((r) => r.startsWith("relational_pin:"))).toBe(false);
});

test("non-relational rows keep the rerank order around the floors", () => {
  const pre = [row(1, false), row(2, true), row(3, false), row(4, true)];
  const post = [row(3, false), row(1, false), row(4, true), row(2, true)];
  const pinned = applyRelationalRerankPin(pre, post);
  // Candidate 2 (floor 1) and candidate 4 (floor 3) may not pass their
  // floors; the rest stays in rerank order as far as the floors allow.
  // Candidate 4 already sits exactly at its floor, so only candidate 2 moves.
  expect(pinned.map((r) => r.chunkId)).toEqual([3, 2, 1, 4]);
  expect(pinned[1]!.reasons).toContain("relational_pin: floored at pre-rerank position 1");
  expect(pinned[3]!.reasons.some((r) => r.startsWith("relational_pin:"))).toBe(false);
});

test("deeply sunk candidates are lifted past later floors in pre-rerank order", () => {
  const pre = [row(1, true), row(2, true), row(3, false)];
  const post = [row(3, false), row(2, true), row(1, true)];
  const pinned = applyRelationalRerankPin(pre, post);
  // Both floors hold: candidate 1 at index <= 0, candidate 2 at index <= 1.
  expect(pinned.map((r) => r.chunkId)).toEqual([1, 2, 3]);
  expect(pinned[0]!.reasons).toContain("relational_pin: floored at pre-rerank position 0");
  expect(pinned[1]!.reasons).toContain("relational_pin: floored at pre-rerank position 1");
});

test("an already-satisfied pool is returned in the rerank order untouched", () => {
  const pre = [row(1, true), row(2, false)];
  const post = [row(1, true), row(2, false)];
  const pinned = applyRelationalRerankPin(pre, post);
  expect(pinned.map((r) => r.chunkId)).toEqual([1, 2]);
  for (const r of pinned) {
    expect(r.reasons.some((x) => x.startsWith("relational_pin:"))).toBe(false);
  }
});

test("a pool with no relational-origin rows is the rerank order unchanged", () => {
  const pre = [row(1, false), row(2, false)];
  const post = [row(2, false), row(1, false)];
  expect(applyRelationalRerankPin(pre, post).map((r) => r.chunkId)).toEqual([2, 1]);
});

// ─────────────────────────────────────────────────────────────────────────────
// Config resolution (default off)
// ─────────────────────────────────────────────────────────────────────────────

let tmp: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-rel-pin-"));
  configPath = join(tmp, "config.yaml");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("search_relational_rerank_pin resolves, default off", () => {
  writeFileSync(configPath, `vault: ${tmp}\n`);
  const cfg = resolveSearchConfig({ vault: tmp, configPath });
  // Absent reads as off: the resolved rerank config keeps its exact shipped
  // shape when the knob is unset (pinned by rerank.config.test.ts), and
  // every consumer reads the pin through `=== true`.
  expect(cfg.rerank.relationalRerankPin === true).toBe(false);
});

test("search_relational_rerank_pin: true resolves onto the rerank config", () => {
  writeFileSync(configPath, `vault: ${tmp}\nsearch_relational_rerank_pin: true\n`);
  const cfg = resolveSearchConfig({ vault: tmp, configPath });
  expect(cfg.rerank.relationalRerankPin).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// End to end: the cross-encoder buries a relational hit; the pin floors it
// ─────────────────────────────────────────────────────────────────────────────

let vault: string;
let dbPath: string;
let cleanup: () => void;

const realFetch = globalThis.fetch;

/** Stub the rerank endpoint: passages matching `winner` score high, the rest ~0. */
function stubRerankFetch(winner: string): void {
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { documents: string[] };
    const results = body.documents.map((doc, index) => ({
      index,
      relevance_score: doc.includes(winner) ? 0.99 : 0.01,
    }));
    return new Response(JSON.stringify({ results }), { status: 200 });
  }) as unknown as typeof fetch;
}

/**
 * hub --related--> neighbor --extends--> far. The query is
 * relationship-shaped ([[hub]] + the edge token) but lexically EMPTY: no
 * body contains the seed or the edge token, so both reached nodes are
 * relational-only candidates the keyword lane never voted for. neighbor is
 * fresh, so the heuristic order puts it first.
 */
async function build(): Promise<void> {
  const v = createTempVault("relational-rerank-pin");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
  // Both hops are `related`, so the single edge token in the query reaches
  // the depth-2 node: hub --related--> neighbor --related--> far. No body
  // contains the seed or the edge token, so the keyword lane stays empty.
  writeMd(
    vault,
    "hub.md",
    ["---", 'related: "[[neighbor]]"', "---", "", "zulu qque bravo document."].join("\n"),
  );
  writeMd(
    vault,
    "neighbor.md",
    ["---", 'related: "[[far]]"', "---", "", "# Neighbor", "", "beta divergent passage here."].join(
      "\n",
    ),
  );
  writeMd(vault, "far.md", "# Far\n\ngamma distant passage.");
  await indexVault(makeConfig({ vault, dbPath }));
}

const RERANK_ENABLED = {
  enabled: true,
  baseUrl: "https://api.example.com/v1",
  model: "rerank-1",
  apiKey: "secret",
  topK: 10,
} as const;

test("pin on: the cross-encoder cannot sink the relational hit below its heuristic position", async () => {
  await build();
  try {
    const base = {
      fusionMode: "rrf" as const,
      relationalArmEnabled: true,
      rerank: RERANK_ENABLED,
    };
    // The heuristic order (the endpoint fails -> rerank degrades to it):
    // the freshly-written relational hit leads.
    globalThis.fetch = (async () =>
      new Response("boom", { status: 503 })) as unknown as typeof fetch;
    const heuristic = await search(makeConfig({ vault, dbPath, ...base }), {
      query: "[[hub]] related",
    });
    expect(heuristic.results[0]!.path).toBe("neighbor.md");
    // The cross-encoder prefers the far node and buries the relational hit.
    stubRerankFetch("gamma");
    const buried = await search(makeConfig({ vault, dbPath, ...base }), {
      query: "[[hub]] related",
    });
    expect(buried.results[0]!.path).toBe("far.md");
    // Pin on: the same rerank scores, but the relational hit holds its line.
    const pinned = await search(
      makeConfig({
        vault,
        dbPath,
        ...base,
        rerank: { ...RERANK_ENABLED, relationalRerankPin: true },
      }),
      { query: "[[hub]] related" },
    );
    expect(pinned.results[0]!.path).toBe("neighbor.md");
    expect(pinned.results[0]!.reasons).toContain(
      "relational_pin: floored at pre-rerank position 0",
    );
  } finally {
    globalThis.fetch = realFetch;
    cleanup();
  }
});

test("pin on: a relational hit the cross-encoder genuinely prefers may rise", async () => {
  await build();
  try {
    const base = {
      fusionMode: "rrf" as const,
      relationalArmEnabled: true,
      rerank: { ...RERANK_ENABLED, relationalRerankPin: true },
    };
    stubRerankFetch("beta");
    const pinned = await search(makeConfig({ vault, dbPath, ...base }), {
      query: "[[hub]] related",
    });
    expect(pinned.results[0]!.path).toBe("neighbor.md");
    expect(pinned.results[0]!.reasons.some((r) => r.startsWith("relational_pin:"))).toBe(false);
    expect(pinned.results[0]!.reasons.some((r) => r.startsWith("cross_encoder:"))).toBe(true);
  } finally {
    globalThis.fetch = realFetch;
    cleanup();
  }
});

/** The path/score/reasons projection two runs compare byte for byte. */
const project = (o: Awaited<ReturnType<typeof search>>) =>
  o.results.map((r) => ({ path: r.path, score: r.score, reasons: r.reasons }));

test("pin off keeps rerank behavior byte-identical", async () => {
  await build();
  try {
    const base = {
      fusionMode: "rrf" as const,
      relationalArmEnabled: true,
      rerank: RERANK_ENABLED,
    };
    stubRerankFetch("gamma");
    // One frozen clock across both calls: recency decay is a continuous
    // function of wall-clock time, and two real Date.now() reads would
    // perturb the low-order digits of `score` for reasons that have
    // nothing to do with the pin under test.
    const nowMs = Date.now();
    const dateNowSpy = spyOn(Date, "now").mockReturnValue(nowMs);
    let absent: Awaited<ReturnType<typeof search>>;
    let off: Awaited<ReturnType<typeof search>>;
    try {
      absent = await search(makeConfig({ vault, dbPath, ...base }), {
        query: "[[hub]] related",
      });
      off = await search(
        makeConfig({
          vault,
          dbPath,
          ...base,
          rerank: { ...RERANK_ENABLED, relationalRerankPin: false },
        }),
        { query: "[[hub]] related" },
      );
    } finally {
      dateNowSpy.mockRestore();
    }
    expect(project(off)).toEqual(project(absent));
  } finally {
    globalThis.fetch = realFetch;
    cleanup();
  }
});
