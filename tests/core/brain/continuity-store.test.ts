import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { acquireLockSync } from "../../../src/core/brain/sync-lockfile.ts";
import {
  appendContinuityRecord,
  appendContinuityRecords,
  appendContinuitySourceInvalidation,
  buildContinuityRecord,
  continuityLogPath,
  isCanonicalUtcTimestamp,
  listContinuityRecords,
  paginateContinuityRecords,
} from "../../../src/core/brain/continuity/store.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-continuity-store-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("continuity store", () => {
  test("appends redaction-safe records under the Brain continuity log", () => {
    const record = appendContinuityRecord(vault, {
      kind: "context_receipt",
      createdAt: "2026-05-31T12:00:00Z",
      sourceRefs: [{ id: "pref-alpha", path: "Brain/preferences/pref-alpha.md" }],
      payload: {
        query: "project setup",
        text: "Keep this <private>do not persist</private> and token=secret-value",
      },
    });

    expect(record.id).toStartWith("ctn_");
    expect(record.payload).toEqual({
      query: "project setup",
      text: "Keep this ***PRIVATE*** and token=***REDACTED***",
    });
    expect(record.private).toBe(true);
    expect(record.redacted).toBe(true);

    const path = continuityLogPath(vault, "2026-05");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("context_receipt");

    const listed = listContinuityRecords(vault, {
      kind: "context_receipt",
      sourceId: "pref-alpha",
    });
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain("secret-value");
    expect(JSON.stringify(listed)).not.toContain("do not persist");
  });

  test("paginates records with stable cursors", () => {
    for (let index = 0; index < 3; index++) {
      appendContinuityRecord(vault, {
        kind: "recall_telemetry",
        createdAt: `2026-05-31T12:00:0${index}Z`,
        sourceRefs: [{ id: `query-${index}` }],
        payload: { status: index === 2 ? "miss" : "hit", resultCount: index },
      });
    }

    const first = paginateContinuityRecords(vault, { limit: 2 });
    expect(first.records.map((record) => record.sourceRefs[0]!.id)).toEqual(["query-0", "query-1"]);
    expect(first.nextCursor).not.toBeNull();

    const second = paginateContinuityRecords(vault, {
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.records.map((record) => record.sourceRefs[0]!.id)).toEqual(["query-2"]);
    expect(second.nextCursor).toBeNull();
  });

  test("serializes appends with the brain sync lock", () => {
    const path = continuityLogPath(vault, "2026-05");
    const handle = acquireLockSync(path);
    try {
      expect(() =>
        appendContinuityRecord(vault, {
          kind: "context_receipt",
          createdAt: "2026-05-31T12:00:00Z",
          sourceRefs: [],
          payload: { event: "locked" },
        }),
      ).toThrow("lock busy");
    } finally {
      handle.release();
    }

    const record = appendContinuityRecord(vault, {
      kind: "context_receipt",
      createdAt: "2026-05-31T12:00:01Z",
      sourceRefs: [],
      payload: { event: "unlocked" },
    });
    expect(record.id).toStartWith("ctn_");
  });

  test("records source invalidation markers without deleting history", () => {
    appendContinuityRecord(vault, {
      kind: "session_turn",
      createdAt: "2026-05-31T12:00:00Z",
      sourceRefs: [{ id: "session-a#turn-1", path: "sessions/a.jsonl" }],
      payload: { role: "user", snippet: "Please remember this" },
    });

    const invalidation = appendContinuitySourceInvalidation(vault, {
      createdAt: "2026-05-31T12:05:00Z",
      source: { id: "session-a#turn-1", path: "sessions/a.jsonl" },
      reason: "source-scoped forget dry run",
    });

    expect(invalidation.kind).toBe("source_invalidation");
    const records = listContinuityRecords(vault, {
      sourceId: "session-a#turn-1",
    });
    expect(records.map((record) => record.kind)).toEqual(["session_turn", "source_invalidation"]);
  });

  test("since/until shard-skip returns the same records as an unfiltered window", () => {
    const months = ["2026-03", "2026-05", "2026-07", "2026-09"];
    for (const month of months) {
      appendContinuityRecord(vault, {
        kind: "context_receipt",
        createdAt: `${month}-15T12:00:00Z`,
        sourceRefs: [{ id: `src-${month}` }],
        payload: { query: month },
      });
    }

    // A bounded window skips the 2026-03 and 2026-09 shards but returns
    // exactly the in-window records, in ascending createdAt order.
    const windowed = listContinuityRecords(vault, {
      since: "2026-05-01T00:00:00Z",
      until: "2026-07-31T23:59:59Z",
    });
    expect(windowed.map((r) => r.payload["query"])).toEqual(["2026-05", "2026-07"]);

    // Boundary months are read in full: since exactly on a record's month.
    const openEnded = listContinuityRecords(vault, { since: "2026-05-15T12:00:00Z" });
    expect(openEnded.map((r) => r.payload["query"])).toEqual(["2026-05", "2026-07", "2026-09"]);

    // No filter still reads every shard.
    expect(listContinuityRecords(vault)).toHaveLength(4);
  });
});

describe("continuity batch append", () => {
  test("appends every record in a valid batch into the same month shard", () => {
    const records = appendContinuityRecords(vault, [
      {
        kind: "session_turn",
        createdAt: "2026-06-01T08:00:00Z",
        sourceRefs: [{ id: "s#1" }],
        payload: { role: "user", snippet: "one" },
      },
      {
        kind: "session_turn",
        createdAt: "2026-06-01T08:00:01Z",
        sourceRefs: [{ id: "s#2" }],
        payload: { role: "assistant", snippet: "two" },
      },
    ]);

    expect(records).toHaveLength(2);
    const path = continuityLogPath(vault, "2026-06");
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const listed = listContinuityRecords(vault, { kind: "session_turn" });
    expect(listed.map((r) => r.sourceRefs[0]!.id)).toEqual(["s#1", "s#2"]);
  });

  test("an invalid record anywhere in the batch leaves the shard log unchanged", () => {
    // Seed an existing record so we can prove the batch does not touch it.
    appendContinuityRecord(vault, {
      kind: "session_turn",
      createdAt: "2026-06-01T07:00:00Z",
      sourceRefs: [{ id: "pre-existing" }],
      payload: { snippet: "before" },
    });
    const path = continuityLogPath(vault, "2026-06");
    const before = readFileSync(path, "utf8");

    expect(() =>
      appendContinuityRecords(vault, [
        {
          kind: "session_turn",
          createdAt: "2026-06-01T08:00:00Z",
          sourceRefs: [{ id: "ok" }],
          payload: { snippet: "valid" },
        },
        {
          // Malformed createdAt → month prefix fails validation; the whole
          // batch must abort before any line is written.
          kind: "session_turn",
          createdAt: "not-a-timestamp",
          sourceRefs: [{ id: "bad" }],
          payload: { snippet: "invalid" },
        },
      ]),
    ).toThrow();

    expect(readFileSync(path, "utf8")).toBe(before);
    expect(listContinuityRecords(vault, {}).map((r) => r.sourceRefs[0]!.id)).toEqual([
      "pre-existing",
    ]);
  });

  test("a single-month batch appends all lines under one lock acquisition", () => {
    const path = continuityLogPath(vault, "2026-06");
    const handle = acquireLockSync(path);
    try {
      // Lock held: the batch must fail to acquire and write nothing.
      expect(() =>
        appendContinuityRecords(vault, [
          {
            kind: "recall_telemetry",
            createdAt: "2026-06-02T08:00:00Z",
            sourceRefs: [{ id: "q1" }],
            payload: { status: "hit" },
          },
        ]),
      ).toThrow("lock busy");
    } finally {
      handle.release();
    }
    expect(existsSync(path)).toBe(false);
  });

  test("rejects an empty batch without writing", () => {
    expect(() => appendContinuityRecords(vault, [])).toThrow();
    expect(existsSync(continuityLogPath(vault, "2026-06"))).toBe(false);
  });
});

describe("createdAt validation at the store boundary", () => {
  const ACCEPT: string[] = [
    "2026-05-31T12:00:00Z", // second precision
    "2026-06-15T10:00:00.000Z", // millisecond precision
    "2026-06-15T10:00:00.5Z", // sub-second, ≤3 digits
    "2024-02-29T00:00:00Z", // real leap day
    "2026-12-31T23:59:59.999Z",
  ];
  const REJECT: Array<[string, unknown]> = [
    ["month out of range shards into junk", "2026-13-01T00:00:00Z"],
    ["day out of range for the month", "2026-02-30T00:00:00Z"],
    ["Feb 29 on a non-leap year", "2026-02-29T00:00:00Z"],
    ["numeric offset instead of Z mis-sorts", "2026-07-06T15:00:00+03:00"],
    ["no zone designator", "2026-07-06T15:00:00"],
    ["date only", "2026-07-06"],
    ["month prefix only", "2026-07"],
    ["free text", "not-a-timestamp"],
    ["empty string", ""],
    ["lowercase z", "2026-07-06T15:00:00z"],
    ["non-string number", 1_783_350_000_000],
    ["null", null],
  ];

  test.each(ACCEPT)("accepts %s", (value) => {
    expect(isCanonicalUtcTimestamp(value)).toBe(true);
    const record = appendContinuityRecord(vault, {
      kind: "session_turn",
      createdAt: value,
      sourceRefs: [{ id: "ok" }],
      payload: { snippet: "valid" },
    });
    expect(record.createdAt).toBe(value);
  });

  test.each(REJECT)("rejects %s", (_label, value) => {
    expect(isCanonicalUtcTimestamp(value)).toBe(false);
    expect(() =>
      appendContinuityRecord(vault, {
        kind: "session_turn",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        createdAt: value as any,
        sourceRefs: [{ id: "bad" }],
        payload: { snippet: "invalid" },
      }),
    ).toThrow(/invalid continuity createdAt/);
    // Nothing was written: no shard exists for a rejected timestamp.
    expect(listContinuityRecords(vault, {})).toHaveLength(0);
  });
});

/**
 * Per-device shards (who-wrote-what, Task B / t_1814b9bf). Two devices
 * syncing one vault must not append to the same month file, and a reader
 * on either device must see the same merged sequence.
 */
describe("continuity per-device shards", () => {
  const savedEnv: Record<string, string | undefined> = {};
  let configHome: string;

  beforeEach(() => {
    configHome = mkdtempSync(join(tmpdir(), "o2b-continuity-shard-cfg-"));
    const configPath = join(configHome, "config.yaml");
    savedEnv["OPEN_SECOND_BRAIN_CONFIG"] = process.env["OPEN_SECOND_BRAIN_CONFIG"];
    savedEnv["O2B_DEVICE_ID"] = process.env["O2B_DEVICE_ID"];
    process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
    delete process.env["O2B_DEVICE_ID"];
    writeFileSync(configPath, `vault: ${vault}\ndevice_id: "testdev1"\n`, "utf8");
  });

  afterEach(() => {
    rmSync(configHome, { recursive: true, force: true });
    for (const key of ["OPEN_SECOND_BRAIN_CONFIG", "O2B_DEVICE_ID"]) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function record(createdAt: string, snippet: string) {
    return buildContinuityRecord({
      kind: "session_turn",
      createdAt,
      sourceRefs: [{ id: snippet }],
      payload: { snippet },
    });
  }

  /** Write a shard directly, standing in for a file Syncthing delivered. */
  function writeShard(month: string, shardId: string, snippets: ReadonlyArray<string>): void {
    const path = continuityLogPath(vault, month, shardId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      snippets.map((s) => `${JSON.stringify(record(`${month}-01T10:00:0${s[0]}Z`, s))}\n`).join(""),
      "utf8",
    );
  }

  test("a device with an id writes its own shard and never the bare file", () => {
    appendContinuityRecord(vault, {
      kind: "session_turn",
      createdAt: "2026-06-01T10:00:00Z",
      payload: { snippet: "one" },
    });
    expect(existsSync(continuityLogPath(vault, "2026-06", "testdev1"))).toBe(true);
    expect(existsSync(continuityLogPath(vault, "2026-06", ""))).toBe(false);
  });

  test("a batch append lands in the device shard too", () => {
    appendContinuityRecords(vault, [
      { kind: "session_turn", createdAt: "2026-06-01T10:00:00Z", payload: { snippet: "a" } },
      { kind: "session_turn", createdAt: "2026-06-01T10:00:01Z", payload: { snippet: "b" } },
    ]);
    const raw = readFileSync(continuityLogPath(vault, "2026-06", "testdev1"), "utf8");
    expect(raw.trim().split("\n")).toHaveLength(2);
    expect(existsSync(continuityLogPath(vault, "2026-06", ""))).toBe(false);
  });

  test("the reader merges the bare file and every device shard in one order", () => {
    writeShard("2026-06", "", ["0-legacy"]);
    writeShard("2026-06", "devb", ["2-otherdev"]);
    writeShard("2026-06", "testdev1", ["1-mine"]);
    expect(listContinuityRecords(vault, {}).map((r) => r.payload["snippet"])).toEqual([
      "0-legacy",
      "1-mine",
      "2-otherdev",
    ]);
  });

  test("a sync-conflict copy is not a shard and is never merged", () => {
    writeShard("2026-06", "testdev1", ["1-mine"]);
    const dir = dirname(continuityLogPath(vault, "2026-06", ""));
    writeFileSync(
      join(dir, "2026-06.sync-conflict-20260601-120000-ABCDEFG.jsonl"),
      `${JSON.stringify(record("2026-06-01T09:00:00Z", "conflict"))}\n`,
      "utf8",
    );
    expect(listContinuityRecords(vault, {}).map((r) => r.payload["snippet"])).toEqual(["1-mine"]);
  });

  test("the month range-skip reads the parsed base of a sharded name", () => {
    writeShard("2026-06", "testdev1", ["1-mine"]);
    writeShard("2026-05", "testdev1", ["0-may"]);
    const listed = listContinuityRecords(vault, { since: "2026-06-01T00:00:00Z" });
    expect(listed.map((r) => r.payload["snippet"])).toEqual(["1-mine"]);
  });

  /**
   * A shard this process cannot read is not an empty shard: a listing
   * that silently drops it reports a shorter history as if it were the
   * whole one.
   */
  test.skipIf(process.getuid?.() === 0)(
    "an unreadable shard is refused, not listed as absent",
    () => {
      writeShard("2026-06", "testdev1", ["1-mine"]);
      const path = continuityLogPath(vault, "2026-06", "testdev1");
      chmodSync(path, 0o000);
      try {
        expect(() => listContinuityRecords(vault, {})).toThrow(/EACCES|EPERM/);
      } finally {
        chmodSync(path, 0o600);
      }
    },
  );
});
