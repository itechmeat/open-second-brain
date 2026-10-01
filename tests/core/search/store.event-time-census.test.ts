/**
 * Task 1 of the search/diagnostics/vault-hygiene wave: the per-document
 * event-time bounds and pinned columns (t_9e1a4b3f store half + the
 * schema half of t_f7bef96a), the window census beside StoreCounts, and
 * the shared per-document event-time resolver.
 *
 * Four properties are pinned here:
 *
 *   - the v13 migration applies on a fresh database AND on a rewound
 *     v12 database holding rows, where lazy backfill leaves the three
 *     columns NULL rather than inventing values;
 *   - `upsertDocument` round-trips `event_time_min` / `event_time_max`
 *     / `pinned`, including the conflict arm and the absent-field =
 *     NULL contract existing callers rely on;
 *   - `eventTimeWindowCensus` answers the window question as one SQL
 *     aggregate for closed, open-start and open-end declared windows
 *     and for open query edges, and names the unmeasured bucket;
 *   - `resolveDocumentEventTimeWindow` implements the shared rung
 *     order - frontmatter validity window > event anchor (admitted
 *     rungs only) > null - and the query-side resolver agrees with it
 *     exactly, so index time and query time cannot drift.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyMigrations,
  EVENT_TIME_MAX_COLUMN,
  EVENT_TIME_MIN_COLUMN,
  LATEST_SCHEMA_VERSION,
  PINNED_COLUMN,
  readSchemaVersion,
} from "../../../src/core/search/schema.ts";
import { upsertDocument } from "../../../src/core/search/store/documents.ts";
import { eventTimeWindowCensus } from "../../../src/core/search/store/counts.ts";
import {
  createEventTimeResolver,
  resolveDocumentEventTimeWindow,
} from "../../../src/core/search/pipeline/event-time.ts";
import { EVENT_ANCHOR_SOURCE, type EventAnchor } from "../../../src/core/search/event-anchor.ts";
import type { FrontmatterCache } from "../../../src/core/search/result-filters.ts";

// Fixed instants: any real clock here would make the census nondeterministic.
const DEC = Date.UTC(2025, 11, 1);
const JAN = Date.UTC(2026, 0, 1);
const FEB = Date.UTC(2026, 1, 1);
const MAR = Date.UTC(2026, 2, 1);

const EVENT_TIME_COLUMNS = [EVENT_TIME_MIN_COLUMN, EVENT_TIME_MAX_COLUMN, PINNED_COLUMN];

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-event-time-census-"));
  dbPath = join(tmp, "test.sqlite");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function openMigrated(): Database {
  const db = new Database(dbPath);
  expect(applyMigrations(db)).toBe(LATEST_SCHEMA_VERSION);
  return db;
}

function hasColumn(db: Database, table: string, name: string): boolean {
  return db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .some((c) => c.name === name);
}

function newDoc(db: Database, path: string, bounds: { min: number | null; max: number | null }) {
  upsertDocument(db, {
    path,
    title: null,
    contentHash: path,
    mtime: 1,
    size: 1,
    eventTimeMinMs: bounds.min,
    eventTimeMaxMs: bounds.max,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Migration v13
// ─────────────────────────────────────────────────────────────────────────────

test("fresh migration carries the three per-document columns", () => {
  const db = openMigrated();
  for (const col of EVENT_TIME_COLUMNS) expect(hasColumn(db, "documents", col)).toBe(true);
  db.close(true);
});

test("a v12 index rewound with rows re-migrates with the new columns null (lazy backfill)", () => {
  const db = openMigrated();
  const from = JAN;
  const until = FEB - 1;
  upsertDocument(db, {
    path: "notes/alpha.md",
    title: "A",
    contentHash: "h",
    mtime: 42,
    size: 7,
    eventTimeMinMs: from,
    eventTimeMaxMs: until,
    pinned: true,
  });
  // Simulate an older v12 index: drop the three columns and rewind.
  for (const col of EVENT_TIME_COLUMNS) db.run(`ALTER TABLE documents DROP COLUMN ${col}`);
  db.run("UPDATE index_state SET value = '12' WHERE key = 'schema_version'");
  expect(readSchemaVersion(db)).toBe(12);

  expect(applyMigrations(db)).toBe(LATEST_SCHEMA_VERSION);
  for (const col of EVENT_TIME_COLUMNS) expect(hasColumn(db, "documents", col)).toBe(true);
  const row = db
    .query<Record<string, number | null>, []>(
      `SELECT ${EVENT_TIME_MIN_COLUMN}, ${EVENT_TIME_MAX_COLUMN}, ${PINNED_COLUMN} ` +
        "FROM documents WHERE path = 'notes/alpha.md'",
    )
    .get();
  // Lazy backfill: the migrated row keeps NULLs until its next content
  // change refreshes it through the indexer's document loop.
  expect(row).toEqual({
    [EVENT_TIME_MIN_COLUMN]: null,
    [EVENT_TIME_MAX_COLUMN]: null,
    [PINNED_COLUMN]: null,
  });
  db.close(true);
});

test("re-running the migration over an already-migrated index is a no-op", () => {
  const db = openMigrated();
  db.run("UPDATE index_state SET value = '12' WHERE key = 'schema_version'");
  // The PRAGMA guard makes the ALTERs idempotent, so a rewind with the
  // columns still present must not raise "duplicate column name".
  expect(() => applyMigrations(db)).not.toThrow();
  expect(readSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
  db.close(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// upsertDocument round-trip
// ─────────────────────────────────────────────────────────────────────────────

function persistedBounds(
  db: Database,
  path: string,
): {
  min: number | null;
  max: number | null;
  pinned: number | null;
} {
  const row = db
    .query<{ min: number | null; max: number | null; pinned: number | null }, [string]>(
      `SELECT ${EVENT_TIME_MIN_COLUMN} AS min, ${EVENT_TIME_MAX_COLUMN} AS max, ` +
        `${PINNED_COLUMN} AS pinned FROM documents WHERE path = ?`,
    )
    .get(path);
  expect(row).toBeDefined();
  return row!;
}

test("upsertDocument round-trips the three columns, including the conflict arm", () => {
  const db = openMigrated();
  const from = JAN;
  const until = FEB - 1;
  upsertDocument(db, {
    path: "a.md",
    title: null,
    contentHash: "h1",
    mtime: 1,
    size: 1,
    eventTimeMinMs: from,
    eventTimeMaxMs: until,
    pinned: true,
  });
  expect(persistedBounds(db, "a.md")).toEqual({ min: from, max: until, pinned: 1 });

  // Same path, changed statements: the ON CONFLICT arm must update all
  // three, not leave the first pass's values behind.
  upsertDocument(db, {
    path: "a.md",
    title: null,
    contentHash: "h2",
    mtime: 2,
    size: 1,
    eventTimeMinMs: null,
    eventTimeMaxMs: until,
    pinned: false,
  });
  expect(persistedBounds(db, "a.md")).toEqual({ min: null, max: until, pinned: 0 });

  // Existing callers compile unchanged, and absent fields persist NULL.
  upsertDocument(db, { path: "b.md", title: null, contentHash: "h3", mtime: 3, size: 1 });
  expect(persistedBounds(db, "b.md")).toEqual({ min: null, max: null, pinned: null });
  db.close(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// Window census
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Eight documents over a fixed timeline: every declared-window shape
 * (closed, open-start, open-end) in and out of the [JAN, FEB] query
 * window, plus one unmeasured row.
 */
function seedCensusDocs(db: Database): void {
  newDoc(db, "closed-inside.md", { min: JAN + 1, max: FEB - 1 });
  newDoc(db, "closed-after.md", { min: FEB + 1, max: MAR });
  newDoc(db, "closed-before.md", { min: DEC, max: JAN - 1 });
  newDoc(db, "open-start-ends-at-since.md", { min: null, max: JAN });
  newDoc(db, "open-start-ends-before.md", { min: null, max: DEC });
  newDoc(db, "open-end-starts-at-until.md", { min: FEB, max: null });
  newDoc(db, "open-end-starts-after.md", { min: MAR, max: null });
  newDoc(db, "unmeasured.md", { min: null, max: null });
}

test("census counts closed, open-start and open-end windows over a closed range", () => {
  const db = openMigrated();
  seedCensusDocs(db);
  // Intersecting: closed-inside, open-start-ends-at-since (max == since
  // is inclusive), open-end-starts-at-until (min == until is inclusive).
  // The span is the earliest and latest bound any window names, whichever
  // side of an open window carries it.
  expect(eventTimeWindowCensus(db, JAN, FEB)).toEqual({
    documents: 8,
    declared: 7,
    intersecting: 3,
    mtimeFallback: 1,
    earliestMs: DEC,
    latestMs: MAR,
  });
  db.close(true);
});

test("census open query edges exclude only on the bound that can decide", () => {
  const db = openMigrated();
  seedCensusDocs(db);
  // Both edges open: nothing can exclude a declared window.
  expect(eventTimeWindowCensus(db, null, null)).toEqual({
    documents: 8,
    declared: 7,
    intersecting: 7,
    mtimeFallback: 1,
    earliestMs: DEC,
    latestMs: MAR,
  });
  // since open: only `event_time_min > until` excludes.
  expect(eventTimeWindowCensus(db, null, FEB)).toEqual({
    documents: 8,
    declared: 7,
    intersecting: 5,
    mtimeFallback: 1,
    earliestMs: DEC,
    latestMs: MAR,
  });
  // until open: only `event_time_max < since` excludes.
  expect(eventTimeWindowCensus(db, JAN, null)).toEqual({
    documents: 8,
    declared: 7,
    intersecting: 5,
    mtimeFallback: 1,
    earliestMs: DEC,
    latestMs: MAR,
  });
  db.close(true);
});

test("census bucket arithmetic holds: declared + mtimeFallback = documents", () => {
  const db = openMigrated();
  seedCensusDocs(db);
  for (const [since, until] of [
    [JAN, FEB],
    [null, FEB],
    [JAN, null],
    [null, null],
  ] as const) {
    const c = eventTimeWindowCensus(db, since, until);
    expect(c.declared + c.mtimeFallback).toBe(c.documents);
  }
  db.close(true);
});

test("census on an empty index reports zero across the board", () => {
  const db = openMigrated();
  expect(eventTimeWindowCensus(db, JAN, FEB)).toEqual({
    documents: 0,
    declared: 0,
    intersecting: 0,
    mtimeFallback: 0,
    earliestMs: null,
    latestMs: null,
  });
  db.close(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// Shared per-document resolver
// ─────────────────────────────────────────────────────────────────────────────

const BODY_ANCHOR: EventAnchor = Object.freeze({
  startMs: JAN,
  endMs: FEB - 1,
  source: EVENT_ANCHOR_SOURCE.body,
});

test("rung order: a frontmatter validity window beats the event anchor", () => {
  const window = resolveDocumentEventTimeWindow({ valid_from: "2026-03-01" }, BODY_ANCHOR);
  expect(window).toEqual({
    validFromMs: Date.UTC(2026, 2, 1),
    validUntilMs: null,
    invalid: false,
  });
});

test("rung order: an admitted anchor rung supplies the window when frontmatter declares none", () => {
  expect(resolveDocumentEventTimeWindow({}, BODY_ANCHOR)).toEqual({
    validFromMs: JAN,
    validUntilMs: FEB - 1,
    invalid: false,
  });
  // Unrelated frontmatter keys are not a declaration.
  expect(resolveDocumentEventTimeWindow({ title: "x" }, BODY_ANCHOR)).toEqual({
    validFromMs: JAN,
    validUntilMs: FEB - 1,
    invalid: false,
  });
});

test("rung order: a recorded-but-unadmitted anchor rung is never event time", () => {
  for (const source of [EVENT_ANCHOR_SOURCE.createdAt, EVENT_ANCHOR_SOURCE.date]) {
    expect(resolveDocumentEventTimeWindow({}, { startMs: JAN, endMs: FEB - 1, source })).toBeNull();
  }
});

test("rung order: nothing declared anywhere resolves to null (mtime fallback)", () => {
  expect(resolveDocumentEventTimeWindow({}, null)).toBeNull();
  expect(resolveDocumentEventTimeWindow({ title: "x" }, null)).toBeNull();
});

test("rung order: a declared-but-unparseable frontmatter window stops the ladder", () => {
  // The anchor must NOT be consulted behind a frontmatter declaration,
  // even a broken one - the query side warns and falls back to mtime,
  // and silently substituting the anchor's answer would hide the break.
  const window = resolveDocumentEventTimeWindow({ valid_from: "not-a-date" }, BODY_ANCHOR);
  expect(window).toEqual({ validFromMs: null, validUntilMs: null, invalid: true });
});

test("the query-side resolver agrees with the shared resolver exactly", () => {
  const cache: FrontmatterCache = new Map([
    ["declared.md", Object.freeze({ meta: { valid_from: "2026-03-01" }, unreadable: false })],
    ["anchored.md", Object.freeze({ meta: {}, unreadable: false })],
    ["empty.md", Object.freeze({ meta: {}, unreadable: false })],
  ]);
  const anchors = new Map<string, EventAnchor | null>([
    ["declared.md", BODY_ANCHOR],
    ["anchored.md", BODY_ANCHOR],
    ["empty.md", null],
  ]);
  const resolver = createEventTimeResolver("/vault-unused", cache, (p) => anchors.get(p) ?? null);
  for (const path of ["declared.md", "anchored.md", "empty.md"]) {
    const anchor = anchors.get(path) ?? null;
    expect(resolver.validityWindowFor(path)).toEqual(
      resolveDocumentEventTimeWindow(cache.get(path)!.meta, anchor),
    );
  }
  // Provenance: non-null exactly when the anchor rung supplied the window.
  expect(resolver.inferredEventTimeSourceFor("anchored.md")).toBe(EVENT_ANCHOR_SOURCE.body);
  expect(resolver.inferredEventTimeSourceFor("declared.md")).toBeNull();
  expect(resolver.inferredEventTimeSourceFor("empty.md")).toBeNull();
});
