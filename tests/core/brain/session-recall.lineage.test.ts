/**
 * Compression-aware session recall keyed on the lineage root
 * (continuity-hygiene-freshness suite, Task 4; kanban t_a94623ad).
 *
 * A conversation that the host split across a compression boundary is
 * one lineage: search / describe over ANY segment id must return the
 * stitched conversation, and describe must expose the segment chain.
 * Never-compacted sessions stay byte-identical to the flat behavior.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  describeSessionRecall,
  importSessionRecall,
  searchSessionRecall,
} from "../../../src/core/brain/session-recall.ts";
import type { SessionTurn } from "../../../src/core/brain/sessions/types.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-recall-lineage-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function turn(
  turnId: string,
  role: SessionTurn["role"],
  text: string,
  second: number,
): SessionTurn {
  return {
    turnId,
    role,
    text,
    timestamp: `2026-06-10T10:00:${String(second).padStart(2, "0")}.000Z`,
  };
}

function importSegments(): void {
  importSessionRecall(vault, {
    sessionId: "root-seg",
    turns: [
      turn("t1", "user", "alpha question before compaction", 1),
      turn("t2", "assistant", "alpha answer before compaction", 2),
    ],
    createdAt: "2026-06-10T10:00:10Z",
  });
  importSessionRecall(vault, {
    sessionId: "child-seg",
    turns: [
      turn("t3", "user", "beta question after compaction", 21),
      turn("t4", "assistant", "beta answer after compaction", 22),
    ],
    createdAt: "2026-06-10T10:01:10Z",
    lineage: { rootId: "root-seg", parentId: "root-seg", depth: 1, source: "payload" },
  });
}

describe("lineage stamping on imported records", () => {
  test("non-flat lineage lands on turn and summary payloads", () => {
    importSegments();
    const hits = searchSessionRecall(vault, { query: "beta question", sessionId: "child-seg" });
    expect(hits.hits.length).toBeGreaterThan(0);
    const described = describeSessionRecall(vault, { sessionId: "child-seg" });
    expect(described.lineage_root).toBe("root-seg");
  });
});

describe("stitched recall across the compression boundary", () => {
  test("search via the child id finds turns from the root segment", () => {
    importSegments();
    const hits = searchSessionRecall(vault, { query: "alpha question", sessionId: "child-seg" });
    expect(hits.hits.length).toBeGreaterThan(0);
  });

  test("search via the root id finds turns from the child segment", () => {
    importSegments();
    const hits = searchSessionRecall(vault, { query: "beta answer", sessionId: "root-seg" });
    expect(hits.hits.length).toBeGreaterThan(0);
  });

  test("describe over any segment counts the whole lineage and lists segments", () => {
    importSegments();
    const fromChild = describeSessionRecall(vault, { sessionId: "child-seg" });
    const fromRoot = describeSessionRecall(vault, { sessionId: "root-seg" });
    expect(fromChild.raw_turns).toBe(4);
    expect(fromRoot.raw_turns).toBe(4);
    expect(fromRoot.lineage_root).toBe("root-seg");
    expect(fromChild.segments).toEqual([
      { session_id: "root-seg", parent_session_id: null },
      { session_id: "child-seg", parent_session_id: "root-seg" },
    ]);
  });
});

describe("flat sessions regress nothing", () => {
  test("a never-compacted session keeps the exact flat result shape", () => {
    importSessionRecall(vault, {
      sessionId: "solo",
      turns: [turn("t1", "user", "gamma standalone", 1)],
      createdAt: "2026-06-10T10:00:10Z",
    });
    const described = describeSessionRecall(vault, { sessionId: "solo" });
    expect(described).toEqual({
      session_id: "solo",
      raw_turns: 1,
      summary_nodes: 1,
      depths: { "1": 1 },
    });
    expect("lineage_root" in described).toBe(false);
    expect("segments" in described).toBe(false);
    const foreign = searchSessionRecall(vault, { query: "gamma", sessionId: "other" });
    expect(foreign.hits).toHaveLength(0);
  });
});
