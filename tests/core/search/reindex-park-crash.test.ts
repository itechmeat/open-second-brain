/**
 * A rebuild killed in the middle of parking the previous index - its main
 * file moved to `.bak` (or `.old`) and its journals not yet, or the other
 * way round in the middle of putting it back - leaves the previous index
 * split between two names with no live index. Every entry point that can
 * meet that state (an open, the self-heal, the next rebuild, a snapshot
 * restore) must put the set back together or carry it forward; nothing
 * may discard it before a verified successor exists, and the stored
 * embeddings it holds must survive.
 *
 * The crash states are made by doing the park's renames one at a time,
 * for every point a kill can stop them, with and without stored vectors,
 * and with an earlier embedding-richer `.bak` that makes the swap park the
 * live index at `.old`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, renameSync } from "node:fs";
import { Database } from "bun:sqlite";

import { indexVault, reindexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { healIndex } from "../../../src/core/search/self-heal.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("park-crash"));
});
afterEach(() => cleanup());

const ORDER_PARK = ["", "-wal", "-shm", "-journal"] as const;
const ORDER_UNPARK = ["-wal", "-shm", "-journal", ""] as const;

/** Commits through the WAL and is killed before it closes. */
async function killedWriter(path: string, sql: string): Promise<void> {
  const script =
    'const { Database } = require("bun:sqlite");' +
    "const db = new Database(process.argv[1]);" +
    'db.exec("PRAGMA journal_mode = WAL");' +
    'db.exec("PRAGMA wal_autocheckpoint = 0");' +
    `db.exec(${JSON.stringify(sql)});` +
    'process.kill(process.pid, "SIGKILL");';
  const child = Bun.spawn([process.execPath, "-e", script, path], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await child.exited;
}

function count(path: string, sql: string): number {
  const db = new Database(path);
  try {
    return db.query<{ n: number }, []>(sql).get()!.n;
  } finally {
    db.close(true);
  }
}

function quickCheck(path: string): string {
  const db = new Database(path);
  try {
    return db.query<{ quick_check: string }, []>("PRAGMA quick_check(1)").get()!.quick_check;
  } finally {
    db.close(true);
  }
}

const vectorsIn = (path: string): number => count(path, "SELECT COUNT(*) AS n FROM embeddings");
const markerRows = (path: string): number => count(path, "SELECT COUNT(*) AS n FROM crash_marker");

type Variant = "no vectors" | "vectors" | "vectors, richer .bak";

/**
 * The live index with a killed writer's committed frames still in its
 * `-wal`: stored vectors (one per chunk, or one for the richer-`.bak`
 * case, whose `.bak` holds one per chunk) or a marker table, so a split
 * set loses data the reunited one has.
 */
async function prepare(variant: Variant): Promise<{ live: number; bak: number }> {
  writeMd(vault, "a.md", "# Herons\n\nGrey herons wade in shallow water.\n");
  writeMd(
    vault,
    "b.md",
    "# Egrets\n\nLittle egrets fish at dawn.\n\n## More\n\nThey nest in colonies.\n",
  );
  await indexVault(makeConfig({ vault, dbPath }));
  const chunks = count(dbPath, "SELECT COUNT(*) AS n FROM chunks");
  let bak = 0;
  if (variant === "vectors, richer .bak") {
    copyFileSync(dbPath, dbPath + ".bak");
    const db = new Database(dbPath + ".bak");
    db.exec(
      "INSERT INTO embeddings(chunk_id, model, dimension, embedding_hash, created_at, updated_at) " +
        "SELECT id, 'probe', 4, 'h', '', '' FROM chunks",
    );
    db.close(true);
    bak = chunks;
  }
  if (variant === "no vectors") {
    await killedWriter(
      dbPath,
      "CREATE TABLE crash_marker (id INTEGER PRIMARY KEY); " +
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50) " +
        "INSERT INTO crash_marker(id) SELECT i FROM n",
    );
    return { live: 0, bak };
  }
  const limit = variant === "vectors" ? "" : " LIMIT 1";
  await killedWriter(
    dbPath,
    "INSERT INTO embeddings(chunk_id, model, dimension, embedding_hash, created_at, updated_at) " +
      `SELECT id, 'probe', 4, 'h', '', '' FROM chunks${limit}`,
  );
  return { live: variant === "vectors" ? chunks : 1, bak };
}

/** The files of the live set, in park order. */
function liveSet(): string[] {
  return ORDER_PARK.filter((s) => existsSync(dbPath + s));
}

/** Do the first `k` renames of parking the live set at `to`. */
function parkPartially(to: string, k: number): void {
  for (const s of liveSet().slice(0, k)) renameSync(dbPath + s, to + s);
}

/** Park the whole set at `from`, then do the first `k` renames of putting it back. */
function unparkPartially(from: string, k: number): void {
  parkPartially(from, liveSet().length);
  const present = ORDER_UNPARK.filter((s) => existsSync(from + s));
  for (const s of present.slice(0, k)) renameSync(from + s, dbPath + s);
}

interface CrashPoint {
  readonly name: string;
  readonly make: (parked: string) => void;
}

/** Every point a kill can stop a park or an unpark of a three-file set. */
const CRASH_POINTS: ReadonlyArray<CrashPoint> = [
  { name: "park, after the main file", make: (p) => parkPartially(p, 1) },
  { name: "park, after the main file and -wal", make: (p) => parkPartially(p, 2) },
  { name: "park, the whole set, before the new index", make: (p) => parkPartially(p, 3) },
  { name: "unpark, after -wal", make: (p) => unparkPartially(p, 1) },
  { name: "unpark, after -wal and -shm", make: (p) => unparkPartially(p, 2) },
];

type EntryPoint = "open" | "heal" | "rebuild";

async function enter(entry: EntryPoint): Promise<void> {
  const cfg = makeConfig({ vault, dbPath });
  if (entry === "open") await search(cfg, { query: "herons", recordAccess: false });
  else if (entry === "heal") await healIndex(cfg);
  else await reindexVault(cfg);
}

const VARIANTS: ReadonlyArray<Variant> = ["no vectors", "vectors", "vectors, richer .bak"];
const ENTRIES: ReadonlyArray<EntryPoint> = ["open", "heal", "rebuild"];

for (const variant of VARIANTS) {
  describe(`a crash in the middle of a park (${variant})`, () => {
    for (const point of CRASH_POINTS) {
      for (const entry of ENTRIES) {
        test.skipIf(process.platform === "win32")(`${point.name}, then ${entry}`, async () => {
          const before = await prepare(variant);
          // The swap parks the live index at `.old` beside a richer `.bak`.
          const parked = variant === "vectors, richer .bak" ? dbPath + ".old" : dbPath + ".bak";
          point.make(parked);
          // Non-vacuous: no live index, the previous one split or parked.
          expect(existsSync(dbPath)).toBe(false);

          await enter(entry);

          expect(existsSync(dbPath)).toBe(true);
          if (entry === "rebuild") {
            // A verified successor exists: the previous index may go, but
            // the richest stored vectors stay parked at `.bak`.
            expect(quickCheck(dbPath)).toBe("ok");
            const richest = Math.max(before.live, before.bak);
            if (richest > 0) expect(vectorsIn(dbPath + ".bak")).toBe(richest);
            else expect(existsSync(dbPath + ".bak")).toBe(false);
            expect(existsSync(dbPath + ".old")).toBe(false);
          } else {
            // No successor: the previous index is back at the live path,
            // whole, with every commit and vector of its journals.
            if (variant === "no vectors") expect(markerRows(dbPath)).toBe(50);
            else expect(vectorsIn(dbPath)).toBe(before.live);
            if (before.bak > 0) expect(vectorsIn(dbPath + ".bak")).toBe(before.bak);
            expect(existsSync(parked)).toBe(false);
            expect(quickCheck(dbPath)).toBe("ok");
          }
        });
      }
    }
  });
}
