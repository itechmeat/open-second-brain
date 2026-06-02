/**
 * Time-aware recall (recall-trust-suite, Feature D).
 *
 * `since` / `until` accept ISO dates, relative phrases (`yesterday`,
 * `last week`), and duration shorthand (`24h`, `7d`, `2w`). The parser
 * (`time-range.ts`) is pure against an injected clock; search filters
 * hydrated candidates by document mtime before ranking and bypasses the
 * query cache while a range is active (a relative range resolves to a
 * different absolute window every call).
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { utimesSync } from "node:fs";

import { parseTimePoint, resolveTimeRange } from "../../../src/core/search/time-range.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { Store } from "../../../src/core/search/store.ts";
import { SearchError } from "../../../src/core/search/types.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

// A fixed clock: 2026-06-02T12:00:00.000Z
const NOW = Date.UTC(2026, 5, 2, 12, 0, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

describe("parseTimePoint", () => {
  test("ISO datetime passes through", () => {
    expect(parseTimePoint("2026-05-01T10:30:00Z", NOW, "since")).toBe(
      Date.UTC(2026, 4, 1, 10, 30, 0, 0),
    );
  });

  test("a bare ISO date is day-start for since and day-end for until", () => {
    expect(parseTimePoint("2026-05-01", NOW, "since")).toBe(Date.UTC(2026, 4, 1));
    expect(parseTimePoint("2026-05-01", NOW, "until")).toBe(Date.UTC(2026, 4, 2) - 1);
  });

  test("today and yesterday resolve against the injected clock", () => {
    expect(parseTimePoint("today", NOW, "since")).toBe(Date.UTC(2026, 5, 2));
    expect(parseTimePoint("yesterday", NOW, "since")).toBe(Date.UTC(2026, 5, 1));
    expect(parseTimePoint("yesterday", NOW, "until")).toBe(Date.UTC(2026, 5, 2) - 1);
  });

  test("last week / last month are rolling windows", () => {
    expect(parseTimePoint("last week", NOW, "since")).toBe(NOW - 7 * DAY);
    expect(parseTimePoint("last month", NOW, "since")).toBe(NOW - 30 * DAY);
  });

  test("duration shorthand: hours, days, weeks", () => {
    expect(parseTimePoint("24h", NOW, "since")).toBe(NOW - 24 * 60 * 60 * 1000);
    expect(parseTimePoint("7d", NOW, "since")).toBe(NOW - 7 * DAY);
    expect(parseTimePoint("2w", NOW, "since")).toBe(NOW - 14 * DAY);
  });

  test("unparseable input throws INVALID_INPUT", () => {
    for (const bad of ["soon", "5 parsecs", "2026-13-45", ""]) {
      expect(() => parseTimePoint(bad, NOW, "since")).toThrow(SearchError);
    }
  });
});

describe("resolveTimeRange", () => {
  test("absent fields resolve to an open range", () => {
    expect(resolveTimeRange({}, NOW)).toEqual({ sinceMs: null, untilMs: null });
  });

  test("since after until is rejected", () => {
    expect(() => resolveTimeRange({ since: "today", until: "2026-01-01" }, NOW)).toThrow(
      SearchError,
    );
  });
});

// ── search integration ───────────────────────────────────────────────────────

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("time-range"));
});
afterEach(() => cleanup());

async function seedOldAndFresh(): Promise<void> {
  const oldAbs = writeMd(vault, "old.md", "# Old\n\nharvest report for the orchard ledger");
  writeMd(vault, "fresh.md", "# Fresh\n\nharvest notes for the orchard ledger");
  // The old document's mtime is 10 days in the past.
  const tenDaysAgo = new Date(Date.now() - 10 * DAY);
  utimesSync(oldAbs, tenDaysAgo, tenDaysAgo);
}

test("since excludes documents older than the window", async () => {
  await seedOldAndFresh();
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg);

  const all = await search(cfg, { query: "orchard ledger harvest", limit: 5 });
  expect(all.results.map((r) => r.path).toSorted()).toEqual(["fresh.md", "old.md"]);

  const recent = await search(cfg, { query: "orchard ledger harvest", limit: 5, since: "7d" });
  expect(recent.results.map((r) => r.path)).toEqual(["fresh.md"]);
});

test("until excludes documents newer than the window", async () => {
  await seedOldAndFresh();
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg);

  const old = await search(cfg, { query: "orchard ledger harvest", limit: 5, until: "7d" });
  expect(old.results.map((r) => r.path)).toEqual(["old.md"]);
});

test("an invalid since raises INVALID_INPUT through search", async () => {
  writeMd(vault, "a.md", "# A\n\nbody");
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg);
  await expect(search(cfg, { query: "body", since: "whenever" })).rejects.toThrow(SearchError);
});

test("time-filtered queries bypass the query cache", async () => {
  await seedOldAndFresh();
  const cfg = makeConfig({ vault, dbPath, cacheEnabled: true });
  await indexVault(cfg);

  await search(cfg, { query: "orchard ledger harvest", limit: 5 });
  await search(cfg, { query: "orchard ledger harvest", limit: 5, since: "7d" });

  const store = await Store.open(cfg, { mode: "read", loadVec: false });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = (store as any).db.query("SELECT COUNT(*) AS n FROM query_cache").get() as {
      n: number;
    };
    expect(rows.n).toBe(1); // only the unfiltered query was cached
  } finally {
    await store.close();
  }
});
