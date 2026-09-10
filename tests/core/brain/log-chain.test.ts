/**
 * Per-shard hash chain on the Brain log (who-wrote-what, Task E).
 *
 * Once the log is the attribution record for every write, a deleted or
 * edited line has to be DETECTABLE. These tests hold the chain to that
 * one property and to nothing more: they tamper with a shard the way a
 * text editor would - rewrite a payload, remove a line, paste a line in
 * by hand - and require the verifier to name the shard and the line.
 *
 * Report-only by construction, so every case also asserts that the READ
 * path is untouched: `readLogDay` returns the same entries whether the
 * chain is intact or broken, because a log that refused to be read
 * because someone edited it would be a worse outcome than the edit.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LOG_CHAIN_BREAK_REASON,
  logChainHash,
  verifyLogChain,
} from "../../../src/core/brain/log-chain.ts";
import { appendLogEvent, LOG_CHAIN_FIELDS } from "../../../src/core/brain/log.ts";
import { readLogDay } from "../../../src/core/brain/log-jsonl.ts";
import { brainDirs, logJsonlPath, logShardJsonlPath } from "../../../src/core/brain/paths.ts";
import { DEGRADATION_CODE } from "../../../src/core/integrity/degradation.ts";

const DATE = "2026-06-01";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-log-chain-"));
  mkdirSync(join(tmp, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Append `count` events to `shardId`, one second apart. */
function appendMany(count: number, shardId = ""): void {
  for (let i = 0; i < count; i++) {
    appendLogEvent(
      tmp,
      {
        timestamp: `${DATE}T10:00:0${i}Z`,
        eventType: "note",
        body: { text: `event ${i}`, agent: "@tester" },
      },
      { deviceId: shardId },
    );
  }
}

function readRows(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function writeRows(path: string, rows: ReadonlyArray<Record<string, unknown>>): void {
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
}

describe("chain links", () => {
  test("three appends produce three lines whose prev links match", () => {
    appendMany(3);
    const rows = readRows(logJsonlPath(tmp, DATE));
    expect(rows).toHaveLength(3);

    expect(rows[0]![LOG_CHAIN_FIELDS.prev]).toBeNull();
    expect(rows[1]![LOG_CHAIN_FIELDS.prev]).toBe(rows[0]![LOG_CHAIN_FIELDS.h]);
    expect(rows[2]![LOG_CHAIN_FIELDS.prev]).toBe(rows[1]![LOG_CHAIN_FIELDS.h]);

    for (const row of rows) {
      const expected = logChainHash(
        row[LOG_CHAIN_FIELDS.prev] as string | null,
        row["ts"] as string,
        row["kind"] as string,
        row["payload"] as Record<string, string>,
      );
      expect(row[LOG_CHAIN_FIELDS.h]).toBe(expected);
    }

    const result = verifyLogChain(tmp);
    expect(result.ok).toBe(true);
    expect(result.notices).toHaveLength(0);
    expect(result.shards).toHaveLength(1);
    expect(result.shards[0]).toMatchObject({
      date: DATE,
      shardId: "",
      chained: 3,
      legacy: 0,
      firstBreak: null,
    });
  });

  test("the row keeps its ts/kind/payload projection beside the chain fields", () => {
    appendMany(1);
    const row = readRows(logJsonlPath(tmp, DATE))[0]!;
    expect(Object.keys(row)).toEqual(["ts", "kind", "payload", "prev", "h"]);
  });
});

describe("tamper detection", () => {
  test("editing the middle line's payload reports line 2 hash-mismatch", () => {
    appendMany(3);
    const path = logJsonlPath(tmp, DATE);
    const rows = readRows(path);
    rows[1] = { ...rows[1]!, payload: { ...(rows[1]!["payload"] as object), text: "tampered" } };
    writeRows(path, rows);

    const result = verifyLogChain(tmp);
    expect(result.ok).toBe(false);
    expect(result.shards[0]!.firstBreak).toEqual({
      line: 2,
      reason: LOG_CHAIN_BREAK_REASON.hashMismatch,
    });
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]!.code).toBe(DEGRADATION_CODE.logChainBroken);
    expect(result.notices[0]!.path).toBe(path);
    expect(result.notices[0]!.detail).toContain("line 2");

    // Report-only: the read path still returns every line.
    expect(readLogDay(tmp, DATE).entries).toHaveLength(3);
  });

  test("deleting the middle line reports the survivor's line as prev-mismatch", () => {
    appendMany(3);
    const path = logJsonlPath(tmp, DATE);
    const rows = readRows(path);
    writeRows(path, [rows[0]!, rows[2]!]);

    const result = verifyLogChain(tmp);
    expect(result.ok).toBe(false);
    expect(result.shards[0]!.firstBreak).toEqual({
      line: 2,
      reason: LOG_CHAIN_BREAK_REASON.prevMismatch,
    });
    expect(result.shards[0]!.chained).toBe(2);
    expect(readLogDay(tmp, DATE).entries).toHaveLength(2);
  });

  test("deleting the third of four lines reports line 3 prev-mismatch", () => {
    appendMany(4);
    const path = logJsonlPath(tmp, DATE);
    const rows = readRows(path);
    writeRows(path, [rows[0]!, rows[1]!, rows[3]!]);

    const result = verifyLogChain(tmp);
    expect(result.shards[0]!.firstBreak).toEqual({
      line: 3,
      reason: LOG_CHAIN_BREAK_REASON.prevMismatch,
    });
  });

  test("cutting the head off a shard reports line 1 prev-mismatch", () => {
    // The Brain log never compacts, so a shard begins at its genesis
    // line and the first chained line must carry `prev: null`. One that
    // names a predecessor means the head of the file was removed - the
    // one tampering a compaction-exempt anchor would let through.
    appendMany(3);
    const path = logJsonlPath(tmp, DATE);
    const rows = readRows(path);
    writeRows(path, [rows[1]!, rows[2]!]);

    const result = verifyLogChain(tmp);
    expect(result.ok).toBe(false);
    expect(result.shards[0]!.firstBreak).toEqual({
      line: 1,
      reason: LOG_CHAIN_BREAK_REASON.prevMismatch,
    });
  });

  test("a line that is not JSON at all is malformed at its own line", () => {
    appendMany(2);
    const path = logJsonlPath(tmp, DATE);
    writeFileSync(path, readFileSync(path, "utf8") + "{not json\n", "utf8");

    const result = verifyLogChain(tmp);
    expect(result.ok).toBe(false);
    expect(result.shards[0]!.firstBreak).toEqual({
      line: 3,
      reason: LOG_CHAIN_BREAK_REASON.malformed,
    });
  });
});

describe("legacy lines", () => {
  test("a legacy prefix followed by chained lines verifies clean", () => {
    const dir = brainDirs(tmp).log;
    mkdirSync(dir, { recursive: true });
    const path = logJsonlPath(tmp, DATE);
    writeRows(path, [
      { ts: `${DATE}T09:00:00Z`, kind: "note", payload: { text: "before the chain" } },
      { ts: `${DATE}T09:00:01Z`, kind: "note", payload: { text: "also before" } },
    ]);
    appendMany(2);

    const result = verifyLogChain(tmp);
    expect(result.ok).toBe(true);
    expect(result.shards[0]).toMatchObject({ chained: 2, legacy: 2, firstBreak: null });

    // The first chained line after a legacy prefix is a genesis anchor.
    const rows = readRows(path);
    expect(rows[2]![LOG_CHAIN_FIELDS.prev]).toBeNull();
    expect(readLogDay(tmp, DATE).entries).toHaveLength(4);
  });

  test("an unchained line pasted in AFTER chained ones is malformed, not legacy", () => {
    appendMany(2);
    const path = logJsonlPath(tmp, DATE);
    const rows = readRows(path);
    writeRows(path, [
      ...rows,
      { ts: `${DATE}T11:00:00Z`, kind: "note", payload: { text: "pasted by hand" } },
    ]);

    const result = verifyLogChain(tmp);
    expect(result.ok).toBe(false);
    expect(result.shards[0]!.firstBreak).toEqual({
      line: 3,
      reason: LOG_CHAIN_BREAK_REASON.malformed,
    });
    expect(result.shards[0]!.legacy).toBe(1);
  });
});

describe("shard isolation", () => {
  test("two device shards each carry their own chain", () => {
    appendMany(2, "devalpha");
    appendMany(2, "devbeta");

    const clean = verifyLogChain(tmp);
    expect(clean.ok).toBe(true);
    expect(clean.shards.map((s) => s.shardId)).toEqual(["devalpha", "devbeta"]);

    const alpha = logShardJsonlPath(tmp, DATE, "devalpha");
    const rows = readRows(alpha);
    writeRows(alpha, [rows[1]!]);

    const broken = verifyLogChain(tmp);
    expect(broken.ok).toBe(false);
    const byShard = new Map(broken.shards.map((s) => [s.shardId, s]));
    expect(byShard.get("devalpha")!.firstBreak).not.toBeNull();
    expect(byShard.get("devbeta")!.firstBreak).toBeNull();
    expect(broken.notices).toHaveLength(1);
    expect(broken.notices[0]!.path).toBe(alpha);
  });

  test("a Syncthing conflict copy is never verified", () => {
    appendMany(2);
    const dir = brainDirs(tmp).log;
    // A conflict copy is the doctor's OTHER finding (`sync-conflict-log`);
    // verifying it here would report one condition as two.
    writeFileSync(join(dir, `${DATE}.sync-conflict-20260601-120000-ABCDEF.jsonl`), "{broken\n");

    const result = verifyLogChain(tmp);
    expect(result.ok).toBe(true);
    expect(result.shards).toHaveLength(1);
    expect(result.shards[0]!.path).toBe(logJsonlPath(tmp, DATE));
  });

  test("a vault with no log at all verifies clean with no shards", () => {
    const result = verifyLogChain(tmp);
    expect(result.ok).toBe(true);
    expect(result.shards).toHaveLength(0);
    expect(result.notices).toHaveLength(0);
  });
});
