/**
 * Both parked names taken, a live index beside them: what a rebuild that
 * died after swapping its index in, and before verifying it, leaves when
 * an earlier embedding-richer `.bak` was already there. The next rebuild
 * must neither discard a parked index unverified nor give up for good:
 * the live index is checked, and it decides.
 */

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  closeSync,
  copyFileSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { Database } from "bun:sqlite";

import { indexVault, reindexVault } from "../../../src/core/search/indexer.ts";
import { refreshEntitiesInPlace } from "../../../src/core/search/entity-refresh.ts";
import { Store } from "../../../src/core/search/store.ts";
import { parkMarkerPath, writeParkMarker } from "../../../src/core/search/store/lifecycle.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("parked-pair"));
  writeMd(vault, "a.md", "# Herons\n\nGrey herons wade in shallow water.\n");
  for (let i = 0; i < 40; i++)
    writeMd(vault, `n${i}.md`, `# Note ${i}\n\n${"Words of a note. ".repeat(80)}\n`);
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

function vectorsIn(path: string): number {
  const db = new Database(path);
  try {
    return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM embeddings").get()!.n;
  } finally {
    db.close(true);
  }
}

test("a live index that verifies supersedes the poorer parked one and the rebuild goes on", async () => {
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg);
  copyFileSync(dbPath, dbPath + ".bak");
  withVectors(dbPath + ".bak", 5);
  copyFileSync(dbPath, dbPath + ".old");
  withVectors(dbPath + ".old", 2);

  await reindexVault(cfg);

  // The richest parked vectors survive at `.bak`; the rest was superseded.
  expect(vectorsIn(dbPath + ".bak")).toBe(5);
  expect(existsSync(dbPath + ".old")).toBe(false);
});

test("a live index that fails its check is replaced by the newest parked one, never deleted unseen", async () => {
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg);
  copyFileSync(dbPath, dbPath + ".bak");
  withVectors(dbPath + ".bak", 5);
  copyFileSync(dbPath, dbPath + ".old");
  withVectors(dbPath + ".old", 2);
  // Damage the live file's later pages: it still opens, its check fails.
  const size = statSync(dbPath).size;
  const fd = openSync(dbPath, "r+");
  writeSync(fd, Buffer.alloc(8192, 0xa5), 0, 8192, Math.floor(size / 2 / 4096) * 4096);
  closeSync(fd);
  // Non-vacuous: the live file now fails the check the rebuild runs.
  expect(quickCheck(dbPath)).not.toBe("ok");

  await reindexVault(cfg);

  // The `.old` came back as the live index and was parked again by the
  // rebuild; the verified successor then kept the richest vectors only.
  expect(vectorsIn(dbPath + ".bak")).toBe(5);
  expect(existsSync(dbPath + ".old")).toBe(false);
  expect(quickCheck(dbPath)).toBe("ok");
});

test("a second entity refresh that finds the index current does nothing", async () => {
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg);
  const db = new Database(dbPath);
  db.run("UPDATE index_state SET value = '3' WHERE key = 'chunker_version'");
  db.close(true);

  const first = await refreshEntitiesInPlace(cfg);
  const second = await refreshEntitiesInPlace(cfg);

  expect(first.chunks).toBeGreaterThan(0);
  expect(second).toMatchObject({ chunks: 0, entityRows: 0 });
});

test("an entity refresh that fails part way closes its connection and releases the lock", async () => {
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg);
  const db = new Database(dbPath);
  db.run("UPDATE index_state SET value = '3' WHERE key = 'chunker_version'");
  // A view where the refresh table goes: its first statement fails.
  db.run("CREATE VIEW chunk_entities_refresh AS SELECT 1 AS x");
  db.close(true);
  const closed = spyOn(Database.prototype, "close");
  const before = closed.mock.calls.length;
  try {
    await expect(refreshEntitiesInPlace(cfg)).rejects.toThrow();
    expect(closed.mock.calls.length).toBeGreaterThan(before);
  } finally {
    closed.mockRestore();
  }
  expect(existsSync(`${dbPath}.lock`)).toBe(false);
});

test("a parked index whose stored vectors cannot be counted is kept by a keyword-only rebuild", async () => {
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg);
  // Not readable as an index: its count is unknown, which is not zero.
  const unreadable = Buffer.from("not a database, only bytes. ".repeat(400));
  writeFileSync(dbPath + ".bak", unreadable);

  await reindexVault(cfg);

  expect(readFileSync(dbPath + ".bak").equals(unreadable)).toBe(true);
  expect(existsSync(dbPath + ".old")).toBe(false);
  expect(quickCheck(dbPath)).toBe("ok");
});

test("an entity refresh refuses an index another writer stamped with chunks of another version", async () => {
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg);
  const db = new Database(dbPath);
  db.run("UPDATE index_state SET value = '2' WHERE key = 'chunker_version'");
  db.close(true);

  await expect(refreshEntitiesInPlace(cfg)).rejects.toThrow("refusing to stamp it as current");

  const after = new Database(dbPath, { readonly: true });
  try {
    expect(
      after
        .query<{ value: string }, []>("SELECT value FROM index_state WHERE key = 'chunker_version'")
        .get()!.value,
    ).toBe("2");
  } finally {
    after.close(true);
  }
});

test("a stop between the renames of a swap that parked at .bak beside a kept .old is reunited at .bak", async () => {
  // A verified rebuild kept the embedding-richer `.old` and removed `.bak`;
  // the next swap parks the newer live index at `.bak`. Its main file has
  // moved, its committed WAL is still at the live path: suffix order alone
  // would put the older `.old` beside that WAL.
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg);
  copyFileSync(dbPath, dbPath + ".old");
  withVectors(dbPath + ".old", 5);
  const live = new Database(dbPath);
  live.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
  live.run(
    "INSERT INTO index_state(key, value, updated_at) VALUES ('probe', 'newer', '') " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  // The committed frame lives in the WAL only: copy the set while it is open.
  copyFileSync(dbPath, dbPath + ".split-main");
  copyFileSync(dbPath + "-wal", dbPath + ".split-wal");
  live.close(true);
  for (const sibling of ["-wal", "-shm"]) {
    if (existsSync(dbPath + sibling)) rmSync(dbPath + sibling);
  }
  rmSync(dbPath);
  writeParkMarker(dbPath, dbPath + ".bak");
  renameSync(dbPath + ".split-main", dbPath + ".bak");
  renameSync(dbPath + ".split-wal", dbPath + "-wal");

  const store = await Store.open(cfg, { mode: "read" });
  await store.close();

  // The newer index came back whole; the kept `.old` is untouched.
  const back = new Database(dbPath, { readonly: true });
  try {
    expect(
      back.query<{ value: string }, []>("SELECT value FROM index_state WHERE key = 'probe'").get()
        ?.value,
    ).toBe("newer");
  } finally {
    back.close(true);
  }
  expect(quickCheck(dbPath)).toBe("ok");
  expect(existsSync(dbPath + ".bak")).toBe(false);
  expect(vectorsIn(dbPath + ".old")).toBe(5);
  expect(existsSync(parkMarkerPath(dbPath))).toBe(false);

  // A rebuild leaves no marker behind.
  await reindexVault(cfg);
  expect(existsSync(parkMarkerPath(dbPath))).toBe(false);
});

test("both parked names held by an unreadable index and a richer one: the refusal names the step that frees a name, and it works", async () => {
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg);
  // A damaged index a rebuild parked and keeps (its count is unknown)...
  const unreadable = Buffer.from("not a database, only bytes. ".repeat(400));
  writeFileSync(dbPath + ".bak", unreadable);
  // ...and the index with vectors a keyword-only rebuild then parked
  // beside it; the live index holds none.
  copyFileSync(dbPath, dbPath + ".old");
  withVectors(dbPath + ".old", 3);
  expect(quickCheck(dbPath)).toBe("ok");

  let refusal: unknown = null;
  try {
    await reindexVault(cfg);
  } catch (err) {
    refusal = err;
  }
  // Nothing parked was removed, and the refusal names the unreadable file,
  // not a step that cannot help (the live index already passes its check).
  expect((refusal as { code?: string } | null)?.code).toBe("INDEX_LOCKED");
  const message = (refusal as Error).message;
  expect(message).toContain(`${dbPath}.bak could not be read`);
  expect(message).not.toContain("passes its check");
  expect(readFileSync(dbPath + ".bak").equals(unreadable)).toBe(true);
  expect(vectorsIn(dbPath + ".old")).toBe(3);

  // The step the refusal names: move the unreadable file out of the folder.
  const movedAside = `${vault}/unreadable-index-copy`;
  renameSync(dbPath + ".bak", movedAside);
  await reindexVault(cfg);
  expect(quickCheck(dbPath)).toBe("ok");
  expect(readFileSync(movedAside).equals(unreadable)).toBe(true);
  // The richer `.old` outranks the new keyword-only index and is kept.
  expect(vectorsIn(dbPath + ".old")).toBe(3);
});
