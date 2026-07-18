import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  describeSessionRecall,
  expandSessionRecall,
  importSessionRecall,
  searchSessionRecall,
} from "../../../src/core/brain/session-recall.ts";
import type { SessionTurn } from "../../../src/core/brain/sessions/types.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-session-recall-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function turn(turnId: string, role: SessionTurn["role"], text: string): SessionTurn {
  return {
    turnId,
    role,
    text,
    timestamp: `2026-05-20T17:00:0${turnId.slice(-1)}.000Z`,
  };
}

describe("session recall DAG", () => {
  test("imports raw turns and deterministic two-depth summary nodes idempotently", () => {
    const turns = [
      turn("t1", "user", "Need receipt search."),
      turn("t2", "assistant", "Decision: build continuity receipts."),
      turn("t3", "user", "Need session recall."),
      turn("t4", "assistant", "Outcome: tests cover recall."),
    ];

    const first = importSessionRecall(vault, {
      sessionId: "session-a",
      turns,
      summaryGroupSize: 2,
      createdAt: "2026-05-20T17:00:00.000Z",
    });
    const second = importSessionRecall(vault, {
      sessionId: "session-a",
      turns,
      summaryGroupSize: 2,
      createdAt: "2026-05-20T17:00:00.000Z",
    });

    expect(first.rawTurns).toHaveLength(4);
    expect(first.summaryNodes.map((record) => record.payload["depth"])).toEqual([1, 1, 2]);
    expect(first.rawTurns.map((record) => record.id)).toEqual(
      second.rawTurns.map((record) => record.id),
    );
    expect(describeSessionRecall(vault, { sessionId: "session-a" })).toMatchObject({
      session_id: "session-a",
      raw_turns: 4,
      summary_nodes: 3,
      depths: { "1": 2, "2": 1 },
    });
  });

  test("searches bounded raw and summary hits and expands exact raw lineage", () => {
    const imported = importSessionRecall(vault, {
      sessionId: "session-a",
      turns: [
        turn("t1", "user", "Find continuity receipt details."),
        turn("t2", "assistant", "Summary mentions receipts and tests."),
        turn("t3", "user", "Unrelated turn."),
      ],
      summaryGroupSize: 2,
      createdAt: "2026-05-20T17:00:00.000Z",
    });

    const search = searchSessionRecall(vault, {
      query: "receipt",
      sessionId: "session-a",
      limit: 4,
    });
    expect(search.hits.some((hit) => hit.kind === "session_turn")).toBe(true);
    expect(search.hits.some((hit) => hit.kind === "session_summary_node")).toBe(true);
    expect(search.hits.every((hit) => hit.snippet.length <= 160)).toBe(true);

    const expanded = expandSessionRecall(vault, {
      id: imported.summaryNodes.find((record) => record.payload["depth"] === 2)!.id,
      rawLimit: 2,
    });
    expect(expanded.immediate_sources).toHaveLength(2);
    expect(expanded.raw_content.map((item) => item.turn_id)).toEqual(["t1", "t2"]);
    expect(expanded.next_cursor).toBe("2");
  });

  test("annotates each hit with the 1-based line span of the snippet match", () => {
    importSessionRecall(vault, {
      sessionId: "session-b",
      turns: [turn("t1", "user", "First line.\nSecond line mentions receipts.")],
      summaryGroupSize: 2,
      createdAt: "2026-05-20T17:00:00.000Z",
    });

    const search = searchSessionRecall(vault, {
      query: "receipts",
      sessionId: "session-b",
      limit: 4,
    });
    const hit = search.hits.find((candidate) => candidate.kind === "session_turn");
    expect(hit?.line_start).toBe(2);
    expect(hit?.line_end).toBe(2);
  });

  test("line span stays correct when an earlier line lowercases to more code units", () => {
    // U+0130 (Turkish dotted capital I) lowercases to two code units, so a
    // match offset taken from the lowercased copy would be shifted ahead of
    // its true position in the original text. Nine of them on line 1 shift a
    // line-2 match onto line 3 under the bug; the offset must index the
    // original text so the line span stays line 2.
    importSessionRecall(vault, {
      sessionId: "session-locale",
      turns: [turn("t1", "user", `${"İ".repeat(9)}\nreceipts\nfinal line three`)],
      summaryGroupSize: 2,
      createdAt: "2026-05-20T18:00:00.000Z",
    });

    const search = searchSessionRecall(vault, {
      query: "receipts",
      sessionId: "session-locale",
      limit: 4,
    });
    const hit = search.hits.find((candidate) => candidate.kind === "session_turn");
    expect(hit).toBeDefined();
    expect(hit?.line_start).toBe(2);
    expect(hit?.line_end).toBe(2);
  });
});

function turnAt(turnId: string, text: string, timestamp: string): SessionTurn {
  return { turnId, role: "user", text, timestamp };
}

const parseMs = (iso: string): number => Date.parse(iso);

const byString = (a: string, b: string): number => a.localeCompare(b);

describe("session recall — since/before time bounds (S1 / t_347e8224)", () => {
  function seed(): void {
    importSessionRecall(vault, {
      sessionId: "session-time",
      turns: [
        turnAt("t1", "chronology alpha needle", "2026-01-10T09:00:00.000Z"),
        turnAt("t2", "chronology beta needle", "2026-03-15T09:00:00.000Z"),
        turnAt("t3", "chronology gamma needle", "2026-06-20T09:00:00.000Z"),
      ],
      summaryGroupSize: 8,
      createdAt: "2026-06-20T09:00:00.000Z",
    });
  }

  function turnIdsFor(input: { sinceMs?: number; untilMs?: number }): string[] {
    return searchSessionRecall(vault, {
      query: "needle",
      sessionId: "session-time",
      ...input,
    })
      .hits.filter((h) => h.kind === "session_turn")
      .map((h) => h.turn_id ?? "");
  }

  test("sinceMs excludes turns before the lower bound", () => {
    seed();
    expect(turnIdsFor({ sinceMs: parseMs("2026-03-01T00:00:00.000Z") }).toSorted(byString)).toEqual(
      ["t2", "t3"],
    );
  });

  test("untilMs excludes turns after the upper bound", () => {
    seed();
    expect(turnIdsFor({ untilMs: parseMs("2026-04-01T00:00:00.000Z") }).toSorted(byString)).toEqual(
      ["t1", "t2"],
    );
  });

  test("since + until keep only turns inside the window", () => {
    seed();
    expect(
      turnIdsFor({
        sinceMs: parseMs("2026-02-01T00:00:00.000Z"),
        untilMs: parseMs("2026-04-01T00:00:00.000Z"),
      }),
    ).toEqual(["t2"]);
  });

  test("no bounds is byte-identical to the unbounded search (all three turns)", () => {
    seed();
    expect(turnIdsFor({}).toSorted(byString)).toEqual(["t1", "t2", "t3"]);
  });
});
