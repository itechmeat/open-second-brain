/**
 * A rebuild that recovered from a corrupt live index leaves the file it
 * parked beside the new index, and no later rebuild removes it: a parked
 * index whose stored embeddings cannot be counted is the only copy of
 * nothing, but the rule that keeps it cannot tell that apart from the one
 * copy of something. The rebuild says so at its end, and `o2b search
 * status` says it too, with the size, the reason and the step that
 * releases it.
 */

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

import { indexVault, reindexVault } from "../../../src/core/search/indexer.ts";
import {
  countStoredEmbeddings,
  parkedIndexStatus,
  type ParkedIndexTarget,
} from "../../../src/core/search/parked-index.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("parked-backup"));
  writeMd(vault, "a.md", "# Herons\n\nGrey herons wade in shallow water.\n");
  for (let i = 0; i < 20; i++)
    writeMd(vault, `n${i}.md`, `# Note ${i}\n\n${"Words of a note. ".repeat(60)}\n`);
});
afterEach(() => cleanup());

function withVectors(path: string, limit: number): void {
  const db = new Database(path);
  db.exec(
    "INSERT INTO embeddings(chunk_id, model, dimension, embedding_hash, created_at, updated_at) " +
      `SELECT id, 'probe', 4, 'h', '', '' FROM chunks LIMIT ${limit}`,
  );
  db.close(true);
}

function quickCheck(path: string): string {
  const db = new Database(path);
  try {
    return db.query<{ quick_check: string }, []>("PRAGMA quick_check(1)").get()!.quick_check;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  } finally {
    db.close(true);
  }
}

/** The files that sit beside the live index under a parked name. */
function parkedBeside(): string[] {
  return [".old", ".bak"].filter((s) => existsSync(dbPath + s));
}

test("a rebuild that recovered from a corrupt live index names the parked file it kept", async () => {
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg);
  // A good previous index parked at `.old`: what a rebuild that died
  // between the renames of its swap leaves behind.
  copyFileSync(dbPath, dbPath + ".old");
  // The live index is corrupt: bytes where the database header is.
  writeFileSync(dbPath, Buffer.from("not a database, only bytes. ".repeat(400)));

  const stats = await reindexVault(cfg);

  // The rebuild recovered: the new index is live and sound.
  expect(quickCheck(dbPath)).toBe("ok");
  // The corrupt file the swap parked is still beside it, and the rebuild
  // says so: which file, how big, why it is kept and how it is released.
  expect(parkedBeside()).toEqual([".bak"]);
  const kept = stats.keptParkedIndexes ?? [];
  expect(kept.length).toBe(1);
  expect(kept[0]!.path).toBe(dbPath + ".bak");
  expect(kept[0]!.bytes).toBeGreaterThan(0);
  expect(kept[0]!.reason).toBe("unreadable");
  expect(kept[0]!.release).toContain("o2b search set-aside bak --apply");
});

test("the next ordinary rebuild keeps the same parked file and says so again", async () => {
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg);
  copyFileSync(dbPath, dbPath + ".old");
  writeFileSync(dbPath, Buffer.from("not a database, only bytes. ".repeat(400)));

  await reindexVault(cfg);
  const second = await reindexVault(cfg);

  // The second rebuild is an ordinary one and it succeeds; the file the
  // first one parked is still there, and this rebuild names it too.
  expect(quickCheck(dbPath)).toBe("ok");
  expect(parkedBeside()).toEqual([".bak"]);
  const kept = second.keptParkedIndexes ?? [];
  expect(kept.length).toBe(1);
  expect(kept[0]!.path).toBe(dbPath + ".bak");
  expect(kept[0]!.reason).toBe("unreadable");
});

test("a rebuild that keeps the embedding-richer parked index names it and its size", async () => {
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg);
  // A parked index that holds stored embeddings the keyword-only rebuild
  // cannot compute again: the rule keeps it.
  copyFileSync(dbPath, dbPath + ".old");
  withVectors(dbPath + ".old", 5);

  const stats = await reindexVault(cfg);

  expect(parkedBeside()).toEqual([".old"]);
  const kept = stats.keptParkedIndexes ?? [];
  expect(kept.length).toBe(1);
  expect(kept[0]!.path).toBe(dbPath + ".old");
  expect(kept[0]!.vectors).toBe(5);
  expect(kept[0]!.reason).toBe("richer");
  expect(kept[0]!.bytes).toBe(statSync(dbPath + ".old").size);
  expect(kept[0]!.release).toContain("o2b search reindex --embeddings");
});

test("a rebuild that leaves nothing parked says nothing about parked indexes", async () => {
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg);

  const stats = await reindexVault(cfg);

  expect(parkedBeside()).toEqual([]);
  expect(stats.keptParkedIndexes).toBeUndefined();
});

test("the status reports the parked index, its size, the reason and the release step", async () => {
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg);
  copyFileSync(dbPath, dbPath + ".old");
  writeFileSync(dbPath, Buffer.from("not a database, only bytes. ".repeat(400)));
  await reindexVault(cfg);

  const parked = parkedIndexStatus(dbPath, { present: true, vectors: 0 }, {
    dbPath,
    vaultPath: vault,
    configPath: null,
    defaultDbPath: dbPath,
    defaultVaultPath: vault,
    defaultConfigPath: null,
  } satisfies ParkedIndexTarget);

  expect(parked.length).toBe(1);
  expect(parked[0]!.path).toBe(dbPath + ".bak");
  expect(parked[0]!.kept).toBe(true);
  expect(parked[0]!.bytes).toBeGreaterThan(0);
  expect(parked[0]!.reason).toContain("could not be counted");
  expect(parked[0]!.release).toContain("o2b search set-aside bak --apply");
});

test("status says when another parked index supersedes this one", () => {
  mkdirSync(dirname(dbPath), { recursive: true });
  for (const [path, count] of [
    [dbPath + ".old", 5],
    [dbPath + ".bak", 3],
  ] as const) {
    const db = new Database(path);
    db.exec("CREATE TABLE embeddings (id INTEGER)");
    const insert = db.query("INSERT INTO embeddings (id) VALUES (?)");
    for (let i = 0; i < count; i++) insert.run(i);
    db.close(true);
  }
  const target: ParkedIndexTarget = {
    dbPath,
    vaultPath: vault,
    configPath: null,
    defaultDbPath: dbPath,
    defaultVaultPath: vault,
    defaultConfigPath: null,
  };

  const superseded = parkedIndexStatus(dbPath, { present: true, vectors: 0 }, target).find(
    (p) => p.path === dbPath + ".bak",
  );
  expect(superseded?.kept).toBe(false);
  expect(superseded?.reason).toContain("another parked index holds more stored embeddings");

  const liveCountMeetsParked = parkedIndexStatus(
    dbPath,
    { present: true, vectors: 3 },
    target,
  ).find((p) => p.path === dbPath + ".bak");
  expect(liveCountMeetsParked?.reason).toContain(
    "the live index holds at least as many stored embeddings",
  );
});

test("a stat failure does not count a parked index as empty", () => {
  mkdirSync(dirname(dbPath), { recursive: true });
  const path = dbPath + ".bak";
  const db = new Database(path);
  db.exec("CREATE TABLE embeddings (id INTEGER)");
  db.close(true);
  const realStat = fs.statSync;
  const spy = spyOn(fs, "statSync").mockImplementation(((
    ...args: Parameters<typeof fs.statSync>
  ) => {
    if (String(args[0]) === path) throw Object.assign(new Error("simulated EIO"), { code: "EIO" });
    return realStat(...args);
  }) as typeof fs.statSync);
  try {
    expect(countStoredEmbeddings(path)).toBeNull();
  } finally {
    spy.mockRestore();
  }
});

test("a stat failure while sizing a parked index propagates", () => {
  mkdirSync(dirname(dbPath), { recursive: true });
  const path = dbPath + ".bak";
  const db = new Database(path);
  db.exec("CREATE TABLE embeddings (id INTEGER)");
  db.close(true);
  const realStat = fs.statSync;
  let matchingCalls = 0;
  const spy = spyOn(fs, "statSync").mockImplementation(((
    ...args: Parameters<typeof fs.statSync>
  ) => {
    if (String(args[0]) === path && ++matchingCalls === 2)
      throw Object.assign(new Error("simulated EIO"), { code: "EIO" });
    return realStat(...args);
  }) as typeof fs.statSync);
  try {
    expect(() =>
      parkedIndexStatus(
        dbPath,
        { present: true, vectors: 0 },
        {
          dbPath,
          vaultPath: vault,
          configPath: null,
          defaultDbPath: dbPath,
          defaultVaultPath: vault,
          defaultConfigPath: null,
        },
      ),
    ).toThrow("simulated EIO");
  } finally {
    spy.mockRestore();
  }
});
