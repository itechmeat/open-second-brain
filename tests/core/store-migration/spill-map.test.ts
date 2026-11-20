/**
 * The maps a migration run keeps per legacy item or per store record
 * (change migration-memory-peak): a `SpillMap` answers as a `Map` would
 * before and after it moves to its scratch file, the scratch file is gone
 * once the run closes it, a file a killed run left is removed by the next
 * scratch, and a journal that moved to disk keeps its rule for rows of the
 * journal file.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Journal, type JournalRow } from "../../../src/core/store-migration/journal.ts";
import {
  MigrationScratch,
  SCRATCH_DIR,
  SpillMap,
} from "../../../src/core/store-migration/spill-map.ts";

let dir: string | null = null;
afterEach(() => {
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function tempDir(): string {
  dir = mkdtempSync(join(tmpdir(), "osb-spill-map-"));
  return dir;
}

const scratchFiles = (d: string): string[] =>
  existsSync(join(d, SCRATCH_DIR)) ? readdirSync(join(d, SCRATCH_DIR)) : [];

test("a map answers as a Map before and after it moves to disk", () => {
  const d = tempDir();
  const scratch = new MigrationScratch(d, { spillAt: 3 });
  const map = scratch.map();
  const model = new Map<string, string>();
  // Keys with the separators the journal and the store use, and non-ASCII.
  const keys = ["a", "\u0000vault\u0000sum\u0000Brain/log/x.jsonl#1", "b\u0001c", "é", "z", "y"];
  for (const [i, key] of keys.entries()) {
    map.set(key, `v${i}`);
    model.set(key, `v${i}`);
    if (i === 2) expect(map.spilled).toBe(false);
  }
  expect(map.spilled).toBe(true);
  map.set("a", "again");
  model.set("a", "again");
  map.delete("z");
  model.delete("z");
  map.delete("missing");
  expect(map.size).toBe(model.size);
  for (const key of [...keys, "missing"]) {
    expect(map.get(key)).toBe(model.get(key));
    expect(map.has(key)).toBe(model.has(key));
  }
  expect(new Map(map.entries())).toEqual(model);
  // A second map of the same scratch is its own.
  const other = scratch.map();
  for (let i = 0; i < 5; i++) other.set(`k${i}`, "x");
  expect(other.size).toBe(5);
  expect(map.size).toBe(model.size);
  expect(scratchFiles(d)).toHaveLength(1);
  scratch.close();
  expect(scratchFiles(d)).toEqual([]);
});

test("an empty key is kept and listed on disk too", () => {
  const d = tempDir();
  const scratch = new MigrationScratch(d, { spillAt: 0 });
  const map = scratch.map();
  map.set("", "empty");
  map.set("k", "v");
  expect(map.spilled).toBe(true);
  expect(map.get("")).toBe("empty");
  expect(new Map(map.entries())).toEqual(
    new Map([
      ["", "empty"],
      ["k", "v"],
    ]),
  );
  scratch.close();
});

test("without a scratch, or below the threshold, nothing is written", () => {
  const d = tempDir();
  const bare = new SpillMap();
  for (let i = 0; i < 100; i++) bare.set(String(i), "x");
  expect(bare.spilled).toBe(false);
  const scratch = new MigrationScratch(d, { spillAt: 1000 });
  const map = scratch.map();
  for (let i = 0; i < 100; i++) map.set(String(i), "x");
  expect(map.spilled).toBe(false);
  scratch.close();
  expect(existsSync(join(d, SCRATCH_DIR))).toBe(false);
});

test("the scratch file of a process that is gone is removed by the next scratch", () => {
  const d = tempDir();
  mkdirSync(join(d, SCRATCH_DIR), { recursive: true });
  // A pid no process has: far above any pid a system hands out.
  const left = join(d, SCRATCH_DIR, "scratch-2147483646-abc123.sqlite");
  const other = join(d, SCRATCH_DIR, "notes.txt");
  writeFileSync(left, "");
  writeFileSync(other, "kept");
  const scratch = new MigrationScratch(d, { spillAt: 0 });
  scratch.map().set("k", "v");
  expect(existsSync(left)).toBe(false);
  expect(existsSync(other)).toBe(true);
  scratch.close();
});

const row = (key: string, ids: string[]): JournalRow => ({
  key,
  sum: "s",
  ids,
  sums: ids.map(() => "x"),
  partition: "shared",
});

test("a journal on disk keeps a whole store row over the file's, and the file's last row otherwise", () => {
  const d = tempDir();
  const scratch = new MigrationScratch(d, { spillAt: 1 });
  const journal = new Journal(scratch);
  journal.set("whole", row("whole", ["r1"]));
  journal.set("part", row("part", ["r2", ""]));
  journal.set("filler", row("filler", ["r3"]));
  expect(journal.size).toBe(3);
  expect(journal.entry("whole", "s")).toEqual({ row: row("whole", ["r1"]), disk: false });
  journal.set("part", row("part", ["r2", "r4"]), "disk");
  expect(journal.entry("part", "s")).toEqual({ row: row("part", ["r2", "r4"]), disk: true });
  expect(journal.get("part", "other")).toBeUndefined();
  expect([...journal.rows()].map((r) => r.key).toSorted()).toEqual(["filler", "part", "whole"]);
  scratch.close();
});
