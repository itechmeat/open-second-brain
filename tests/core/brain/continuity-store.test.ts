import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireLockSync } from "../../../src/core/brain/sync-lockfile.ts";
import {
  appendContinuityRecord,
  appendContinuitySourceInvalidation,
  continuityLogPath,
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
      sourceRefs: [
        { id: "pref-alpha", path: "Brain/preferences/pref-alpha.md" },
      ],
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
    expect(first.records.map((record) => record.sourceRefs[0]!.id)).toEqual([
      "query-0",
      "query-1",
    ]);
    expect(first.nextCursor).not.toBeNull();

    const second = paginateContinuityRecords(vault, {
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.records.map((record) => record.sourceRefs[0]!.id)).toEqual([
      "query-2",
    ]);
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
    expect(records.map((record) => record.kind)).toEqual([
      "session_turn",
      "source_invalidation",
    ]);
  });
});
