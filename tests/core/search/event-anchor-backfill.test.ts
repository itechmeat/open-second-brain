/**
 * The event-anchor backfill (provenance at the boundary, t_ac1c4176).
 *
 * The v11 migration adds the anchor columns to an EXISTING index in
 * place - nothing reindexes - and the indexer populates them only on the
 * changed-document path, below both content-identity fastpaths. A
 * document indexed by the previous binary therefore has no anchor, its
 * content never changes, and so no anchor is ever computed for it: the
 * feature is inert on every vault that already existed, and its
 * inertness reads exactly like a note that declares no date.
 *
 * These tests pin the two halves of the cure:
 *
 *   1. The index distinguishes "examined, declares nothing" from "never
 *      examined by an anchor-aware binary". Without that column the two
 *      are one NULL and no surface can tell an operator which they have.
 *   2. `planEventAnchorBackfill` closes the gap under the same contract
 *      `authored-at-backfill` and `vector-backfill` follow: a `plan*`
 *      function in core does the finding, dry-run is the DEFAULT,
 *      `apply` is the only mutating path, and a file it could not read
 *      is NAMED rather than counted as done.
 *
 * The upgrade is simulated the only faithful way: a real index is built,
 * its anchor columns are dropped, its schema version is rewound to v10,
 * and the next `Store.open` runs the real v11 migration over it.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync, utimesSync } from "node:fs";
import { join } from "node:path";

import { planEventAnchorBackfill } from "../../../src/core/search/event-anchor-backfill.ts";
import { EVENT_ANCHOR_SOURCE, type EventAnchor } from "../../../src/core/search/event-anchor.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { Store } from "../../../src/core/search/store.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Budget for a test that builds an index; matches the other index suites. */
const INDEX_TEST_TIMEOUT_MS = 30_000;
/** Every fixture is written inside the queried window ... */
const MTIME_IN_WINDOW = new Date("2026-07-01T00:00:00Z");
/** ... and the dated one DECLARES a day two years outside it. */
const DECLARED = "2024-03-01";

/** The columns v11 adds; dropping them rewinds a real index to v10. */
const ANCHOR_COLUMNS = [
  "event_anchor_start_ms",
  "event_anchor_end_ms",
  "event_anchor_source",
  "event_anchor_examined",
];

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  const v = createTempVault("event-anchor-backfill");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
});

afterEach(() => {
  cleanup();
});

/** Two notes: one declaring a body date, one declaring nothing at all. */
function seedVault(): void {
  writeMd(vault, "notes/dated.md", `# Ledger\n\nThe reconciliation entry ${DECLARED} closed it.\n`);
  writeMd(vault, "notes/plain.md", "# Ledger\n\nThe reconciliation entry ref-xy-1234 closed it.\n");
  for (const rel of ["notes/dated.md", "notes/plain.md"]) {
    utimesSync(join(vault, rel), MTIME_IN_WINDOW, MTIME_IN_WINDOW);
  }
}

/**
 * Put a built index back in the state the PREVIOUS binary left it: the
 * anchor columns and the examination marker gone, the recorded schema
 * version back at v10.
 *
 * Then do what an operator upgrading the binary does - run the indexer,
 * whose write open applies the real v11 migration in place. Every file
 * matches its stored mtime and size, so every one of them takes the
 * fastpath and no anchor is computed for any of them: the exact state
 * this backfill exists for. The run's stats are returned because what it
 * reports about that state is itself under test.
 */
async function simulateBinaryUpgrade(
  config: ReturnType<typeof makeConfig>,
): Promise<Awaited<ReturnType<typeof indexVault>>> {
  const db = new Database(dbPath);
  for (const col of ANCHOR_COLUMNS) db.run(`ALTER TABLE documents DROP COLUMN ${col}`);
  db.run("UPDATE index_state SET value = '10' WHERE key = 'schema_version'");
  db.close();
  return await indexVault(config, { embeddings: false });
}

async function anchors(
  config: ReturnType<typeof makeConfig>,
  paths: ReadonlyArray<string>,
): Promise<Array<EventAnchor | null>> {
  const store = await Store.open(config, { mode: "read" });
  try {
    return paths.map((p) => store.eventAnchorForPath(p));
  } finally {
    await store.close();
  }
}

const PATHS = ["notes/dated.md", "notes/plain.md"] as const;

const DATED_ANCHOR: EventAnchor = Object.freeze({
  startMs: Date.parse(`${DECLARED}T00:00:00Z`),
  endMs: Date.parse(`${DECLARED}T00:00:00Z`) + DAY_MS - 1,
  source: EVENT_ANCHOR_SOURCE.body,
});

test(
  "an upgraded index reports its documents as never examined, and the dry run writes nothing",
  async () => {
    seedVault();
    const config = makeConfig({ vault, dbPath });
    await indexVault(config, { embeddings: false });
    expect(await anchors(config, PATHS)).toEqual([DATED_ANCHOR, null]);

    const upgrade = await simulateBinaryUpgrade(config);
    expect(upgrade.unchanged).toBe(2);

    // Both rows are now indistinguishable from "declares nothing" on
    // their columns alone - which is precisely why the examination
    // marker exists to tell them apart.
    expect(await anchors(config, PATHS)).toEqual([null, null]);

    const dry = await planEventAnchorBackfill(config);
    expect(dry.applied).toBe(false);
    expect(dry.documentsTotal).toBe(2);
    expect(dry.pending).toBe(2);
    expect(dry.examined).toBe(0);
    expect(dry.anchored).toBe(0);
    expect(dry.unreadable).toEqual([]);
    // A dry run is a pure read: the index is untouched.
    expect(await anchors(config, PATHS)).toEqual([null, null]);
    expect((await planEventAnchorBackfill(config)).pending).toBe(2);
  },
  INDEX_TEST_TIMEOUT_MS,
);

test(
  "apply materialises exactly what a full reindex would have, and is idempotent",
  async () => {
    seedVault();
    const config = makeConfig({ vault, dbPath });
    await indexVault(config, { embeddings: false });
    const fresh = await anchors(config, PATHS);
    await simulateBinaryUpgrade(config);

    const applied = await planEventAnchorBackfill(config, { apply: true });
    expect(applied.applied).toBe(true);
    expect(applied.pending).toBe(2);
    expect(applied.examined).toBe(2);
    // Only one of the two notes declares anything, and the other is now
    // KNOWN to declare nothing rather than merely unexamined.
    expect(applied.anchored).toBe(1);
    expect(applied.unreadable).toEqual([]);
    expect(await anchors(config, PATHS)).toEqual(fresh);

    // A second run finds nothing pending and does nothing: an examined
    // row that declares nothing is not a row waiting to be examined.
    const again = await planEventAnchorBackfill(config, { apply: true });
    expect(again.pending).toBe(0);
    expect(again.examined).toBe(0);
    expect(await anchors(config, PATHS)).toEqual(fresh);
  },
  INDEX_TEST_TIMEOUT_MS,
);

test(
  "a file the backfill cannot read is named and stays pending, never counted as examined",
  async () => {
    seedVault();
    const config = makeConfig({ vault, dbPath });
    await indexVault(config, { embeddings: false });
    await simulateBinaryUpgrade(config);
    rmSync(join(vault, "notes/dated.md"));

    const applied = await planEventAnchorBackfill(config, { apply: true });
    expect(applied.unreadable.map((u) => u.path)).toEqual(["notes/dated.md"]);
    expect(applied.examined).toBe(1);
    expect(applied.anchored).toBe(0);
    // Still pending, because it was never examined - the run does not
    // get to record a verdict on a file it could not open.
    expect((await planEventAnchorBackfill(config)).pending).toBe(1);
  },
  INDEX_TEST_TIMEOUT_MS,
);

test(
  "the hard since/until filter judges a backfilled note by what it declares",
  async () => {
    seedVault();
    const config = makeConfig({ vault, dbPath });
    await indexVault(config, { embeddings: false });
    await simulateBinaryUpgrade(config);

    // Inert: the note declares 2024 in its body, but the upgraded index
    // has no anchor for it, so it is judged by its 2026 mtime and stays.
    const before = await search(config, {
      query: "reconciliation entry",
      since: "2026-01-01",
      until: "2026-12-31",
      limit: 5,
    });
    expect(before.results.map((r) => r.path)).toContain("notes/dated.md");

    await planEventAnchorBackfill(config, { apply: true });

    const after = await search(config, {
      query: "reconciliation entry",
      since: "2026-01-01",
      until: "2026-12-31",
      limit: 5,
    });
    expect(after.results.map((r) => r.path)).not.toContain("notes/dated.md");
    expect(after.results.map((r) => r.path)).toContain("notes/plain.md");
  },
  INDEX_TEST_TIMEOUT_MS,
);

test(
  "an index run over an upgraded vault reports the pending anchors it did not compute",
  async () => {
    seedVault();
    const config = makeConfig({ vault, dbPath });
    await indexVault(config, { embeddings: false });

    // Every file hits the mtime/size fastpath, so the upgrade run
    // changes nothing - which is exactly the silence this field breaks.
    const stats = await simulateBinaryUpgrade(config);
    expect(stats.unchanged).toBe(2);
    expect(stats.eventAnchorsPending).toBe(2);

    await planEventAnchorBackfill(config, { apply: true });
    expect((await indexVault(config, { embeddings: false })).eventAnchorsPending).toBe(0);
  },
  INDEX_TEST_TIMEOUT_MS,
);
