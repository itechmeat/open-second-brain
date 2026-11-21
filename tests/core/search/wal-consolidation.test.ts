/**
 * A write close folds the index's WAL back and leaves DELETE mode. A
 * reader that still has the index open blocks the mode switch: that is
 * ordinary on the first search after an in-place upgrade, the index stays
 * in WAL mode (which every connection reads correctly) and the next write
 * close finishes the switch. It is not reported as a failure.
 */

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { Store } from "../../../src/core/search/store.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("wal-consolidation"));
  writeMd(vault, "a.md", "# Herons\n\nGrey herons wade in shallow water.\n");
});
afterEach(() => cleanup());

function journalMode(path: string): string {
  const db = new Database(path, { readonly: true });
  try {
    return db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()!.journal_mode;
  } finally {
    db.close(true);
  }
}

test("a reader that blocks the switch out of WAL mode is not reported, and the next close finishes it", async () => {
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg);
  const store = await Store.open(cfg, { mode: "write" });
  const reader = new Database(dbPath, { readonly: true });
  reader.query("SELECT COUNT(*) AS n FROM chunks").get();
  const err = spyOn(console, "error");
  try {
    await store.close();
    expect(err.mock.calls.map((c) => String(c[0]))).toEqual([]);
  } finally {
    err.mockRestore();
    reader.close(true);
  }
  // Non-vacuous: the switch was blocked, the index is still in WAL mode.
  expect(journalMode(dbPath)).toBe("wal");

  const again = await Store.open(cfg, { mode: "write" });
  await again.close();
  expect(journalMode(dbPath)).toBe("delete");
  expect(existsSync(`${dbPath}-wal`)).toBe(false);
});
