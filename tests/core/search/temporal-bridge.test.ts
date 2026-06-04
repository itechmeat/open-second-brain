/**
 * Temporal-bridge traversal (Time-Aware Recall & Activation Suite,
 * t_c3871f0c): with an active time range, traversal expansions are kept
 * only inside a padded event-time neighbourhood of the window and are
 * scored with temporal-proximity decay - causes and consequences, not
 * arbitrary link leakage.
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { utimesSync } from "node:fs";

import {
  applyTemporalBridge,
  temporalProximity,
} from "../../../src/core/search/temporal-bridge.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import type { BrainSearchResult } from "../../../src/core/search/types.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);

function linkResult(path: string, score: number): BrainSearchResult {
  return Object.freeze({
    documentId: path.length,
    chunkId: path.length * 10,
    path,
    title: null,
    content: "linked",
    startLine: 1,
    endLine: 1,
    score,
    keywordScore: 0,
    semanticScore: 0,
    linkBoost: 0,
    recencyBoost: 0,
    searchType: "link" as const,
    reasons: Object.freeze(["link_traversal: hop 1 from seed.md"]),
  });
}

function hitResult(path: string, score: number): BrainSearchResult {
  return Object.freeze({
    documentId: path.length,
    chunkId: path.length * 10,
    path,
    title: null,
    content: "hit",
    startLine: 1,
    endLine: 1,
    score,
    keywordScore: 0.5,
    semanticScore: 0,
    linkBoost: 0,
    recencyBoost: 0,
    searchType: "keyword" as const,
    reasons: Object.freeze(["fts5_bm25: 0.500"]),
  });
}

describe("temporalProximity (pure)", () => {
  const range = { sinceMs: NOW - 7 * DAY, untilMs: NOW };

  test("inside the window is full proximity", () => {
    expect(temporalProximity(NOW - 2 * DAY, range, 7)).toBe(1);
  });

  test("outside decays linearly with distance and dies past the pad", () => {
    const threeOut = temporalProximity(NOW - 10 * DAY, range, 7);
    const sevenOut = temporalProximity(NOW - 14 * DAY, range, 7);
    expect(threeOut).toBeGreaterThan(sevenOut);
    expect(sevenOut).toBeGreaterThan(0);
    expect(temporalProximity(NOW - 15 * DAY, range, 7)).toBe(0);
  });

  test("an open edge never excludes", () => {
    const openSince = { sinceMs: null, untilMs: NOW };
    expect(temporalProximity(NOW - 365 * DAY, openSince, 7)).toBe(1);
  });
});

describe("applyTemporalBridge (pure)", () => {
  const range = { sinceMs: NOW - 7 * DAY, untilMs: NOW };
  const eventTimes = new Map<string, number>([
    ["near.md", NOW - 10 * DAY],
    ["far.md", NOW - 60 * DAY],
    ["inside.md", NOW - 1 * DAY],
  ]);
  const resolver = (path: string): number => eventTimes.get(path) ?? NOW;

  test("keeps padded neighbours with decayed scores, drops the rest", () => {
    const out = applyTemporalBridge(
      [hitResult("seed.md", 0.9), linkResult("near.md", 0.4), linkResult("far.md", 0.4)],
      { range, windowPadDays: 7, eventTimeMs: resolver },
    );
    const paths = out.map((r) => r.path);
    expect(paths).toContain("near.md");
    expect(paths).not.toContain("far.md");
    const near = out.find((r) => r.path === "near.md")!;
    expect(near.score).toBeLessThan(0.4);
    expect(near.reasons.some((x) => x.startsWith("temporal_bridge: "))).toBe(true);
  });

  test("expansions inside the window keep their score", () => {
    const out = applyTemporalBridge([linkResult("inside.md", 0.4)], {
      range,
      windowPadDays: 7,
      eventTimeMs: resolver,
    });
    expect(out[0]?.score).toBe(0.4);
  });

  test("relevance hits are never touched", () => {
    const out = applyTemporalBridge([hitResult("far.md", 0.8)], {
      range,
      windowPadDays: 7,
      eventTimeMs: resolver,
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.score).toBe(0.8);
  });
});

describe("search() composes traversal with the time window", () => {
  let vault: string;
  let dbPath: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ vault, dbPath, cleanup } = createTempVault("temporal-bridge"));
  });

  afterEach(() => {
    cleanup();
  });

  test("a linked neighbour within the pad bridges in; a distant one does not", async () => {
    const now = Date.now();
    writeMd(
      vault,
      "Brain/notes/incident.md",
      "# Incident\n\nReactor coolant excursion timeline.\n\n" +
        "[[Brain/notes/prep-work.md|prep]] [[Brain/notes/ancient-history.md|ancient]]\n",
    );
    const prep = writeMd(vault, "Brain/notes/prep-work.md", "# Prep\n\nValve maintenance log.\n");
    const ancient = writeMd(
      vault,
      "Brain/notes/ancient-history.md",
      "# Ancient\n\nCommissioning-era notes.\n",
    );
    const prepDate = new Date(now - 10 * DAY);
    const ancientDate = new Date(now - 90 * DAY);
    utimesSync(prep, prepDate, prepDate);
    utimesSync(ancient, ancientDate, ancientDate);
    const config = makeConfig({ vault, dbPath, maxHops: 1, mmrLambda: 1 });
    await indexVault(config);

    const outcome = await search(config, { query: "reactor coolant excursion", since: "7d" });
    const paths = outcome.results.map((r) => r.path);
    expect(paths).toContain("Brain/notes/incident.md");
    expect(paths).toContain("Brain/notes/prep-work.md");
    expect(paths).not.toContain("Brain/notes/ancient-history.md");
    const bridge = outcome.results.find((r) => r.path === "Brain/notes/prep-work.md");
    expect(bridge!.reasons.some((x) => x.startsWith("temporal_bridge: "))).toBe(true);
  });

  test("without a time range traversal behaviour is untouched", async () => {
    const now = Date.now();
    writeMd(
      vault,
      "Brain/notes/incident.md",
      "# Incident\n\nReactor coolant excursion timeline.\n\n" +
        "[[Brain/notes/ancient-history.md|ancient]]\n",
    );
    const ancient = writeMd(
      vault,
      "Brain/notes/ancient-history.md",
      "# Ancient\n\nCommissioning-era notes.\n",
    );
    const ancientDate = new Date(now - 90 * DAY);
    utimesSync(ancient, ancientDate, ancientDate);
    const config = makeConfig({ vault, dbPath, maxHops: 1, mmrLambda: 1 });
    await indexVault(config);
    const outcome = await search(config, { query: "reactor coolant excursion" });
    expect(outcome.results.map((r) => r.path)).toContain("Brain/notes/ancient-history.md");
    expect(
      outcome.results.every((r) => !r.reasons.some((x) => x.startsWith("temporal_bridge: "))),
    ).toBe(true);
  });
});
