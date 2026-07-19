/**
 * Relation-only supersede fade (t_c4a9cef8): the second consumer of
 * kernel 1. A candidate a surfaced `superseded_by` relation marks
 * superseded - the same source of truth `attachTrustMetadata` /
 * `deriveTrust` use - is faded by SUPERSEDE_FADE_MULTIPLIER on both the
 * semantic and pure-lexical paths. A pool with no such relation ranks
 * byte-identically, and the existing superseded-non-tip tombstone drop is
 * untouched.
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import type { BrainSearchResult } from "../../../src/core/search/types.ts";
import { supersedeFadeAdjuster } from "../../../src/core/search/result-filters.ts";
import { SUPERSEDE_FADE_MULTIPLIER } from "../../../src/core/search/ranker.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("supersede-fade"));
});

afterEach(() => cleanup());

function result(over: Partial<BrainSearchResult> & { documentId: number }): BrainSearchResult {
  return Object.freeze({
    chunkId: over.documentId * 10,
    path: `doc-${over.documentId}.md`,
    title: null,
    content: "body",
    startLine: 1,
    endLine: 1,
    score: 0.5,
    keywordScore: 0.5,
    semanticScore: 0,
    linkBoost: 0,
    recencyBoost: 0,
    searchType: "keyword" as const,
    reasons: Object.freeze([]),
    ...over,
  });
}

function stableProjection(r: BrainSearchResult) {
  return {
    path: r.path,
    searchType: r.searchType,
    keywordScore: r.keywordScore,
    reasons: r.reasons.filter((reason) => !reason.startsWith("recency:")),
  };
}

describe("supersedeFadeAdjuster (unit)", () => {
  test("fades a candidate whose relations mark it superseded", () => {
    const adjuster = supersedeFadeAdjuster((docId) =>
      docId === 1 ? [{ relation: "superseded_by", target: "next" }] : [],
    );
    expect(adjuster.adjust(result({ documentId: 1 }))).toEqual({
      kind: "multiply",
      factor: SUPERSEDE_FADE_MULTIPLIER,
      reason: "superseded",
    });
  });

  test("keeps a candidate with no supersede relation", () => {
    const adjuster = supersedeFadeAdjuster((docId) =>
      docId === 1 ? [{ relation: "related", target: "x" }] : [],
    );
    expect(adjuster.adjust(result({ documentId: 1 }))).toEqual({ kind: "keep" });
  });
});

const SUPERSEDED = [
  "---",
  'superseded_by: "[[fresh-widget]]"',
  "---",
  "# Old widget",
  "",
  "The widget calibration routine (old, superseded).",
].join("\n");

const FRESH = "# Fresh widget\n\nThe widget calibration routine, current version.";

describe("supersede fade on the search path", () => {
  test("an unchanged superseded note is faded below an equally-matching fresh note", async () => {
    writeMd(vault, "old-widget.md", SUPERSEDED);
    writeMd(vault, "fresh-widget.md", FRESH);
    // Isolate the fade from the (default-on) relation-polarity phase.
    const cfg = makeConfig({
      vault,
      dbPath,
      supersedeFadeEnabled: true,
      relationPolarityEnabled: false,
    });

    await indexVault(cfg);
    const out = await search(cfg, { query: "widget calibration routine", limit: 5 });
    const old = out.results.find((r) => r.path === "old-widget.md");
    const fresh = out.results.find((r) => r.path === "fresh-widget.md");
    expect(old).toBeDefined();
    expect(fresh).toBeDefined();
    expect(old!.reasons).toContain("supersede_fade:superseded");
    expect(old!.score).toBeLessThan(fresh!.score);
  });

  test("flag off leaves the superseded note byte-identical (no fade)", async () => {
    writeMd(vault, "old-widget.md", SUPERSEDED);
    writeMd(vault, "fresh-widget.md", FRESH);
    const on = makeConfig({
      vault,
      dbPath,
      supersedeFadeEnabled: true,
      relationPolarityEnabled: false,
    });
    const off = makeConfig({ vault, dbPath, relationPolarityEnabled: false });

    await indexVault(off);
    const faded = await search(on, { query: "widget calibration routine", limit: 5 });
    const plain = await search(off, { query: "widget calibration routine", limit: 5 });
    const fadedOld = faded.results.find((r) => r.path === "old-widget.md")!;
    const plainOld = plain.results.find((r) => r.path === "old-widget.md")!;
    expect(fadedOld.score).toBeLessThan(plainOld.score);
    expect(plainOld.reasons).not.toContain("supersede_fade:superseded");
  });

  test("a vault with no supersede relation ranks byte-identically with the fade on or off", async () => {
    writeMd(vault, "a.md", "# A\n\nnote about orchard pruning in spring");
    writeMd(vault, "b.md", "# B\n\nnote about orchard irrigation schedules");
    const on = makeConfig({ vault, dbPath, supersedeFadeEnabled: true });
    const off = makeConfig({ vault, dbPath });

    await indexVault(off);
    const a = await search(on, { query: "orchard", limit: 5 });
    const b = await search(off, { query: "orchard", limit: 5 });
    expect(a.results.map(stableProjection)).toEqual(b.results.map(stableProjection));
  });

  test("the fade never resurrects a tombstoned (superseded-non-tip) note", async () => {
    // A tombstoned note is dropped by the status filter BEFORE the fade
    // runs; the fade must not surface it.
    writeMd(
      vault,
      "tombstoned.md",
      [
        "---",
        "_status: tombstoned",
        'superseded_by: "[[fresh-widget]]"',
        "---",
        "# Tombstoned widget",
        "",
        "The widget calibration routine (tombstoned).",
      ].join("\n"),
    );
    writeMd(vault, "fresh-widget.md", FRESH);
    const cfg = makeConfig({
      vault,
      dbPath,
      supersedeFadeEnabled: true,
      relationPolarityEnabled: false,
    });

    await indexVault(cfg);
    const out = await search(cfg, { query: "widget calibration routine", limit: 5 });
    expect(out.results.some((r) => r.path === "tombstoned.md")).toBe(false);
  });
});
