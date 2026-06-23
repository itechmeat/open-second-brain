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
});
