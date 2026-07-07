import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listContinuityRecords } from "../../../src/core/brain/continuity/store.ts";
import { extractPreCompactRecords } from "../../../src/core/brain/pre-compact-extract.ts";
import {
  RECENT_TURNS_CAP,
  appendRecentTurn,
  listRecentTurns,
  resurfaceRecentTurns,
} from "../../../src/core/brain/recent-turns.ts";

let vault: string;

/** Stamp turn N with a distinct, monotonically-increasing canonical UTC timestamp. */
function stampAt(index: number): string {
  const minute = String(index).padStart(2, "0");
  return `2026-05-20T17:${minute}:00.000Z`;
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-recent-turns-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("bounded verbatim last-N-turns buffer", () => {
  test("appending N+1 turns evicts the oldest — buffer never grows beyond N", () => {
    for (let index = 0; index <= RECENT_TURNS_CAP; index += 1) {
      appendRecentTurn(vault, {
        role: index % 2 === 0 ? "user" : "assistant",
        text: `turn number ${index}`,
        createdAt: stampAt(index),
      });
    }

    const turns = listRecentTurns(vault);
    // Hard cap enforced: exactly N turns, never more.
    expect(turns).toHaveLength(RECENT_TURNS_CAP);
    // The oldest turn (index 0) has been evicted from the buffer view.
    expect(turns.some((turn) => turn.text === "turn number 0")).toBe(false);
    // The newest turn survives and is last (chronological order preserved).
    expect(turns.at(-1)?.text).toBe(`turn number ${RECENT_TURNS_CAP}`);
    expect(turns.at(0)?.text).toBe("turn number 1");
  });

  test("a read limit above the hard cap is still clamped to N", () => {
    for (let index = 0; index < RECENT_TURNS_CAP + 5; index += 1) {
      appendRecentTurn(vault, { role: "user", text: `t${index}`, createdAt: stampAt(index) });
    }
    expect(listRecentTurns(vault, { limit: 9999 })).toHaveLength(RECENT_TURNS_CAP);
    expect(listRecentTurns(vault, { limit: 3 })).toHaveLength(3);
  });

  test("after a simulated compaction the exact recent wording survives", () => {
    appendRecentTurn(vault, {
      role: "user",
      text: "please refactor the parser to be streaming",
      sessionId: "sess-1",
      turnId: "turn-42",
      createdAt: stampAt(1),
    });
    appendRecentTurn(vault, {
      role: "assistant",
      text: "done — the parser now streams line by line",
      sessionId: "sess-1",
      turnId: "turn-43",
      createdAt: stampAt(2),
    });

    // Simulate compaction: nothing in-memory is retained; we re-read the
    // durable continuity-store artifact from disk in a fresh call.
    const survived = listRecentTurns(vault);
    expect(survived.map((turn) => turn.text)).toEqual([
      "please refactor the parser to be streaming",
      "done — the parser now streams line by line",
    ]);
    expect(survived[0]?.role).toBe("user");
    expect(survived[0]?.turnId).toBe("turn-42");
    expect(survived[0]?.sessionId).toBe("sess-1");
  });

  test("the buffer is clearly separated from other curated/continuity surfaces", () => {
    appendRecentTurn(vault, { role: "user", text: "verbatim scaffolding", createdAt: stampAt(1) });
    extractPreCompactRecords(vault, {
      createdAt: stampAt(2),
      sessionId: "sess-2",
      turnStart: "turn-1",
      turnEnd: "turn-1",
      text: "Decision: keep the two surfaces separate.",
    });

    // The recent-turn buffer has its own kind and does not leak into other
    // continuity kinds' reads.
    const recentKind = listContinuityRecords(vault, { kind: "recent_turn" });
    expect(recentKind).toHaveLength(1);
    expect(recentKind[0]?.kind).toBe("recent_turn");

    const extracts = listContinuityRecords(vault, { kind: "pre_compact_extract" });
    expect(extracts.every((record) => record.kind === "pre_compact_extract")).toBe(true);

    // Reading the buffer never surfaces the curated extract's wording.
    const turns = listRecentTurns(vault);
    expect(turns).toHaveLength(1);
    expect(turns.every((turn) => turn.text === "verbatim scaffolding")).toBe(true);
  });

  test("post-compaction re-surface is default-off → nothing surfaced", () => {
    appendRecentTurn(vault, { role: "user", text: "hello there", createdAt: stampAt(1) });

    // Off (default / explicit): byte-identical — nothing added to context.
    expect(resurfaceRecentTurns(vault, { enabled: false })).toBeNull();
    expect(resurfaceRecentTurns(vault, {})).toBeNull();

    // On (opt-in): the verbatim buffer is surfaced for recovery.
    const surfaced = resurfaceRecentTurns(vault, { enabled: true });
    expect(surfaced).not.toBeNull();
    expect(surfaced).toContain("hello there");
  });

  test("re-surface on an empty buffer returns null even when enabled", () => {
    expect(resurfaceRecentTurns(vault, { enabled: true })).toBeNull();
  });

  test("per-turn verbatim text is bounded (no unbounded hoarding)", () => {
    const huge = "x".repeat(1_000_000);
    const record = appendRecentTurn(vault, { role: "user", text: huge, createdAt: stampAt(1) });
    const stored = String(record.payload["text"]);
    expect(stored.length).toBeLessThan(huge.length);
  });
});
