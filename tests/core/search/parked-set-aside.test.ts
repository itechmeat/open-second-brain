/**
 * `o2b search set-aside`: a parked index leaves its parked name as the
 * whole SQLite file set it is, into a folder of its own, and nothing is
 * deleted. A main file moved without its `-wal` would lose the commits
 * that were only in that log; the set mover takes them along.
 */

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";

import { indexVault, reindexVault } from "../../../src/core/search/indexer.ts";
import { releaseCommand } from "../../../src/core/search/parked-index.ts";
import { setAsideParkedIndex } from "../../../src/core/search/parked-set-aside.ts";
import { parkMarkerPath, writeParkMarker } from "../../../src/core/search/store/lifecycle.ts";
import {
  acquireWriterLeaseSync,
  type WriterLease,
} from "../../../src/core/search/store/writer-lock.ts";
import { CHMOD_CANNOT_DENY } from "../../helpers/platform.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("parked-set-aside"));
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec("CREATE TABLE t(v TEXT); INSERT INTO t VALUES ('live')");
  db.close(true);
});
afterEach(() => cleanup());

/**
 * A parked index whose last commit is only in its `-wal`: the files are
 * copied while the writer still holds them, before any checkpoint.
 */
function parkWithWal(parked: string): void {
  const writer = new Database(dbPath + ".writer");
  writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
  writer.exec("CREATE TABLE t(v TEXT); INSERT INTO t VALUES ('in-main')");
  writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  writer.exec("INSERT INTO t VALUES ('only-in-wal')");
  copyFileSync(dbPath + ".writer", parked);
  copyFileSync(dbPath + ".writer-wal", parked + "-wal");
  writer.close(false);
}

test("the parked index moves with its -wal, and the moved copy keeps the commit only the log held", async () => {
  parkWithWal(dbPath + ".bak");
  expect(statSync(dbPath + ".bak-wal").size).toBeGreaterThan(0);

  const r = await setAsideParkedIndex(dbPath, "bak", true, new Date("2026-11-22T10:00:00Z"));

  expect(r.applied).toBe(true);
  expect(r.files).toEqual([dbPath + ".bak", dbPath + ".bak-wal"]);
  expect(existsSync(dbPath + ".bak")).toBe(false);
  expect(existsSync(dbPath + ".bak-wal")).toBe(false);
  expect(r.folder).toBe(join(dbPath, "..", "set-aside", "2026-11-22T10-00-00-000Z-bak"));
  expect(readdirSync(r.folder).toSorted()).toEqual(["brain.sqlite.bak", "brain.sqlite.bak-wal"]);
  const moved = new Database(join(r.folder, "brain.sqlite.bak"));
  const rows = moved.query<{ v: string }, []>("SELECT v FROM t ORDER BY v").all();
  moved.close(false);
  expect(rows.map((x) => x.v)).toEqual(["in-main", "only-in-wal"]);
  // The live index is untouched.
  expect(existsSync(dbPath)).toBe(true);
});

test("without --apply nothing moves", async () => {
  writeFileSync(dbPath + ".old", "parked bytes");

  const r = await setAsideParkedIndex(dbPath, "old", false);

  expect(r.applied).toBe(false);
  expect(r.files).toEqual([dbPath + ".old"]);
  expect(existsSync(dbPath + ".old")).toBe(true);
  expect(existsSync(r.folder)).toBe(false);
});

test("a parked name that holds nothing is refused", async () => {
  await expect(setAsideParkedIndex(dbPath, "old", true)).rejects.toThrow(
    "there is no parked index",
  );
});

test("a swap that stopped part way is refused: the parked set may be the one it puts back", async () => {
  // The live main file was parked and the swap stopped before its journals
  // followed: the record of the swap is still beside the index.
  copyFileSync(dbPath, dbPath + ".bak");
  writeFileSync(parkMarkerPath(dbPath), ".bak\n");
  writeFileSync(dbPath + "-wal", "");
  // Only the main file goes: its journal and the swap's record stay.
  rmSync(dbPath);

  await expect(setAsideParkedIndex(dbPath, "bak", true)).rejects.toThrow("stopped part way");
  expect(existsSync(dbPath + ".bak")).toBe(true);
});

/**
 * The state a set-aside killed after `moved` of its renames leaves: its
 * folder, its record (written before the first rename) and the parked set
 * split between the parked name and the folder, main file first. `moved`
 * 4 is a kill after the last rename, before the record was cleared.
 */
function killedSetAside(moved: number): string {
  parkWithWal(dbPath + ".bak");
  writeFileSync(dbPath + ".bak-shm", "");
  const folder = join(dirname(dbPath), "set-aside", "2026-11-22T09-00-00-000Z-bak");
  mkdirSync(folder, { recursive: true });
  const stem = join(folder, "brain.sqlite");
  writeParkMarker(stem, stem + ".bak");
  for (const suffix of ["", "-wal", "-shm"].slice(0, moved)) {
    renameSync(dbPath + ".bak" + suffix, stem + ".bak" + suffix);
  }
  return folder;
}

/** The killed set-aside, finished: the whole set in its folder, the commit only the log held kept. */
function expectFinished(folder: string): void {
  expect(readdirSync(folder).toSorted()).toEqual([
    "brain.sqlite.bak",
    "brain.sqlite.bak-shm",
    "brain.sqlite.bak-wal",
  ]);
  for (const suffix of ["", "-wal", "-shm"])
    expect(existsSync(dbPath + ".bak" + suffix)).toBe(false);
  const moved = new Database(join(folder, "brain.sqlite.bak"));
  const rows = moved.query<{ v: string }, []>("SELECT v FROM t ORDER BY v").all();
  moved.close(false);
  expect(rows.map((x) => x.v)).toEqual(["in-main", "only-in-wal"]);
}

for (const moved of [0, 1, 2, 3, 4]) {
  test(`a set-aside killed after ${moved} of its renames is finished by the next set-aside`, async () => {
    const folder = killedSetAside(moved);

    const r = await setAsideParkedIndex(dbPath, "bak", true);

    expect(r.applied).toBe(true);
    expect(r.folder).toBe(folder);
    expectFinished(folder);
  });

  test(`a set-aside killed after ${moved} of its renames is finished by the next rebuild`, async () => {
    rmSync(dbPath);
    writeMd(vault, "a.md", "# Herons\n\nGrey herons wade in shallow water.\n");
    const cfg = makeConfig({ vault, dbPath });
    await indexVault(cfg);
    const folder = killedSetAside(moved);

    // Without the record the rebuild would park the live index at the
    // free .bak name and clear the journals it finds there first.
    await reindexVault(cfg);

    expectFinished(folder);
  });
}

test("a set-aside folder that already exists is refused, and nothing moves", async () => {
  writeFileSync(dbPath + ".bak", "parked bytes");
  const now = new Date("2026-11-22T10:00:00Z");
  const folder = join(dirname(dbPath), "set-aside", "2026-11-22T10-00-00-000Z-bak");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "brain.sqlite.bak"), "an earlier set");

  await expect(setAsideParkedIndex(dbPath, "bak", true, now)).rejects.toThrow("already exists");
  expect(existsSync(dbPath + ".bak")).toBe(true);
  expect(readdirSync(folder)).toEqual(["brain.sqlite.bak"]);
});

test("two set-asides of one name: the second finds it gone under the lock and moves nothing", async () => {
  writeFileSync(dbPath + ".old", "parked bytes");

  const results = await Promise.allSettled([
    setAsideParkedIndex(dbPath, "old", true, new Date("2026-11-22T10:00:00Z")),
    setAsideParkedIndex(dbPath, "old", true, new Date("2026-11-22T10:00:01Z")),
  ]);

  expect(results.map((r) => r.status).toSorted()).toEqual(["fulfilled", "rejected"]);
  expect(readdirSync(join(dirname(dbPath), "set-aside"))).toHaveLength(1);
});

test("the refusal after a stopped swap names the index it is about", async () => {
  copyFileSync(dbPath, dbPath + ".bak");
  writeFileSync(parkMarkerPath(dbPath), ".bak\n");
  rmSync(dbPath);
  const target = {
    dbPath,
    vaultPath: null,
    configPath: null,
    defaultDbPath: "/default/brain.sqlite",
    defaultVaultPath: null,
    defaultConfigPath: null,
  };

  await expect(setAsideParkedIndex(dbPath, "bak", true, new Date(), target)).rejects.toThrow(
    `run ${releaseCommand(target, "o2b search reindex")},`,
  );
});

test("a set-aside directory read error stops before the parked name can be reused", async () => {
  writeFileSync(dbPath + ".bak", "parked bytes");
  const root = join(dirname(dbPath), "set-aside");
  mkdirSync(root);
  const realReaddir = fs.readdirSync;
  const spy = spyOn(fs, "readdirSync").mockImplementation(((
    ...args: Parameters<typeof fs.readdirSync>
  ) => {
    if (String(args[0]) === root) throw Object.assign(new Error("simulated EIO"), { code: "EIO" });
    return realReaddir(...args);
  }) as typeof fs.readdirSync);
  try {
    await expect(setAsideParkedIndex(dbPath, "bak", true)).rejects.toThrow();
    expect(existsSync(dbPath + ".bak")).toBe(true);
  } finally {
    spy.mockRestore();
  }
});

test("a rebuild preserves parked journals when set-aside discovery fails", async () => {
  rmSync(dbPath);
  writeMd(vault, "a.md", "# Herons\n\nGrey herons wade in shallow water.\n");
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg);
  copyFileSync(dbPath, dbPath + ".bak");
  writeFileSync(dbPath + ".bak-wal", "committed journal bytes");
  const root = join(dirname(dbPath), "set-aside");
  mkdirSync(root);
  const realReaddir = fs.readdirSync;
  const spy = spyOn(fs, "readdirSync").mockImplementation(((
    ...args: Parameters<typeof fs.readdirSync>
  ) => {
    if (String(args[0]) === root) throw Object.assign(new Error("simulated EIO"), { code: "EIO" });
    return realReaddir(...args);
  }) as typeof fs.readdirSync);
  try {
    await expect(reindexVault(cfg)).rejects.toThrow();
    expect(existsSync(dbPath + ".bak-wal")).toBe(true);
  } finally {
    spy.mockRestore();
  }
});

test("an unreadable existing set-aside record stops recovery", async () => {
  writeFileSync(dbPath + ".bak", "parked bytes");
  const folder = join(dirname(dbPath), "set-aside", "interrupted-bak");
  mkdirSync(folder, { recursive: true });
  mkdirSync(parkMarkerPath(join(folder, "brain.sqlite")));

  await expect(setAsideParkedIndex(dbPath, "bak", true)).rejects.toThrow();
  expect(existsSync(dbPath + ".bak")).toBe(true);
});

test("a failed move after lease takeover keeps the successor's rewritten record", async () => {
  writeFileSync(dbPath + ".bak", "parked bytes");
  let successor: WriterLease | null = null;
  const folder = join(dirname(dbPath), "set-aside", "2026-11-22T10-00-00-000Z-bak");
  const marker = parkMarkerPath(join(folder, "brain.sqlite"));
  const realRename = fs.renameSync;
  let takeover = false;
  const spy = spyOn(fs, "renameSync").mockImplementation(
    (...args: Parameters<typeof fs.renameSync>) => {
      realRename(...args);
      if (!takeover && String(args[1]) === marker) {
        takeover = true;
        rmSync(dbPath + ".lock", { recursive: true, force: true });
        successor = acquireWriterLeaseSync(dbPath);
        writeParkMarker(join(folder, "brain.sqlite"), join(folder, "brain.sqlite.bak"));
      }
    },
  );
  try {
    await expect(
      setAsideParkedIndex(dbPath, "bak", true, new Date("2026-11-22T10:00:00Z")),
    ).rejects.toThrow();
    expect(existsSync(dbPath + ".bak")).toBe(true);
    expect(existsSync(join(folder, "brain.sqlite.bak"))).toBe(false);
    expect(existsSync(marker)).toBe(true);
  } finally {
    spy.mockRestore();
    (successor as WriterLease | null)?.release();
  }
});

test("a failed move keeps its record when destination inspection fails", async () => {
  writeFileSync(dbPath + ".bak", "parked bytes");
  const folder = join(dirname(dbPath), "set-aside", "2026-11-22T10-00-00-000Z-bak");
  const marker = parkMarkerPath(join(folder, "brain.sqlite"));
  const destination = join(folder, "brain.sqlite.bak");
  const realRename = fs.renameSync;
  const renameSpy = spyOn(fs, "renameSync").mockImplementation(
    (...args: Parameters<typeof fs.renameSync>) => {
      if (String(args[0]) === dbPath + ".bak" && String(args[1]) === destination)
        throw Object.assign(new Error("simulated EIO"), { code: "EIO" });
      realRename(...args);
    },
  );
  const realStat = fs.statSync;
  const statSpy = spyOn(fs, "statSync").mockImplementation(((
    ...args: Parameters<typeof fs.statSync>
  ) => {
    if (String(args[0]) === destination)
      throw Object.assign(new Error("simulated EACCES"), { code: "EACCES" });
    return realStat(...args);
  }) as typeof fs.statSync);
  try {
    await expect(
      setAsideParkedIndex(dbPath, "bak", true, new Date("2026-11-22T10:00:00Z")),
    ).rejects.toThrow();
    expect(existsSync(dbPath + ".bak")).toBe(true);
    expect(existsSync(marker)).toBe(true);
  } finally {
    statSpy.mockRestore();
    renameSpy.mockRestore();
  }
});

test("a set-aside whose move fails and is undone leaves no record for a rebuild to finish", async () => {
  // Moving a directory to another parent needs write access to it, so a
  // read-only directory in the -wal's place stops the move after the main
  // file went, and the mover brings the main file back.
  if (CHMOD_CANNOT_DENY) return;
  writeFileSync(dbPath + ".bak", "parked bytes");
  mkdirSync(dbPath + ".bak-wal");
  chmodSync(dbPath + ".bak-wal", 0o555);
  const folder = join(dirname(dbPath), "set-aside", "2026-11-22T10-00-00-000Z-bak");
  try {
    await expect(
      setAsideParkedIndex(dbPath, "bak", true, new Date("2026-11-22T10:00:00Z")),
    ).rejects.toThrow("moved back");

    expect(existsSync(dbPath + ".bak")).toBe(true);
    expect(readdirSync(folder)).toEqual([]);
  } finally {
    chmodSync(dbPath + ".bak-wal", 0o755);
  }
});

test("a dry run while a set-aside of that name is recorded names the folder the move finishes into", async () => {
  const folder = killedSetAside(0);

  const r = await setAsideParkedIndex(dbPath, "bak", false);

  expect(r.applied).toBe(false);
  expect(r.folder).toBe(folder);
  expect(existsSync(dbPath + ".bak")).toBe(true);
});
