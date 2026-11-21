/**
 * One decision about what a stale index needs, read by every surface that
 * meets one: the read path (which upgrades an older schema in place), the
 * status surface (which must not send the user to a rebuild an upgrade
 * replaces) and the post-upgrade maintenance (which must not start a
 * background rebuild for an index a read repairs in place).
 *
 * Pinned here: the status of an index on an older schema is answered, and
 * the index is upgraded in place by the same helper the query path uses;
 * an index no upgrade can repair keeps the rebuild advice.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { indexStatus } from "../../../src/core/search/indexer.ts";
import {
  DEFAULT_FTS_TOKENIZE,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  applyMigrations,
  readSchemaVersion,
} from "../../../src/core/search/schema.ts";
import { CHUNKER_VERSION } from "../../../src/core/search/chunker.ts";
import {
  inspectIndex,
  openReadWithUpgrade,
  planIndexRepair,
} from "../../../src/core/search/self-heal.ts";
import { Store } from "../../../src/core/search/store.ts";
import { acquireWriterLease } from "../../../src/core/search/store/writer-lock.ts";
import { SearchError } from "../../../src/core/search/types.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("index-repair-plan"));
});
afterEach(() => cleanup());

/** Build an index file the way a binary one schema version back left it. */
function buildIndexAtVersion(version: number): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    db.exec("BEGIN");
    for (const m of MIGRATIONS) {
      if (m.version > version) continue;
      m.up(db, { ftsTokenize: DEFAULT_FTS_TOKENIZE, trigram: true });
    }
    db.run(
      "INSERT INTO index_state(key, value, updated_at) VALUES ('schema_version', ?, '') " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [String(version)],
    );
    // The chunker stamp every real index carries: with it current, an
    // index on the current schema needs no repair beyond its schema.
    db.run(
      "INSERT INTO index_state(key, value, updated_at) VALUES ('chunker_version', ?, '') " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [String(CHUNKER_VERSION)],
    );
    db.exec("COMMIT");
  } finally {
    db.close(true);
  }
}

/**
 * The in-place upgrade another process performs: the migrations that
 * bring the file to the current schema, and nothing else.
 */
function upgradeFileInPlace(path: string): void {
  const db = new Database(path);
  try {
    applyMigrations(db, { ftsTokenize: DEFAULT_FTS_TOKENIZE, trigram: true });
  } finally {
    db.close(true);
  }
}

function schemaVersionOf(path = dbPath): number {
  const db = new Database(path, { readonly: true });
  try {
    return readSchemaVersion(db);
  } finally {
    db.close(true);
  }
}

/**
 * An index whose migration cannot run: its `chunks` table is a view, and the
 * v18 migration renames a column of that table - which a view has no column
 * to rename. The migration rolls back, and the failure it raised is what the
 * upgrade throws.
 */
function breakTheMigration(): void {
  const db = new Database(dbPath);
  try {
    db.exec("DROP TABLE chunks");
    db.exec("CREATE VIEW chunks AS SELECT 1 AS id, '' AS content, '' AS heading_path");
  } finally {
    db.close(true);
  }
}

test("the plan names an older schema an in-place upgrade and a current index nothing", () => {
  const cfg = makeConfig({ vault, dbPath });
  buildIndexAtVersion(LATEST_SCHEMA_VERSION - 1);
  expect(inspectIndex(cfg)).toBe("older-schema");
  expect(planIndexRepair(cfg)).toEqual({ kind: "upgrade-in-place" });

  buildIndexAtVersion(LATEST_SCHEMA_VERSION);
  expect(inspectIndex(cfg)).toBe("current");
  expect(planIndexRepair(cfg)).toEqual({ kind: "current" });
});

test("the status of an index on an older schema is answered, and the index is upgraded in place", async () => {
  const cfg = makeConfig({ vault, dbPath });
  buildIndexAtVersion(LATEST_SCHEMA_VERSION - 1);
  expect(schemaVersionOf()).toBe(LATEST_SCHEMA_VERSION - 1);

  const status = await indexStatus(cfg);

  expect(status.exists).toBe(true);
  expect(status.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
  // The upgrade happened in place: the same file, the current schema.
  expect(schemaVersionOf()).toBe(LATEST_SCHEMA_VERSION);
});

test("the status of an index no upgrade can repair keeps the rebuild advice", async () => {
  const cfg = makeConfig({ vault, dbPath });
  buildIndexAtVersion(LATEST_SCHEMA_VERSION);
  // A file stamped newer than this binary knows: no upgrade can repair it.
  const db = new Database(dbPath);
  try {
    db.run("UPDATE index_state SET value = ? WHERE key = 'schema_version'", [
      String(LATEST_SCHEMA_VERSION + 1),
    ]);
  } finally {
    db.close(true);
  }

  await expect(indexStatus(cfg)).rejects.toThrow(/o2b search reindex/);
});

test("a status of an index that was never built still reports no index", async () => {
  const cfg = makeConfig({ vault, dbPath });
  const status = await indexStatus(cfg);
  expect(status.exists).toBe(false);
  expect(status.schemaVersion).toBe(null);
});

test("an index on an older schema is answered with the current schema, not with a refusal", async () => {
  const cfg = makeConfig({ vault, dbPath });
  writeMd(vault, "notes/heron.md", "# Heron\n\nGrey herons wade in shallow water.\n");
  buildIndexAtVersion(LATEST_SCHEMA_VERSION - 1);

  const status = await indexStatus(cfg);

  expect(status.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
  expect(status.warnings.join(" ")).not.toContain("o2b search reindex");
});

test("a read whose index another process made current is answered, not refused", async () => {
  const cfg = makeConfig({ vault, dbPath });
  buildIndexAtVersion(LATEST_SCHEMA_VERSION - 1);
  expect(schemaVersionOf()).toBe(LATEST_SCHEMA_VERSION - 1);

  // The race the plan has to survive: the open is refused for the old
  // schema, and the index is made current before the plan that follows
  // the refusal is taken. The index is readable then, so it is read.
  const realOpen = Store.open.bind(Store);
  let upgraded = false;
  const spy = spyOn(Store, "open").mockImplementation(async (config, opts) => {
    try {
      return await realOpen(config, opts);
    } catch (e) {
      if (!upgraded) {
        upgraded = true;
        upgradeFileInPlace(config.dbPath);
      }
      throw e;
    }
  });
  try {
    const store = await openReadWithUpgrade(cfg);
    await store.close();
  } finally {
    spy.mockRestore();
  }

  expect(upgraded).toBe(true);
  expect(schemaVersionOf()).toBe(LATEST_SCHEMA_VERSION);
});

test("a failed in-place upgrade is the refusal with its rebuild advice, not the raw failure", async () => {
  const cfg = makeConfig({ vault, dbPath });
  buildIndexAtVersion(LATEST_SCHEMA_VERSION - 1);
  breakTheMigration();

  const refusal = await openReadWithUpgrade(cfg).then(
    () => null,
    (e: unknown) => e,
  );

  // The refusal the read started with: the schema mismatch and the advice
  // that answers it, which is what a rebuild would repair.
  expect(refusal).toBeInstanceOf(SearchError);
  expect((refusal as SearchError).code).toBe("SCHEMA_MISMATCH");
  expect((refusal as SearchError).message).toContain("o2b search reindex");
  // The failure that stopped the upgrade is kept as the cause, not lost.
  const cause = (refusal as SearchError).cause;
  expect(cause).toBeInstanceOf(Error);
  expect((cause as Error).message).toContain("chunks");
  // And the index is untouched: the upgrade rolled back.
  expect(schemaVersionOf()).toBe(LATEST_SCHEMA_VERSION - 1);
});

test("a lock failure of the in-place upgrade stays a lock error, not rebuild advice", async () => {
  const cfg = makeConfig({ vault, dbPath });
  buildIndexAtVersion(LATEST_SCHEMA_VERSION - 1);

  // Another writer holds the index: a rebuild would only queue behind it,
  // so the lock error is the answer and the rebuild advice is not.
  const lease = await acquireWriterLease(dbPath);
  try {
    const refusal = await openReadWithUpgrade(cfg).then(
      () => null,
      (e: unknown) => e,
    );

    expect(refusal).toBeInstanceOf(SearchError);
    expect((refusal as SearchError).code).toBe("INDEX_LOCKED");
    expect((refusal as SearchError).message).not.toContain("o2b search reindex");
  } finally {
    lease.release();
  }
}, 20_000);
