/**
 * Event-time vs storage-time discipline (Time-Aware Recall &
 * Activation Suite, t_b7191486): documents declaring `valid_from` /
 * `valid_until` are filtered by their validity window (interval
 * overlap), never by storage mtime; documents without validity fields
 * keep the mtime fallback byte-identically.
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { utimesSync } from "node:fs";

import { eventTimeInRange, parseValidityWindow } from "../../../src/core/search/validity.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

const DAY = 24 * 60 * 60 * 1000;

describe("parseValidityWindow (pure)", () => {
  test("absent fields mean no window", () => {
    expect(parseValidityWindow({})).toBeNull();
    expect(parseValidityWindow({ other: "x" })).toBeNull();
  });

  test("bare ISO dates resolve to day bounds in UTC", () => {
    const w = parseValidityWindow({ valid_from: "2026-05-01", valid_until: "2026-05-03" });
    expect(w?.validFromMs).toBe(Date.UTC(2026, 4, 1));
    expect(w?.validUntilMs).toBe(Date.UTC(2026, 4, 4) - 1);
    expect(w?.invalid).toBe(false);
  });

  test("one-sided windows leave the other edge open", () => {
    const from = parseValidityWindow({ valid_from: "2026-05-01T10:00:00Z" });
    expect(from?.validFromMs).toBe(Date.UTC(2026, 4, 1, 10));
    expect(from?.validUntilMs).toBeNull();
    const until = parseValidityWindow({ valid_until: "2026-05-01" });
    expect(until?.validFromMs).toBeNull();
  });

  test("junk values flag the window invalid", () => {
    const w = parseValidityWindow({ valid_from: "soonish" });
    expect(w?.invalid).toBe(true);
  });
});

describe("eventTimeInRange (pure)", () => {
  const range = { sinceMs: Date.UTC(2026, 4, 10), untilMs: Date.UTC(2026, 4, 20) };

  test("overlap semantics: any intersection passes", () => {
    const before = parseValidityWindow({ valid_from: "2026-05-01", valid_until: "2026-05-05" });
    const spanning = parseValidityWindow({ valid_from: "2026-05-05", valid_until: "2026-05-15" });
    const inside = parseValidityWindow({ valid_from: "2026-05-12", valid_until: "2026-05-13" });
    expect(eventTimeInRange(before, 0, range)).toBe(false);
    expect(eventTimeInRange(spanning, 0, range)).toBe(true);
    expect(eventTimeInRange(inside, 0, range)).toBe(true);
  });

  test("no window falls back to mtime", () => {
    const inRangeMtime = Date.UTC(2026, 4, 15) / 1000;
    const outRangeMtime = Date.UTC(2026, 4, 1) / 1000;
    expect(eventTimeInRange(null, inRangeMtime, range)).toBe(true);
    expect(eventTimeInRange(null, outRangeMtime, range)).toBe(false);
  });

  test("an invalid window also falls back to mtime", () => {
    const w = parseValidityWindow({ valid_from: "garbage" });
    expect(eventTimeInRange(w, Date.UTC(2026, 4, 15) / 1000, range)).toBe(true);
    expect(eventTimeInRange(w, Date.UTC(2026, 4, 1) / 1000, range)).toBe(false);
  });
});

describe("search() event-time discipline", () => {
  let vault: string;
  let dbPath: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ vault, dbPath, cleanup } = createTempVault("validity"));
  });

  afterEach(() => {
    cleanup();
  });

  test("event time is the authority over storage time, both directions", async () => {
    const now = Date.now();
    const recentEvent = new Date(now - 2 * DAY).toISOString();
    const oldEvent = new Date(now - 200 * DAY).toISOString();
    // Old file describing a recent event: must be FOUND by since=7d.
    const oldFile = writeMd(
      vault,
      "Brain/notes/old-file-recent-event.md",
      `---\nvalid_from: ${recentEvent}\n---\n\n# Recent\n\nHarbor dredging incident report.\n`,
    );
    // Fresh file describing an old, closed event: must be EXCLUDED.
    writeMd(
      vault,
      "Brain/notes/new-file-old-event.md",
      `---\nvalid_from: ${oldEvent}\nvalid_until: ${oldEvent}\n---\n\n# Old\n\nHarbor dredging incident report.\n`,
    );
    // No validity fields: mtime fallback keeps it in range.
    writeMd(vault, "Brain/notes/plain.md", "# Plain\n\nHarbor dredging incident report.\n");
    const config = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1 });
    await indexVault(config);
    // Make the event-recent file's mtime ancient AFTER indexing the
    // content (the index stores mtime at index time, so reindex).
    const ancient = new Date(now - 300 * DAY);
    utimesSync(oldFile, ancient, ancient);
    await indexVault(config);

    const outcome = await search(config, { query: "harbor dredging incident", since: "7d" });
    const paths = outcome.results.map((r) => r.path);
    expect(paths).toContain("Brain/notes/old-file-recent-event.md");
    expect(paths).not.toContain("Brain/notes/new-file-old-event.md");
    expect(paths).toContain("Brain/notes/plain.md");
  });

  test("an unparseable validity value warns and falls back to mtime", async () => {
    writeMd(
      vault,
      "Brain/notes/broken.md",
      "---\nvalid_from: not-a-date\n---\n\n# Broken\n\nHarbor dredging incident report.\n",
    );
    const config = makeConfig({ vault, dbPath, maxHops: 0, mmrLambda: 1 });
    await indexVault(config);
    const outcome = await search(config, { query: "harbor dredging incident", since: "7d" });
    expect(outcome.results.map((r) => r.path)).toContain("Brain/notes/broken.md");
    expect(outcome.warnings.some((w) => w.includes("validity"))).toBe(true);
  });
});
