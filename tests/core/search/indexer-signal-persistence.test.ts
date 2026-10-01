/**
 * Index-time signal persistence (t_9e1a4b3f indexer half + t_f7bef96a
 * persistence half): on every document the indexer upserts, the resolved
 * event-time window and the `pinned` frontmatter flag land in the v13
 * `documents` columns.
 *
 * Pinned here:
 *   - the window is resolved through the SHARED resolver
 *     (`resolveDocumentEventTimeWindow`), so the rung order - frontmatter
 *     validity window > event anchor (admitted rungs only) > null - is
 *     the query side's, not a re-implementation;
 *   - a note that declares nothing, and one whose declared validity
 *     window is unparseable, both persist null/null: the unmeasured state
 *     the query side judges by storage mtime;
 *   - `pinned` is coerced by the preference parser's own rule (boolean,
 *     "true"/"false" string forms, hard default false) and is always
 *     MEASURED for every upserted document;
 *   - changed frontmatter re-persists on the next pass, and unchanged
 *     documents keep their persisted signals behind the content
 *     fastpaths;
 *   - the window census therefore sees the indexed corpus without
 *     hydrating rows.
 *
 * Each test drives a real index build, so they carry the same explicit
 * 30s budget the other index-driving suites use.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";

import { indexVault } from "../../../src/core/search/indexer.ts";
import {
  EVENT_TIME_MAX_COLUMN,
  EVENT_TIME_MIN_COLUMN,
  PINNED_COLUMN,
} from "../../../src/core/search/schema.ts";
import { eventTimeWindowCensus } from "../../../src/core/search/store/counts.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Budget for a test that builds an index; matches the other index suites. */
const INDEX_TEST_TIMEOUT_MS = 30_000;

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  const v = createTempVault("signal-persistence");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
});

afterEach(() => {
  cleanup();
});

function dayStart(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}

async function index(): Promise<void> {
  await indexVault(makeConfig({ vault, dbPath }), { embeddings: false });
}

/** The three persisted signal columns for one path, read off the store. */
function signalsFor(path: string): {
  min: number | null;
  max: number | null;
  pinned: number | null;
} {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .query<{ min: number | null; max: number | null; pinned: number | null }, [string]>(
        `SELECT ${EVENT_TIME_MIN_COLUMN} AS min, ${EVENT_TIME_MAX_COLUMN} AS max, ` +
          `${PINNED_COLUMN} AS pinned FROM documents WHERE path = ?`,
      )
      .get(path);
    expect(row).toBeDefined();
    return row!;
  } finally {
    db.close();
  }
}

test(
  "a note's pinned flag persists through the preference parser's coercion",
  async () => {
    writeMd(vault, "notes/bool.md", ["---", "pinned: true", "---", "", "Bool body."].join("\n"));
    // The string form the simple formatter emits coerces the same way.
    writeMd(
      vault,
      "notes/string.md",
      ["---", 'pinned: "true"', "---", "", "String body."].join("\n"),
    );
    writeMd(vault, "notes/false.md", ["---", "pinned: false", "---", "", "False body."].join("\n"));
    writeMd(vault, "notes/absent.md", "Absent body.");
    await index();

    expect(signalsFor("notes/bool.md").pinned).toBe(1);
    expect(signalsFor("notes/string.md").pinned).toBe(1);
    // Measured, not unmeasured: the indexer looked, the note said no.
    expect(signalsFor("notes/false.md").pinned).toBe(0);
    expect(signalsFor("notes/absent.md").pinned).toBe(0);
  },
  INDEX_TEST_TIMEOUT_MS,
);

test(
  "changed pinned frontmatter re-persists on the next pass",
  async () => {
    writeMd(vault, "notes/flip.md", ["---", "pinned: true", "---", "", "Flip body."].join("\n"));
    await index();
    expect(signalsFor("notes/flip.md").pinned).toBe(1);

    // A content change is what re-opens the row: the flag's removal must
    // land on the next pass, not linger as the first pass's answer.
    writeMd(vault, "notes/flip.md", "Flip body, unpinned");
    await index();
    expect(signalsFor("notes/flip.md").pinned).toBe(0);
  },
  INDEX_TEST_TIMEOUT_MS,
);

test(
  "event-time bounds persist under the shared rung order",
  async () => {
    // Rung 1: a declared frontmatter validity window.
    writeMd(
      vault,
      "notes/validity.md",
      [
        "---",
        "valid_from: 2026-03-01",
        "valid_until: 2026-03-31",
        "---",
        "",
        "Validity body without dates.",
      ].join("\n"),
    );
    // Rung 2: an admitted body-anchor rung.
    writeMd(vault, "notes/anchored.md", "The reconciliation entry 2026-03-04 closed the batch.");
    // Rung 3: nothing declared anywhere - null/null, mtime fallback.
    writeMd(vault, "notes/plain.md", "A body with no date tokens, ref-xy-1234.");
    // A recorded-but-UNADMITTED anchor rung stays unmeasured.
    writeMd(
      vault,
      "notes/created-only.md",
      ["---", "created_at: 2025-11-20", "---", "", "Created body without dates."].join("\n"),
    );
    // A declared-but-unparseable window also stays unmeasured: the query
    // side warns and judges it by mtime, so pretending otherwise would
    // make the census disagree with what queries actually apply.
    writeMd(
      vault,
      "notes/broken-validity.md",
      ["---", "valid_from: not-a-date", "---", "", "Broken body without dates."].join("\n"),
    );
    await index();

    expect(signalsFor("notes/validity.md")).toEqual({
      min: dayStart("2026-03-01"),
      max: dayStart("2026-03-31") + DAY_MS - 1,
      pinned: 0,
    });
    expect(signalsFor("notes/anchored.md")).toEqual({
      min: dayStart("2026-03-04"),
      max: dayStart("2026-03-04") + DAY_MS - 1,
      pinned: 0,
    });
    for (const path of ["notes/plain.md", "notes/created-only.md", "notes/broken-validity.md"]) {
      expect(signalsFor(path)).toEqual({ min: null, max: null, pinned: 0 });
    }
  },
  INDEX_TEST_TIMEOUT_MS,
);

test(
  "unchanged documents keep their persisted signals on a re-run",
  async () => {
    writeMd(
      vault,
      "notes/stable.md",
      ["---", "pinned: true", "valid_from: 2026-03-01", "---", "", "Stable body."].join("\n"),
    );
    await index();
    const first = signalsFor("notes/stable.md");
    expect(first.pinned).toBe(1);

    await index();
    expect(signalsFor("notes/stable.md")).toEqual(first);
  },
  INDEX_TEST_TIMEOUT_MS,
);

test(
  "the window census reads the indexed corpus off the persisted columns",
  async () => {
    writeMd(
      vault,
      "notes/validity.md",
      ["---", "valid_from: 2026-03-01", "valid_until: 2026-03-31", "---", "", "V body."].join("\n"),
    );
    writeMd(vault, "notes/anchored.md", "The reconciliation entry 2026-03-04 closed the batch.");
    writeMd(vault, "notes/plain.md", "No date tokens here, ref-xy-1234.");
    await index();

    const db = new Database(dbPath, { readonly: true });
    try {
      const since = dayStart("2026-03-01");
      const until = dayStart("2026-04-01") - 1;
      const census = eventTimeWindowCensus(db, since, until);
      expect(census).toMatchObject({
        documents: 3,
        declared: 2,
        intersecting: 2,
        mtimeFallback: 1,
      });
      // The span opens on the validity window's start, the earliest bound.
      expect(census.earliestMs).toBe(since);
      expect(census.latestMs).toBeGreaterThan(since);
    } finally {
      db.close();
    }
  },
  INDEX_TEST_TIMEOUT_MS,
);
