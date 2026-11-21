/**
 * A `quick_check` that raises is damage only when SQLite says the file is
 * damaged (SQLITE_CORRUPT, SQLITE_NOTADB). Any other raise (an I/O error,
 * a busy file) is inconclusive: no caller may condemn, record or roll
 * back a file on it.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runIntegrityCheck } from "../../../src/core/search/store/lifecycle.ts";

let dir: string;

beforeEach(() => {
  dir = join(
    tmpdir(),
    `o2b-integrity-verdict-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A connection whose scan raises `code`, as SQLite reports it. */
function raising(code: string): Database {
  return {
    query: () => ({
      all: () => {
        throw Object.assign(new Error(`${code}: simulated`), { name: "SQLiteError", code });
      },
    }),
  } as unknown as Database;
}

test("an I/O error or a busy file during the scan is inconclusive, not a fault", () => {
  for (const code of ["SQLITE_IOERR_READ", "SQLITE_BUSY", "SQLITE_NOMEM", "SQLITE_INTERRUPT"]) {
    const verdict = runIntegrityCheck(raising(code));
    expect(verdict).toMatchObject({ ok: false, inconclusive: true });
  }
});

test("corruption raised mid-scan is a fault", () => {
  for (const code of ["SQLITE_CORRUPT", "SQLITE_CORRUPT_INDEX", "SQLITE_NOTADB"]) {
    const verdict = runIntegrityCheck(raising(code));
    expect(verdict.ok).toBe(false);
    expect("inconclusive" in verdict).toBe(false);
  }
});

test("a file that is not a database is a fault, read from disk", () => {
  const path = join(dir, "x.sqlite");
  writeFileSync(path, "not a database, only bytes. ".repeat(200));
  const db = new Database(path);
  try {
    const verdict = runIntegrityCheck(db);
    expect(verdict.ok).toBe(false);
    expect("inconclusive" in verdict).toBe(false);
  } finally {
    db.close(true);
  }
});
