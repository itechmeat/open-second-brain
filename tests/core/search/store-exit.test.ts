/**
 * Writer WAL-flush-on-exit registry (Indexer Durability suite,
 * t_672c751e). Mirrors sync-lockfile's process-exit hook: open writer
 * DB handles register themselves, and a synchronous best-effort
 * wal_checkpoint(TRUNCATE) runs for each on process exit / process.exit
 * paths where close() was bypassed. SQLite already replays an orphan
 * -wal on the next open, so this is a belt-and-suspenders consolidation
 * that must never throw out of the exit hook.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  flushRegisteredWriters,
  registerWriterDb,
  unregisterWriterDb,
  _resetWriterRegistryForTests,
} from "../../../src/core/search/store-exit.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-store-exit-"));
  _resetWriterRegistryForTests();
});

afterEach(() => {
  _resetWriterRegistryForTests();
  rmSync(tmp, { recursive: true, force: true });
});

function walDb(name: string): { db: Database; path: string } {
  const path = join(tmp, name);
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE t(x INTEGER)");
  db.exec("INSERT INTO t(x) VALUES (1), (2), (3)");
  return { db, path };
}

test("flush consolidates the WAL of a registered writer", () => {
  const { db, path } = walDb("a.sqlite");
  registerWriterDb(db);
  // A populated WAL exists before the flush.
  expect(existsSync(`${path}-wal`)).toBe(true);
  flushRegisteredWriters();
  // TRUNCATE checkpoint leaves the -wal at zero bytes (or removed).
  if (existsSync(`${path}-wal`)) {
    expect(statSync(`${path}-wal`).size).toBe(0);
  }
  db.close();
});

test("an unregistered writer is left untouched by the flush", () => {
  const { db } = walDb("b.sqlite");
  registerWriterDb(db);
  unregisterWriterDb(db);
  // No throw, and nothing to flush.
  expect(() => flushRegisteredWriters()).not.toThrow();
  db.close();
});

test("the flush never throws on an already-closed handle", () => {
  const { db } = walDb("c.sqlite");
  registerWriterDb(db);
  db.close();
  expect(() => flushRegisteredWriters()).not.toThrow();
});
