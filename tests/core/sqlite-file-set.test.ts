/**
 * A database set moves together or not at all: an undo that cannot bring
 * back a sibling leaves the main file where it went (a main file back at
 * its name without its `-wal` loses the commits in that log), and the
 * error names every file left at the destination.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  discardSqliteFileSet,
  parkSqliteFileSet,
  sqliteJournalsPresent,
  SqliteFileSetMoveError,
  unparkSqliteFileSet,
} from "../../src/core/sqlite-file-set.ts";

let dir: string;
let live: string;
let parked: string;

beforeEach(() => {
  dir = join(tmpdir(), `o2b-file-set-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  live = join(dir, "brain.sqlite");
  parked = `${live}.bak`;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function makeSet(path: string): void {
  for (const s of ["", "-wal", "-shm"]) writeFileSync(path + s, s || "main");
}

test("an orphan -shm is not a database journal, while WAL and rollback journals are", () => {
  writeFileSync(live + "-shm", "stale shared-memory index");
  expect(sqliteJournalsPresent(live)).toEqual([]);
  writeFileSync(live + "-wal", "write-ahead log");
  writeFileSync(live + "-journal", "rollback journal");
  expect(sqliteJournalsPresent(live).toSorted()).toEqual(
    [live + "-wal", live + "-journal"].toSorted(),
  );
});

/** A rename that fails for the listed `from -> to` moves and works otherwise. */
function failing(...moves: Array<[string, string]>) {
  return {
    platform: "linux" as NodeJS.Platform,
    rename: (from: string, to: string) => {
      if (moves.some(([f, t]) => f === from && t === to)) {
        throw Object.assign(new Error(`EIO: ${from}`), { code: "EIO" });
      }
      renameSync(from, to);
    },
  };
}

test("an undo that cannot bring back the -wal leaves the main file parked and names both", () => {
  makeSet(live);
  // Parking fails at -shm; the undo then cannot bring -wal back.
  const seams = failing([live + "-shm", parked + "-shm"], [parked + "-wal", live + "-wal"]);
  let caught: unknown;
  try {
    parkSqliteFileSet(live, parked, seams);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(SqliteFileSetMoveError);
  const err = caught as SqliteFileSetMoveError;
  // The main file stays with its log, never back at the live path alone.
  expect(existsSync(live)).toBe(false);
  expect(existsSync(parked)).toBe(true);
  expect(existsSync(parked + "-wal")).toBe(true);
  expect(err.stranded.toSorted()).toEqual([parked, parked + "-wal"].toSorted());
  expect(err.message).toContain(parked + "-wal");
});

test("an undo that brings every sibling back restores the main file last and strands nothing", () => {
  makeSet(live);
  const seams = failing([live + "-shm", parked + "-shm"]);
  let caught: unknown;
  try {
    parkSqliteFileSet(live, parked, seams);
  } catch (err) {
    caught = err;
  }
  const err = caught as SqliteFileSetMoveError;
  expect(err.stranded).toEqual([]);
  for (const s of ["", "-wal", "-shm"]) expect(existsSync(live + s)).toBe(true);
  expect(existsSync(parked)).toBe(false);
});

test("a lost owner stops later moves and leaves the moved file named as stranded", () => {
  makeSet(live);
  let checks = 0;
  const ownership = (): void => {
    checks += 1;
    if (checks > 1) throw new Error("writer lease lost");
  };
  let caught: unknown;
  try {
    parkSqliteFileSet(live, parked, undefined, ownership);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(SqliteFileSetMoveError);
  const err = caught as SqliteFileSetMoveError;
  expect(err.cause).toBeInstanceOf(Error);
  expect(err.stranded).toEqual([parked]);
  expect(existsSync(live + "-wal")).toBe(true);
  expect(existsSync(parked)).toBe(true);
});

test("an unpark whose main file cannot move leaves the siblings it moved back with their main file", () => {
  makeSet(parked);
  const seams = failing([parked, live]);
  expect(() => unparkSqliteFileSet(parked, live, seams)).toThrow(SqliteFileSetMoveError);
  for (const s of ["", "-wal", "-shm"]) expect(existsSync(parked + s)).toBe(true);
  expect(existsSync(live + "-wal")).toBe(false);
});

test("a discard that stops part way throws and leaves the main file, never a log without it", () => {
  makeSet(live);
  const seams = {
    platform: "linux" as NodeJS.Platform,
    unlink: (path: string) => {
      if (path === live + "-shm") throw Object.assign(new Error("EIO"), { code: "EIO" });
      rmSync(path);
    },
  };
  expect(() => discardSqliteFileSet(live, seams)).toThrow("EIO");
  // The -wal went first; the main file is kept and the caller is told.
  expect(existsSync(live + "-wal")).toBe(false);
  expect(existsSync(live)).toBe(true);
});
