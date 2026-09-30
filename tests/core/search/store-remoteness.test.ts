/**
 * The remoteness decision at the index open.
 *
 * A vault's index can live on a network filesystem: `search_db_path`
 * overrides the default in-vault location, and pointing it at an NFS or
 * SMB mount is precisely the deployment that breaks under WAL, whose
 * shared-memory index needs locking semantics network filesystems do not
 * provide. The response is deliberately the smaller hammer: on a backing
 * the vault-backing probe classifies remote, the write open skips WAL
 * (stays on the DELETE journal mode a fresh file already has) and says so
 * on stderr - no refusal, no escape-hatch env, no silent flip.
 *
 * The probe is injected: simulating an NFS backing needs no real mount.
 */

import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

import {
  journalModeForBacking,
  openReadDatabase,
  openWriteDatabase,
} from "../../../src/core/search/store/lifecycle.ts";
import { probeVaultBacking } from "../../../src/core/vault-backing.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

/** Linux NFS_SUPER_MAGIC. */
const NFS = 0x6969;
/** Linux CIFS_SUPER_MAGIC. */
const CIFS = 0xff534d42;
const EXT4 = 0xef53;
const TMPFS = 0x01021994;
const FUSE = 0x65735546;
/** A magic number no released filesystem uses; stands for "not in the table". */
const UNRECOGNISED = 0x0badf00d;

describe("journalModeForBacking, the pure decision", () => {
  const DB = "/vault/.open-second-brain/brain.sqlite";

  test("named network filesystems skip WAL and name themselves and the path", () => {
    for (const [magic, name] of [
      [NFS, "nfs"],
      [CIFS, "cifs"],
    ] as const) {
      const backing = probeVaultBacking("/vault/.open-second-brain", {
        platform: "linux",
        statfs: () => ({ type: magic }),
      });
      const decision = journalModeForBacking(backing, DB);
      expect(`${name}: ${decision.journalMode}`).toBe(`${name}: delete`);
      expect(decision.warning).toContain(`backed by ${name}`);
      expect(decision.warning).toContain(DB);
    }
  });

  test("every silent or known-local backing keeps WAL with no warning", () => {
    for (const magic of [EXT4, TMPFS, FUSE, UNRECOGNISED]) {
      const backing = probeVaultBacking("/vault/.open-second-brain", {
        platform: "linux",
        statfs: () => ({ type: magic }),
      });
      const decision = journalModeForBacking(backing, DB);
      expect(`${magic}: ${decision.journalMode}`).toBe(`${magic}: wal`);
      expect(decision.warning).toBeNull();
    }
  });

  test("a platform with no statfs keeps WAL and stays silent", () => {
    const backing = probeVaultBacking("/vault/.open-second-brain", {
      platform: "darwin",
      statfs: () => ({ type: NFS }),
    });
    const decision = journalModeForBacking(backing, DB);
    expect(decision.journalMode).toBe("wal");
    expect(decision.warning).toBeNull();
  });
});

/** The stderr lines a write open emits, with console restored afterwards. */
function captureStderr(): { lines: () => string[]; done: () => void } {
  const lines: string[] = [];
  const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  return { lines: () => lines, done: () => spy.mockRestore() };
}

describe("openWriteDatabase on a remote backing", () => {
  test("opens with WAL off, says so once, and leaves the vault working", async () => {
    const v = createTempVault("store-remote");
    const note = writeMd(v.vault, "Notes/note.md", "# Kept\n\nthe open must not touch this\n");
    const config = makeConfig({ vault: v.vault, dbPath: v.dbPath });
    const stderr = captureStderr();
    let opened: Awaited<ReturnType<typeof openWriteDatabase>> | null = null;
    try {
      opened = await openWriteDatabase(config, false, {
        statfs: () => ({ type: NFS }),
      });

      // The decision is read back from the file, not from memory: the
      // journal mode the connection actually runs under is DELETE.
      const mode = opened.db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
      expect(mode?.journal_mode).toBe("delete");

      // One stderr warning, naming the filesystem it classified.
      const warnings = stderr.lines().filter((line) => line.includes("network filesystem"));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("nfs");

      // The open is a working write open, not a refuse: data written
      // through it survives.
      opened.db.exec("CREATE TABLE remoteness_probe (v TEXT)");
      opened.db.exec("INSERT INTO remoteness_probe (v) VALUES ('kept')");
      opened.db.close(true);
      await opened.release();
      opened = null;

      // The vault's own data is untouched, and the row is readable fresh.
      expect(readFileSync(note, "utf8")).toContain("the open must not touch this");
      const reread = new Database(v.dbPath);
      try {
        const row = reread.query<{ v: string }, []>("SELECT v FROM remoteness_probe").get();
        expect(row?.v).toBe("kept");
      } finally {
        reread.close(true);
      }
    } finally {
      stderr.done();
      if (opened) {
        opened.db.close(true);
        await opened.release();
      }
      v.cleanup();
    }
  });

  test("the default local classification keeps WAL and stays silent", async () => {
    const v = createTempVault("store-local");
    const config = makeConfig({ vault: v.vault, dbPath: v.dbPath });
    const stderr = captureStderr();
    let opened: Awaited<ReturnType<typeof openWriteDatabase>> | null = null;
    try {
      // No injected probe: the real statfs answers for the temp vault,
      // which is a local disk or tmpfs - either way non-remote.
      opened = await openWriteDatabase(config, false);

      const mode = opened.db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
      expect(mode?.journal_mode).toBe("wal");
      expect(stderr.lines().join("\n")).not.toContain("network filesystem");
    } finally {
      stderr.done();
      if (opened) {
        opened.db.close(true);
        await opened.release();
      }
      v.cleanup();
    }
  });
});

/** A migrated index left in WAL, with a second connection holding it open. */
async function walIndex(label: string) {
  const v = createTempVault(label);
  const config = makeConfig({ vault: v.vault, dbPath: v.dbPath });
  const seeded = await openWriteDatabase(config, false);
  seeded.db.close(true);
  await seeded.release();
  const holder = new Database(v.dbPath);
  holder.query("SELECT count(*) FROM sqlite_master").get();
  return { v, config, holder };
}

describe("a journal-mode switch another connection blocks", () => {
  // `PRAGMA journal_mode = delete` on an index in WAL fails at once with
  // "database is locked" while any other connection has the file open,
  // busy timeout or not. That is a mode the open could not change, not a
  // broken index: the read open keeps WAL (a read is correct in it), and
  // the write open keeps it too and says so, instead of a raw error or an
  // INDEX_UNREADABLE that would trigger a full reindex.

  test("the read open keeps WAL, opens, and says nothing", async () => {
    const { v, config, holder } = await walIndex("store-busy-read");
    const stderr = captureStderr();
    try {
      const opened = openReadDatabase(config, false, { statfs: () => ({ type: NFS }) });
      try {
        const mode = opened.db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
        expect(mode?.journal_mode).toBe("wal");
      } finally {
        opened.db.close(true);
      }
      // Read opens happen per query: a blocked switch there is silent.
      expect(stderr.lines()).toEqual([]);
    } finally {
      stderr.done();
      holder.close(true);
      v.cleanup();
    }
  });

  test("the write open keeps WAL, opens, and warns once per path across opens", async () => {
    const { v, config, holder } = await walIndex("store-busy-write");
    const stderr = captureStderr();
    let opened: Awaited<ReturnType<typeof openWriteDatabase>> | null = null;
    try {
      opened = await openWriteDatabase(config, false, { statfs: () => ({ type: NFS }) });
      const mode = opened.db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
      expect(mode?.journal_mode).toBe("wal");
      opened.db.close(true);
      await opened.release();
      // The second write open meets the same blocked switch and stays quiet.
      opened = await openWriteDatabase(config, false, { statfs: () => ({ type: NFS }) });
      const again = opened.db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
      expect(again?.journal_mode).toBe("wal");
      const busy = stderr.lines().filter((line) => line.includes("journal mode stays WAL"));
      expect(busy).toHaveLength(1);
      expect(busy[0]).toContain(v.dbPath);
    } finally {
      stderr.done();
      if (opened) {
        opened.db.close(true);
        await opened.release();
      }
      holder.close(true);
      v.cleanup();
    }
  });
});
