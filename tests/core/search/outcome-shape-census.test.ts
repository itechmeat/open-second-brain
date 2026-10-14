/**
 * Census over the search outcome's serialized shape (recall-lane-latency).
 *
 * The wave's timing channel is a per-call sink option, never a field on
 * {@link SearchOutcome}: the query cache persists whole outcomes, so one
 * call's timings frozen into a cached row would serve every later caller
 * a stale measurement. The sink keeps that honest only while the outcome
 * type stays timing-free, and nothing else pins it - the explain tests
 * pin the flag-off WIRE payload, which a new field would not touch.
 *
 * Two pins, one run:
 *
 *   - The top-level key set of a plain keyword-only outcome is exactly
 *     the sanctioned list. A new top-level field - timing or otherwise -
 *     breaks this census and forces a conscious decision, which is the
 *     point: a field added "just for telemetry" is exactly the one that
 *     slides into the cache.
 *   - No key anywhere in the serialized outcome names the timing
 *     vocabulary the wave introduced (the sink's record names, their
 *     wire spellings, and the generic timing words). The walk is
 *     recursive, so a nested record cannot carry what the top level
 *     refuses.
 */

import { afterAll, describe, expect, test } from "bun:test";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

const SANCTIONED_TOP_LEVEL_KEYS = ["idfWeightedCoverage", "results", "total", "warnings"];

const TIMING_VOCABULARY = [
  "overlappedMs",
  "overlapped_ms",
  "embedStartMs",
  "embedEndMs",
  "keywordStartMs",
  "keywordEndMs",
  "laneTiming",
  "semanticAttempted",
];

function collectKeys(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      into.add(key);
      collectKeys(nested, into);
    }
  }
}

describe("search outcome shape census", () => {
  const v = createTempVault("outcome-shape-census");
  let outcome: Awaited<ReturnType<typeof search>> | undefined;

  test("setup: a plain keyword-only run", async () => {
    writeMd(
      v.vault,
      "notes/fox.md",
      "---\ntitle: Fox\n---\n\n# Fox\n\nThe quick brown fox jumps over the lazy dog.\n",
    );
    const config = makeConfig({ vault: v.vault, dbPath: v.dbPath });
    await indexVault(config);
    outcome = await search(config, { query: "fox", limit: 5, keywordOnly: true });
    expect(outcome.results.length).toBeGreaterThan(0);
  }, 30_000);

  test("the outcome's top-level key set is exactly the sanctioned list", () => {
    if (outcome === undefined) throw new Error("the setup run produced no outcome");
    expect(Object.keys(outcome).sort()).toEqual(SANCTIONED_TOP_LEVEL_KEYS);
  });

  test("no key anywhere in the serialized outcome names the timing vocabulary", () => {
    if (outcome === undefined) throw new Error("the setup run produced no outcome");
    const keys = new Set<string>();
    collectKeys(outcome, keys);
    const offenders = TIMING_VOCABULARY.filter((name) => keys.has(name));
    expect(offenders).toEqual([]);
  });

  afterAll(() => {
    v.cleanup();
  });
});
