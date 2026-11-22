/**
 * The step that releases a kept parked index, followed: a rebuild the
 * step names must actually release the file it names.
 *
 * The step is chosen from the parked index itself - its reason and what
 * it holds - because the rebuilds differ in what they can release. A
 * parked index that holds stored embeddings is released by the rebuild
 * that computes them again; an ordinary rebuild would leave it parked
 * as the richer one, which releases nothing. An empty parked index is
 * released by an ordinary rebuild. A parked index whose count cannot be
 * read is released by setting it aside (`o2b search set-aside`), because
 * no rebuild removes a parked index it cannot read; so is one holding
 * more embeddings than the notes left in the vault can produce again.
 *
 * Every branch of the rule is here: a free parked name, an occupied
 * one, a parked index beside no live index (with and without stored
 * embeddings, and one that cannot be read), one that cannot be read
 * beside a live index, one richer than the vault can produce again, and
 * one whose removal failed. Each test runs the step it reads.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";

import { indexVault, reindexVault } from "../../../src/core/search/indexer.ts";
import { setAsideParkedIndex } from "../../../src/core/search/parked-set-aside.ts";
import {
  parkedIndexStatus,
  type LiveIndex,
  type ParkedIndexStatus,
  type ParkedIndexTarget,
} from "../../../src/core/search/parked-index.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";
import { sqliteVecLoadable } from "../../helpers/sqlite-vec.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("parked-release"));
  writeMd(vault, "a.md", "# Herons\n\nGrey herons wade in shallow water.\n");
  for (let i = 0; i < 20; i++)
    writeMd(vault, `n${i}.md`, `# Note ${i}\n\n${"Words of a note. ".repeat(60)}\n`);
});
afterEach(() => cleanup());

/** The offline local embedder: a rebuild that computes embeddings needs no key. */
const LOCAL_SEMANTIC = {
  enabled: true,
  provider: "local",
  dimension: 256,
} as const;

function withVectors(path: string, limit: number): void {
  const db = new Database(path);
  db.exec(
    "INSERT INTO embeddings(chunk_id, model, dimension, embedding_hash, created_at, updated_at) " +
      `SELECT id, 'probe', 4, 'h', '', '' FROM chunks LIMIT ${limit}`,
  );
  db.close(true);
}

/** The live index is gone: nothing is beside the parked one but it. */
function removeLiveIndex(): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    rmSync(dbPath + suffix, { force: true });
  }
}

/**
 * Run the set-aside the step prints, as printed: the parked name and
 * `--apply` are read off the step, not supplied by the test.
 */
async function followSetAside(step: string): Promise<string> {
  const m = /o2b search set-aside (bak|old) --apply/u.exec(step);
  if (m === null) throw new Error(`the step names no set-aside: ${step}`);
  const r = await setAsideParkedIndex(dbPath, m[1] as "bak" | "old", true);
  return r.folder;
}

/** What the set-aside folder holds, every set-aside together. */
function setAsideFiles(): string[] {
  const root = join(dirname(dbPath), "set-aside");
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((d) => readdirSync(join(root, d)));
}

/** The parked index at `path` in the report. */
function reported(
  path: string,
  live: LiveIndex = { present: true, vectors: 0 },
): ParkedIndexStatus {
  const target: ParkedIndexTarget = {
    dbPath,
    vaultPath: vault,
    configPath: null,
    defaultDbPath: dbPath,
    defaultVaultPath: vault,
    defaultConfigPath: null,
  };
  const parked = parkedIndexStatus(dbPath, live, target);
  const found = parked.find((p) => p.path === path);
  if (found === undefined) throw new Error(`no parked index reported at ${path}`);
  return found;
}

test("a free parked name: the step names the rebuild that releases the file", async () => {
  if (!sqliteVecLoadable()) return;
  const cfg = makeConfig({ vault, dbPath, semantic: LOCAL_SEMANTIC });
  await indexVault(cfg);
  // A parked index that holds stored embeddings the keyword-only rebuild
  // cannot compute again: the rule keeps it.
  copyFileSync(dbPath, dbPath + ".old");
  withVectors(dbPath + ".old", 3);
  // The other parked name is free, so the rebuild the step names can start.

  const richer = reported(dbPath + ".old");

  expect(richer.kept).toBe(true);
  expect(richer.reason).toContain("more than the live index holds");
  expect(richer.release).toContain("o2b search reindex --embeddings");
  expect(richer.release).not.toContain("first with");
  // And the way out when the notes that produced them are gone.
  expect(richer.release).toContain("o2b search set-aside old --apply");

  // The step, followed: the rebuild that computes the embeddings holds
  // them, and the parked index is released.
  await reindexVault(cfg, { embeddings: true });
  expect(existsSync(dbPath + ".old")).toBe(false);
});

test("an unreadable parked index holds the name: the step frees that name first", async () => {
  if (!sqliteVecLoadable()) return;
  const cfg = makeConfig({ vault, dbPath, semantic: LOCAL_SEMANTIC });
  await indexVault(cfg);
  copyFileSync(dbPath, dbPath + ".old");
  withVectors(dbPath + ".old", 3);
  // A parked index whose stored embeddings cannot be counted: a rebuild
  // never removes it, so it holds its name.
  writeFileSync(dbPath + ".bak", Buffer.from("not a database, only bytes. ".repeat(400)));

  const richer = reported(dbPath + ".old");

  // The rebuild this step names cannot start while both names are held:
  // the preflight refuses before the build.
  let refusal: unknown = null;
  try {
    await reindexVault(cfg, { embeddings: true });
  } catch (err) {
    refusal = err;
  }
  expect((refusal as { code?: string } | null)?.code).toBe("INDEX_LOCKED");

  // So the step says what frees the name first, and then names the
  // rebuild that releases the parked index.
  expect(richer.release).toContain(
    "set the parked index at " + dbPath + ".bak aside first with: o2b search set-aside bak --apply",
  );
  expect(richer.release).toContain("o2b search reindex --embeddings");

  // The step, followed: the unreadable parked index is set aside with its
  // journals, and the rebuild that follows releases the parked one.
  await followSetAside(richer.release!);
  await reindexVault(cfg, { embeddings: true });
  expect(existsSync(dbPath + ".old")).toBe(false);
  expect(existsSync(dbPath + ".bak")).toBe(false);
  expect(setAsideFiles()).toEqual(["brain.sqlite.bak"]);
});

test("no live index, a parked index that holds embeddings: the step names the rebuild with embeddings", async () => {
  if (!sqliteVecLoadable()) return;
  const cfg = makeConfig({ vault, dbPath, semantic: LOCAL_SEMANTIC });
  await indexVault(cfg);
  // A parked index holding stored embeddings, and no live index beside
  // it: nothing can be weighed against it.
  copyFileSync(dbPath, dbPath + ".old");
  withVectors(dbPath + ".old", 3);
  removeLiveIndex();

  const kept = reported(dbPath + ".old", { present: false });

  expect(kept.kept).toBe(true);
  expect(kept.reason).toContain("no live index");
  // An ordinary rebuild restores the parked index, replaces it with a
  // keyword-only one and keeps the richer parked index again: it releases
  // nothing. The step names the rebuild that computes the embeddings.
  expect(kept.release).toContain("o2b search reindex --embeddings");

  // The step, followed: the rebuild that computes the embeddings holds
  // them, and the parked index is released.
  await reindexVault(cfg, { embeddings: true });
  expect(existsSync(dbPath + ".old")).toBe(false);
  expect(existsSync(dbPath + ".bak")).toBe(false);
});

test("no live index, an empty parked index: the step names the ordinary rebuild", async () => {
  const cfg = makeConfig({ vault, dbPath, semantic: LOCAL_SEMANTIC });
  await indexVault(cfg);
  // A parked index holding no stored embeddings, and no live index.
  copyFileSync(dbPath, dbPath + ".old");
  removeLiveIndex();

  const kept = reported(dbPath + ".old", { present: false });

  expect(kept.kept).toBe(true);
  expect(kept.reason).toContain("no live index");
  expect(kept.release).toContain("o2b search reindex");
  expect(kept.release).not.toContain("--embeddings");

  // The step, followed: the ordinary rebuild supersedes the parked
  // index, which holds nothing a keyword-only rebuild cannot compute.
  await reindexVault(cfg);
  expect(existsSync(dbPath + ".old")).toBe(false);
  expect(existsSync(dbPath + ".bak")).toBe(false);
});

test("a parked index that cannot be read: the step sets it aside, and nothing else is needed", async () => {
  const cfg = makeConfig({ vault, dbPath, semantic: LOCAL_SEMANTIC });
  await indexVault(cfg);
  // A parked index whose stored embeddings cannot be counted: no rebuild
  // removes it.
  writeFileSync(dbPath + ".bak", Buffer.from("not a database, only bytes. ".repeat(400)));

  const kept = reported(dbPath + ".bak");

  expect(kept.kept).toBe(true);
  expect(kept.reason).toContain("could not be counted");
  expect(kept.release).toContain("set it aside with: o2b search set-aside bak --apply");
  expect(kept.release).toContain("-wal, -shm and -journal");

  // The step, followed: the file leaves its parked name, kept whole in
  // the set-aside folder, and the next rebuild has nothing parked to keep.
  await followSetAside(kept.release!);
  expect(existsSync(dbPath + ".bak")).toBe(false);
  expect(setAsideFiles()).toEqual(["brain.sqlite.bak"]);
  const stats = await reindexVault(cfg);
  expect(stats.keptParkedIndexes ?? []).toEqual([]);
});

test("no live index, a parked index that cannot be read: the step sets it aside, then rebuilds", async () => {
  const cfg = makeConfig({ vault, dbPath, semantic: LOCAL_SEMANTIC });
  await indexVault(cfg);
  writeFileSync(dbPath + ".old", Buffer.from("not a database, only bytes. ".repeat(400)));
  removeLiveIndex();

  const kept = reported(dbPath + ".old", { present: false });

  expect(kept.release).toContain("set it aside with: o2b search set-aside old --apply");
  expect(kept.release).toContain("then run: o2b search reindex");

  // The step, followed.
  await followSetAside(kept.release!);
  const stats = await reindexVault(cfg);
  expect(stats.keptParkedIndexes ?? []).toEqual([]);
  expect(existsSync(dbPath + ".old")).toBe(false);
  expect(setAsideFiles()).toEqual(["brain.sqlite.old"]);
});

test("the notes behind the parked embeddings are gone: no rebuild releases it, the set-aside does", async () => {
  if (!sqliteVecLoadable()) return;
  const cfg = makeConfig({ vault, dbPath, semantic: LOCAL_SEMANTIC });
  await indexVault(cfg);
  copyFileSync(dbPath, dbPath + ".old");
  withVectors(dbPath + ".old", 3);
  // Every note is gone: the rebuild with embeddings has nothing to embed.
  rmSync(join(vault, "a.md"));
  for (let i = 0; i < 20; i++) rmSync(join(vault, `n${i}.md`));
  const stats = await reindexVault(cfg, { embeddings: true });
  const kept = (stats.keptParkedIndexes ?? []).find((k) => k.path === dbPath + ".old");
  expect(kept?.reason).toBe("richer");

  // The rebuild it names cannot reach the parked count, so the step says
  // what releases it then.
  expect(kept?.release).toContain("if the notes that produced them are gone");
  await followSetAside(kept!.release);
  expect(existsSync(dbPath + ".old")).toBe(false);
  expect(setAsideFiles()).toEqual(["brain.sqlite.old"]);
});

test("a removal that failed: the step names closing what holds it", async () => {
  const cfg = makeConfig({ vault, dbPath, semantic: LOCAL_SEMANTIC });
  await indexVault(cfg);
  // A parked index with no stored embeddings, and a sibling that cannot
  // be unlinked: the rebuild tries to remove the set and fails, so the
  // file stays beside the index.
  copyFileSync(dbPath, dbPath + ".old");
  mkdirSync(dbPath + ".old-shm");

  const stats = await reindexVault(cfg);
  const failed = (stats.keptParkedIndexes ?? []).find((k) => k.path === dbPath + ".old");

  expect(failed?.reason).toBe("removal-failed");
  expect(failed?.release).toContain("close whatever holds it and run: o2b search reindex");
  expect(existsSync(dbPath + ".old")).toBe(true);

  // The step, followed: whatever held it is freed, and the rebuild that
  // follows removes the parked file.
  rmSync(dbPath + ".old-shm", { recursive: true });
  await reindexVault(cfg);
  expect(existsSync(dbPath + ".old")).toBe(false);
});

test("a parked index the live index outweighs: no promise about the next rebuild, which may embed less", async () => {
  if (!sqliteVecLoadable()) return;
  const cfg = makeConfig({ vault, dbPath, semantic: LOCAL_SEMANTIC });
  await indexVault(cfg);
  copyFileSync(dbPath, dbPath + ".old");
  withVectors(dbPath + ".old", 3);

  const parked = reported(dbPath + ".old", { present: true, vectors: 3 });

  // A keyword-only rebuild leaves the live index with none, and the tie
  // then keeps the parked one: the report says what decides, not that the
  // next rebuild removes it.
  expect(parked.kept).toBe(false);
  expect(parked.reason).not.toContain("the next verified rebuild removes it");
  expect(parked.reason).toContain("unless the index it builds holds fewer than 3");
  const stats = await reindexVault(cfg);
  expect((stats.keptParkedIndexes ?? []).map((k) => k.reason)).toEqual(["richer"]);
});

test("no live index after a swap that stopped part way: the step restores it first, and is followed", async () => {
  const cfg = makeConfig({ vault, dbPath, semantic: LOCAL_SEMANTIC });
  await indexVault(cfg);
  // The swap parked the live index at .bak and stopped before its journals
  // followed; .old holds an index that cannot be read.
  writeFileSync(dbPath + ".old", Buffer.from("not a database, only bytes. ".repeat(400)));
  copyFileSync(dbPath, dbPath + ".bak");
  writeFileSync(dbPath + ".parking", ".bak\n");
  rmSync(dbPath);
  writeFileSync(dbPath + "-wal", "");

  const kept = reported(dbPath + ".old", { present: false });

  // A set-aside refuses here; the rebuild is what can run.
  expect(kept.release).toMatch(/^a rebuild stopped part way through its swap/u);
  await expect(setAsideParkedIndex(dbPath, "old", true)).rejects.toThrow("stopped part way");
  await reindexVault(cfg);
  expect(existsSync(dbPath + ".parking")).toBe(false);
  const left = reported(dbPath + ".old");
  await followSetAside(left.release!);
  expect(existsSync(dbPath + ".old")).toBe(false);
});
