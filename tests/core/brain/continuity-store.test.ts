import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireLockSync } from "../../../src/core/brain/sync-lockfile.ts";
import {
  appendContinuityRecord,
  appendContinuityRecords,
  appendContinuitySourceInvalidation,
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
