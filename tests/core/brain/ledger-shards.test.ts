/**
 * The shard grammar every append-only ledger shares (who-wrote-what,
 * Task B / t_1814b9bf).
 *
 * `Brain/log/` proved the layout: `<base>[.<shardId>].<ext>`, the bare
 * name being the shard with the empty id, Syncthing conflict copies
 * excluded from every listing and reported separately. This suite pins
 * the extracted grammar itself, so the five ledgers that now share it
 * cannot each drift their own copy of the answer.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isSyncConflictName,
  LEDGER_SHARD_ID_RE,
  listShardedFiles,
  listSyncConflictFiles,
  literalBase,
  mergeShardedRows,
  parseShardedName,
  resolveAppendShardId,
  shardedFileName,
  type LedgerShardGrammar,
} from "../../../src/core/brain/ledger-shards.ts";

const MONTH_GRAMMAR: LedgerShardGrammar = Object.freeze({
  base: "\\d{4}-\\d{2}",
  extensions: Object.freeze(["jsonl"]),
});

const DAY_GRAMMAR: LedgerShardGrammar = Object.freeze({
  base: "\\d{4}-\\d{2}-\\d{2}",
  extensions: Object.freeze(["jsonl", "md"]),
});

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "o2b-ledger-shards-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function touch(name: string): void {
  writeFileSync(join(dir, name), "", "utf8");
}

describe("parseShardedName", () => {
  test("the bare name is the shard with the empty id", () => {
    expect(parseShardedName("2026-08.jsonl", MONTH_GRAMMAR)).toEqual({
      base: "2026-08",
      shardId: "",
      ext: "jsonl",
    });
  });

  test("a device suffix is the shard id", () => {
    expect(parseShardedName("2026-08.testdev1.jsonl", MONTH_GRAMMAR)).toEqual({
      base: "2026-08",
      shardId: "testdev1",
      ext: "jsonl",
    });
  });

  test("every declared extension is recognised", () => {
    expect(parseShardedName("2026-06-01.dev.md", DAY_GRAMMAR)?.ext).toBe("md");
    expect(parseShardedName("2026-06-01.dev.jsonl", DAY_GRAMMAR)?.ext).toBe("jsonl");
  });

  test("a name whose base does not match the grammar is not a shard", () => {
    expect(parseShardedName("notes.jsonl", MONTH_GRAMMAR)).toBeNull();
    expect(parseShardedName("2026-08.txt", MONTH_GRAMMAR)).toBeNull();
    expect(parseShardedName("2026-08.jsonl.bak", MONTH_GRAMMAR)).toBeNull();
  });

  test("a shard id outside the slug shape is not a shard", () => {
    expect(parseShardedName("2026-08.NOTASLUG.jsonl", MONTH_GRAMMAR)).toBeNull();
    expect(parseShardedName(`2026-08.${"a".repeat(33)}.jsonl`, MONTH_GRAMMAR)).toBeNull();
  });

  test("a hand-renamed sync-conflict copy never passes as a shard", () => {
    expect(
      parseShardedName("2026-08.sync-conflict-20260801-120000.jsonl", MONTH_GRAMMAR),
    ).toBeNull();
  });

  test("a literal base admits the dots inside it", () => {
    const grammar: LedgerShardGrammar = {
      base: literalBase("pref-a.b"),
      extensions: ["jsonl"],
    };
    expect(parseShardedName("pref-a.b.jsonl", grammar)).toEqual({
      base: "pref-a.b",
      shardId: "",
      ext: "jsonl",
    });
    expect(parseShardedName("pref-a.b.dev1.jsonl", grammar)?.shardId).toBe("dev1");
    expect(parseShardedName("pref-ax.jsonl", grammar)).toBeNull();
  });

  test("round-trips whatever the name builder produced", () => {
    for (const shardId of ["", "testdev1", "a-b-c"]) {
      const name = shardedFileName("2026-08", shardId, "jsonl");
      expect(parseShardedName(name, MONTH_GRAMMAR)).toEqual({
        base: "2026-08",
        shardId,
        ext: "jsonl",
      });
    }
  });

  test("the builder refuses a shard id outside the slug shape", () => {
    expect(() => shardedFileName("2026-08", "BAD/ID", "jsonl")).toThrow(/shard id/i);
  });
});

describe("listShardedFiles", () => {
  test("an absent directory lists nothing", () => {
    expect(listShardedFiles(join(dir, "missing"), MONTH_GRAMMAR)).toEqual([]);
  });

  test("lists every shard sorted by name and excludes conflict copies", () => {
    touch("2026-08.jsonl");
    touch("2026-08.devb.jsonl");
    touch("2026-08.deva.jsonl");
    touch("2026-08.sync-conflict-20260801-120000-ABCDEFG.jsonl");
    touch("README.md");
    mkdirSync(join(dir, "2026-09.jsonl"));
    const shards = listShardedFiles(dir, MONTH_GRAMMAR);
    expect(shards.map((s) => s.name)).toEqual([
      "2026-08.deva.jsonl",
      "2026-08.devb.jsonl",
      "2026-08.jsonl",
    ]);
    expect(shards.map((s) => s.shardId)).toEqual(["deva", "devb", ""]);
    expect(shards[0]!.path).toBe(join(dir, "2026-08.deva.jsonl"));
  });
});

describe("sync-conflict recognition", () => {
  test("names the marker Syncthing writes and nothing else", () => {
    expect(isSyncConflictName("2026-08.sync-conflict-20260801-120000-ABCDEFG.jsonl")).toBe(true);
    expect(isSyncConflictName("2026-08.jsonl")).toBe(false);
    expect(isSyncConflictName("sync-conflict.jsonl")).toBe(false);
  });

  test("lists conflict copies under a directory, sorted", () => {
    touch("2026-08.jsonl");
    touch("b.sync-conflict-20260801-120000-ABCDEFG.jsonl");
    touch("a.sync-conflict-20260801-120000-ABCDEFG.jsonl");
    expect(listSyncConflictFiles(dir)).toEqual([
      join(dir, "a.sync-conflict-20260801-120000-ABCDEFG.jsonl"),
      join(dir, "b.sync-conflict-20260801-120000-ABCDEFG.jsonl"),
    ]);
  });

  test("an absent directory holds no conflict copies", () => {
    expect(listSyncConflictFiles(join(dir, "missing"))).toEqual([]);
  });
});

describe("mergeShardedRows", () => {
  test("orders by sort key, then shard id, then line", () => {
    const rows = [
      { value: { at: "2026-08-02", tag: "b-late" }, shardId: "b", line: 1 },
      { value: { at: "2026-08-01", tag: "b-1" }, shardId: "b", line: 0 },
      { value: { at: "2026-08-01", tag: "a-1" }, shardId: "a", line: 0 },
      { value: { at: "2026-08-01", tag: "a-2" }, shardId: "a", line: 1 },
      { value: { at: "2026-08-01", tag: "bare" }, shardId: "", line: 0 },
    ];
    expect(mergeShardedRows(rows, (v) => v.at).map((v) => v.tag)).toEqual([
      "bare",
      "a-1",
      "a-2",
      "b-1",
      "b-late",
    ]);
  });

  test("a ledger's own last-resort key replaces line order when supplied", () => {
    const rows = [
      { value: { at: "2026-08-01", tag: "z" }, shardId: "a", line: 0 },
      { value: { at: "2026-08-01", tag: "a" }, shardId: "a", line: 1 },
    ];
    expect(
      mergeShardedRows(
        rows,
        (v) => v.at,
        (v) => v.tag,
      ).map((v) => v.tag),
    ).toEqual(["a", "z"]);
    expect(mergeShardedRows(rows, (v) => v.at).map((v) => v.tag)).toEqual(["z", "a"]);
  });

  test("the order does not depend on the order the shards arrived in", () => {
    const rows = [
      { value: { at: "2026-08-01", tag: "a" }, shardId: "a", line: 0 },
      { value: { at: "2026-08-01", tag: "b" }, shardId: "b", line: 0 },
    ];
    const forward = mergeShardedRows(rows, (v) => v.at).map((v) => v.tag);
    const reversed = mergeShardedRows(rows.toReversed(), (v) => v.at).map((v) => v.tag);
    expect(forward).toEqual(reversed);
    expect(forward).toEqual(["a", "b"]);
  });
});

describe("resolveAppendShardId", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved["O2B_DEVICE_ID"] = process.env["O2B_DEVICE_ID"];
    saved["OPEN_SECOND_BRAIN_CONFIG"] = process.env["OPEN_SECOND_BRAIN_CONFIG"];
  });

  afterEach(() => {
    for (const key of ["O2B_DEVICE_ID", "OPEN_SECOND_BRAIN_CONFIG"]) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("returns the resolved device id", () => {
    process.env["O2B_DEVICE_ID"] = "testdev1";
    expect(resolveAppendShardId()).toBe("testdev1");
  });

  test("the empty opt-out selects the legacy un-sharded name", () => {
    process.env["O2B_DEVICE_ID"] = "";
    expect(resolveAppendShardId()).toBe("");
    expect(shardedFileName("2026-08", resolveAppendShardId(), "jsonl")).toBe("2026-08.jsonl");
  });

  test("a config that cannot be read falls back to the legacy shard, never throws", () => {
    delete process.env["O2B_DEVICE_ID"];
    // A directory where the config file is expected: every read of it
    // raises EISDIR, which is the ConfigReadError the appenders absorb.
    const configHome = mkdtempSync(join(tmpdir(), "o2b-ledger-shards-cfg-"));
    const configPath = join(configHome, "config.yaml");
    mkdirSync(configPath, { recursive: true });
    process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
    try {
      expect(resolveAppendShardId()).toBe("");
    } finally {
      rmSync(configHome, { recursive: true, force: true });
    }
  });
});

describe("the shard id shape", () => {
  test("is the device-id slug the config resolver produces", () => {
    expect(LEDGER_SHARD_ID_RE.test("testdev1")).toBe(true);
    expect(LEDGER_SHARD_ID_RE.test("a-b-c")).toBe(true);
    expect(LEDGER_SHARD_ID_RE.test("")).toBe(false);
    expect(LEDGER_SHARD_ID_RE.test("Bad")).toBe(false);
    expect(LEDGER_SHARD_ID_RE.test("a".repeat(33))).toBe(false);
  });
});
