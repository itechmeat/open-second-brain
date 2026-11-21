/**
 * The reindex swap moves the database as a set: the main file and the
 * `-wal`, `-shm` and `-journal` SQLite keeps beside it under its name.
 *
 * A writer killed after it committed to the WAL and before a checkpoint
 * leaves a non-empty `-wal` at the live path. SQLite finds a WAL by name
 * alone, so a rebuild that renamed only the main files replayed those
 * frames into the new index on its next open: pages of the old database
 * written over the new one. The previous index then went to `.bak` without
 * its WAL, and the rebuild deleted that `.bak` as redundant.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, renameSync, statSync } from "node:fs";
import { Database } from "bun:sqlite";

import { indexVault, reindexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("reindex-siblings"));
});
afterEach(() => cleanup());

/**
 * A writer that commits `rows` rows into a new table through the WAL and
 * is killed before it closes, so nothing checkpoints them.
 */
async function killCommittedWalWriter(path: string, rows: number): Promise<void> {
  const script =
    'const { Database } = require("bun:sqlite");' +
    "const db = new Database(process.argv[1]);" +
    'db.exec("PRAGMA journal_mode = WAL");' +
    'db.exec("PRAGMA wal_autocheckpoint = 0");' +
    'db.exec("CREATE TABLE stale_writer (id INTEGER PRIMARY KEY, pad TEXT)");' +
    'const insert = db.prepare("INSERT INTO stale_writer(pad) VALUES (?)");' +
    `for (let i = 0; i < ${rows}; i++) insert.run("x".repeat(200));` +
    'process.kill(process.pid, "SIGKILL");';
  const child = Bun.spawn([process.execPath, "-e", script, path], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await child.exited;
}

test.skipIf(process.platform === "win32")(
  "a stale committed WAL at the live path is not replayed into the rebuilt index",
  async () => {
    writeMd(vault, "a.md", "# Herons\n\nGrey herons wade in shallow water.\n");
    writeMd(vault, "b.md", "# Egrets\n\nLittle egrets fish at dawn.\n");
    const cfg = makeConfig({ vault, dbPath });
    await indexVault(cfg);
    await killCommittedWalWriter(dbPath, 300);
    // Non-vacuous: the killed writer left committed frames behind.
    expect(statSync(dbPath + "-wal").size).toBeGreaterThan(0);

    writeMd(vault, "c.md", "# Cranes\n\nCranes dance in the reeds.\n");
    const stats = await reindexVault(cfg);
    expect(stats.added).toBe(3);

    // Nothing of the old database is left at the live path's name.
    for (const suffix of ["-journal"]) expect(existsSync(dbPath + suffix)).toBe(false);
    if (existsSync(dbPath + "-wal")) expect(statSync(dbPath + "-wal").size).toBe(0);

    const db = new Database(dbPath);
    try {
      const check = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all();
      expect(check.map((r) => r.integrity_check)).toEqual(["ok"]);
      const stale = db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'stale_writer'",
        )
        .get()!.n;
      expect(stale).toBe(0);
      expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM documents").get()!.n).toBe(3);
    } finally {
      db.close(true);
    }
    const outcome = await search(cfg, { query: "cranes", recordAccess: false });
    expect(outcome.results.map((r) => r.path)).toContain("c.md");
  },
);

/** Rows the killed writer committed, read through a plain open of `path`. */
function staleRows(path: string): number {
  const db = new Database(path, { readonly: true });
  try {
    return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM stale_writer").get()!.n;
  } finally {
    db.close(true);
  }
}

for (const crash of ["after the main file moved", "after the whole set moved"] as const) {
  test.skipIf(process.platform === "win32")(
    `a crash ${crash} to .bak restores the previous index with its last commits`,
    async () => {
      writeMd(vault, "a.md", "# Herons\n\nGrey herons wade.\n");
      const cfg = makeConfig({ vault, dbPath });
      await indexVault(cfg);
      await killCommittedWalWriter(dbPath, 50);
      // The state a swap leaves when it dies between its renames.
      renameSync(dbPath, dbPath + ".bak");
      if (crash === "after the whole set moved") {
        for (const suffix of ["-wal", "-shm"]) {
          if (existsSync(dbPath + suffix)) renameSync(dbPath + suffix, dbPath + ".bak" + suffix);
        }
      }

      // Any open runs the crash restore.
      await search(cfg, { query: "herons", recordAccess: false });

      expect(existsSync(dbPath + ".bak")).toBe(false);
      expect(existsSync(dbPath + ".bak-wal")).toBe(false);
      expect(staleRows(dbPath)).toBe(50);
    },
  );
}
