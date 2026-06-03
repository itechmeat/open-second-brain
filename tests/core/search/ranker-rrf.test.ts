import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { rankResults } from "../../../src/core/search/ranker.ts";
import { resolveSearchConfig, SearchError } from "../../../src/core/search/index.ts";
import type { KeywordHit, SemanticHit, HydratedChunk } from "../../../src/core/search/store.ts";

const NOW = 1_750_000_000_000;
const OLD = NOW / 1000 - 365 * 24 * 3600; // no recency boost

function hyd(chunkId: number, docId: number): HydratedChunk {
  return Object.freeze({
    chunkId,
    documentId: docId,
    path: `doc${docId}.md`,
    title: `Doc ${docId}`,
    content: `chunk ${chunkId}`,
    startLine: 1,
    endLine: 1,
    mtime: OLD,
  });
}

// chunk 1: top of the keyword lane only. chunk 2: present in BOTH lanes
// (keyword rank 2, semantic rank 1). chunk 3: semantic lane only.
const KW: KeywordHit[] = [
  { chunkId: 1, documentId: 10, bm25: -10 }, // best keyword, single-lane
  { chunkId: 2, documentId: 11, bm25: -5 },
];
const SEM: SemanticHit[] = [
  { chunkId: 2, documentId: 11, distance: 0.1 }, // best semantic
  { chunkId: 3, documentId: 12, distance: 0.2 },
];
const HYDRATED = new Map<number, HydratedChunk>([
  [1, hyd(1, 10)],
  [2, hyd(2, 11)],
  [3, hyd(3, 12)],
]);

function inputs() {
  return {
    keyword: KW,
    semantic: SEM,
    hydrated: HYDRATED,
    inboundLinkSources: new Map(),
    tagsByDoc: new Map(),
  };
}

test("rrf mode promotes the chunk present in BOTH lanes above a single-lane top hit", () => {
  // chunk 2 (keyword rank 2 + semantic rank 1) fuses above chunk 1 (top
  // of the keyword lane but absent from the semantic lane), because RRF
  // rewards cross-lane presence: 1/62 + 1/61 > 1/61.
  const ranked = rankResults(inputs(), {
    keywordWeight: 0.6,
    semanticWeight: 0.4,
    limit: 10,
    nowMs: NOW,
    fusionMode: "rrf",
    rrfK: 60,
  });
  expect(ranked[0]!.chunkId).toBe(2);
  expect(ranked[0]!.reasons.some((r) => r.startsWith("rrf:"))).toBe(true);
  // The single-lane chunk 3 (semantic only, rank 2) fuses lowest.
  expect(ranked[ranked.length - 1]!.chunkId).toBe(3);
});

test("linear mode (default) does NOT add an rrf reason", () => {
  const ranked = rankResults(inputs(), {
    keywordWeight: 0.6,
    semanticWeight: 0.4,
    limit: 10,
    nowMs: NOW,
  });
  for (const r of ranked) {
    expect(r.reasons.some((x) => x.startsWith("rrf:"))).toBe(false);
  }
});

test("linear mode ranking is unchanged when fusionMode is omitted vs explicit linear", () => {
  const base = inputs();
  const omitted = rankResults(base, {
    keywordWeight: 0.6,
    semanticWeight: 0.4,
    limit: 10,
    nowMs: NOW,
  });
  const explicit = rankResults(base, {
    keywordWeight: 0.6,
    semanticWeight: 0.4,
    limit: 10,
    nowMs: NOW,
    fusionMode: "linear",
  });
  expect(omitted.map((r) => r.chunkId)).toEqual(explicit.map((r) => r.chunkId));
  expect(omitted.map((r) => r.score)).toEqual(explicit.map((r) => r.score));
});

// ── config parsing ───────────────────────────────────────────────────────────

let tmp: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-rrf-cfg-"));
  config = join(tmp, "config.yaml");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("search_fusion_mode defaults to linear with rrf_k 60", () => {
  writeFileSync(config, `vault: "${tmp}"\n`);
  const cfg = resolveSearchConfig({ vault: tmp, configPath: config });
  expect(cfg.fusionMode).toBe("linear");
  expect(cfg.rrfK).toBe(60);
});

test("search_fusion_mode parses rrf", () => {
  writeFileSync(config, `vault: "${tmp}"\nsearch_fusion_mode: "rrf"\nsearch_rrf_k: "40"\n`);
  const cfg = resolveSearchConfig({ vault: tmp, configPath: config });
  expect(cfg.fusionMode).toBe("rrf");
  expect(cfg.rrfK).toBe(40);
});

test("an invalid search_fusion_mode is rejected", () => {
  writeFileSync(config, `vault: "${tmp}"\nsearch_fusion_mode: "weighted"\n`);
  expect(() => resolveSearchConfig({ vault: tmp, configPath: config })).toThrow(SearchError);
});
