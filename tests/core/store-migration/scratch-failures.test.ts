/**
 * A scratch write that fails (a full disk, an I/O error) fails the run
 * that made it (change migration-memory-peak, follow-up 1). It is never
 * taken for a store shard that cannot be read, never for a torn journal
 * row, and never leaves a map answering from a partial copy: a journal
 * built over a failed write would import items a second time.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { forEachPartitionRecord } from "../../../src/core/store/state-digest.ts";
import { partitionDir } from "../../../src/core/store/store-paths.ts";
import { journalScopeFor } from "../../../src/core/store-migration/backup.ts";
import {
  journalFromStore,
  loadJournalAndUnmarked,
  migrationDir,
  readJournal,
} from "../../../src/core/store-migration/journal.ts";
import { runMigration } from "../../../src/core/store-migration/migrate.ts";
import { MigrationScratch } from "../../../src/core/store-migration/spill-map.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import { makeMigrationBench, type MigrationBench } from "./fixtures/migration-env.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

/** A scratch whose write number `failAt` and every later one fails, as a disk that fills does. */
class FailingScratch extends MigrationScratch {
  private writes = 0;
  constructor(
    dir: string,
    private readonly failAt: number,
    spillAt = 0,
  ) {
    super(dir, { spillAt });
  }
  override wrote(): void {
    this.writes += 1;
    if (this.writes >= this.failAt) throw new Error("injected: disk full");
    super.wrote();
  }
}

let bench: MigrationBench | null = null;
let dirs: string[] = [];
afterEach(() => {
  bench?.cleanup();
  bench = null;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function migrated(): MigrationBench {
  bench = makeMigrationBench("osb-scratch-fail-");
  expect(runMigration(bench.vault, { settleMs: 0 }).ok).toBe(true);
  return bench;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "osb-scratch-fail-dir-"));
  dirs.push(dir);
  return dir;
}

test("a throw of a record visitor ends the walk; it is no unreadable shard", () => {
  const b = migrated();
  const unreadable: string[] = [];
  let visited = 0;
  expect(() =>
    forEachPartitionRecord(
      partitionDir(b.storeRoot, "shared"),
      { onUnreadable: (s) => unreadable.push(s.rel) },
      {
        record: () => {
          visited += 1;
          if (visited === 2) throw new Error("injected: visitor");
        },
      },
    ),
  ).toThrow("injected: visitor");
  expect(visited).toBe(2);
  expect(unreadable).toEqual([]);
});

test("a journal built from the store fails on a scratch write that fails", () => {
  const b = migrated();
  const store = b.store();
  const dir = migrationDir(store);
  const scope = journalScopeFor(b.vault, store.device, dir);
  for (const failAt of [1, 5]) {
    const scratch = new FailingScratch(tempDir(), failAt);
    expect(() => loadJournalAndUnmarked(dir, store, scope, scratch)).toThrow("injected: disk full");
    scratch.close();
    const again = new FailingScratch(tempDir(), failAt);
    expect(() => journalFromStore(store, scope, undefined, again)).toThrow("injected: disk full");
    again.close();
  }
});

test("a journal file row the scratch cannot keep fails the read; it is no torn row", () => {
  const b = migrated();
  const store = b.store();
  const dir = migrationDir(store);
  const scope = journalScopeFor(b.vault, store.device, dir);
  // The journal file holds a row per item the migration imported.
  expect(readJournal(dir, scope).size).toBeGreaterThan(3);
  const scratch = new FailingScratch(tempDir(), 3);
  expect(() => readJournal(dir, scope, scratch)).toThrow("injected: disk full");
  scratch.close();
});

test("a map whose move to disk fails keeps answering from memory, and refuses to grow", () => {
  const scratch = new FailingScratch(tempDir(), 2, 3);
  const map = scratch.map();
  for (const key of ["a", "b", "c"]) map.set(key, key.toUpperCase());
  // The fourth entry passes the threshold; the copy fails on its second row.
  expect(() => map.set("d", "D")).toThrow("injected: disk full");
  expect(map.spilled).toBe(false);
  for (const key of ["a", "b", "c", "d"]) expect(map.get(key)).toBe(key.toUpperCase());
  expect(map.size).toBe(4);
  // Every later use of the scratch throws the same failure.
  expect(() => map.set("e", "E")).toThrow("injected: disk full");
  scratch.close();
});

test("a failure after the move to disk is thrown again by every later use", () => {
  const scratch = new FailingScratch(tempDir(), 4, 1);
  const map = scratch.map();
  map.set("a", "1");
  map.set("b", "2"); // moved to disk: two writes
  map.set("c", "3"); // the third write
  expect(() => map.set("d", "4")).toThrow("injected: disk full");
  expect(() => map.get("a")).toThrow("injected: disk full");
  expect(() => [...map.entries()]).toThrow("injected: disk full");
  scratch.close();
});
