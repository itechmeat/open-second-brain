/**
 * Coverage-first session recall (recall-quality wave, Lane B / t_2c2a883c).
 *
 * The coverage operation is the retrieve-wide-then-compress pass over the
 * lineage-scoped record set: facets detected from the thread itself, a
 * fan-out per facet, the union ranked by relevance, budgeted, and
 * re-emitted in `compareRecords` chronological order with diagnostics
 * recomputable from the record set. A grep call without the new
 * operation stays byte-identical (the omitted-operation convention, cf.
 * `includeRaw`).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listContinuityRecords } from "../../../src/core/brain/continuity/store.ts";
import type { SessionTurn } from "../../../src/core/brain/sessions/types.ts";
import {
  coverageSessionRecall,
  importSessionRecall,
  searchSessionRecall,
} from "../../../src/core/brain/session-recall.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-session-recall-coverage-"));
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
    timestamp: `2026-07-01T09:${String(Math.floor(second / 60)).padStart(2, "0")}:${String(second % 60).padStart(2, "0")}.000Z`,
  };
}

/** Two lineage-linked segments; four turns each, two depth-1 clusters per segment. */
function importLineageThread(): void {
  importSessionRecall(vault, {
    sessionId: "root-seg",
    turns: [
      turn("t1", "user", "alpha question about receipts before compaction", 1),
      turn("t2", "assistant", "alpha answer about receipts before compaction", 2),
      turn("t3", "user", "beta question about invoices before compaction", 3),
      turn("t4", "assistant", "beta answer about invoices before compaction", 4),
    ],
    summaryGroupSize: 2,
    createdAt: "2026-07-01T09:00:10.000Z",
  });
  importSessionRecall(vault, {
    sessionId: "child-seg",
    turns: [
      turn("t5", "user", "gamma question about refunds after compaction", 61),
      turn("t6", "assistant", "gamma answer about refunds after compaction", 62),
      turn("t7", "user", "delta question about credits after compaction", 63),
      turn("t8", "assistant", "delta answer about credits after compaction", 64),
    ],
    summaryGroupSize: 2,
    createdAt: "2026-07-01T09:01:10.000Z",
    lineage: { rootId: "root-seg", parentId: "root-seg", depth: 1, source: "payload" },
  });
}

describe("coverage-first selection core", () => {
  test("returns turns touching every detected facet, chronologically, with recomputable diagnostics", () => {
    importLineageThread();

    const coverage = coverageSessionRecall(vault, {
      sessionId: "child-seg",
      charBudget: 100_000,
    });

    // Every depth-1 cluster's turns are covered: the four clusters
    // partition the eight turns, so all eight turns come back.
    expect(coverage.turns.map((t) => t.turn_id)).toEqual([
      "t1",
      "t2",
      "t3",
      "t4",
      "t5",
      "t6",
      "t7",
      "t8",
    ]);

    const diagnostics = coverage.diagnostics;
    expect(diagnostics.facets_detected).toBe(4);
    expect(diagnostics.topics_realized).toBe(4);
    expect(diagnostics.chars_used).toBeGreaterThan(0);
    expect(diagnostics.dropped_turn_ids).toEqual([]);

    // Recomputable: the topic keys are exactly the in-scope depth-1
    // summary node ids, derivable from the record set alone.
    const depthOneIds = listContinuityRecords(vault)
      .filter((record) => record.kind === "session_summary_node" && record.payload["depth"] === 1)
      .map((record) => record.id)
      .toSorted();
    expect(diagnostics.topics.map((topic) => topic.key).toSorted()).toEqual(
      depthOneIds.map((id) => `cluster:${id}`).toSorted(),
    );
    expect(diagnostics.topics.every((topic) => topic.turn_count === 2)).toBe(true);
    // The clamped budget is not part of this task yet: the fan-out spans
    // every detected facet.
    expect(diagnostics.topics_requested).toBe(4);
  });

  test("coverage across the lineage boundary reaches the root segment from the child id", () => {
    importLineageThread();
    const coverage = coverageSessionRecall(vault, { sessionId: "root-seg", charBudget: 100_000 });
    expect(coverage.turns.map((t) => t.turn_id)).toEqual([
      "t1",
      "t2",
      "t3",
      "t4",
      "t5",
      "t6",
      "t7",
      "t8",
    ]);
  });

  test("a scope with no coverage-bearing records returns an honest empty result", () => {
    importLineageThread();
    const coverage = coverageSessionRecall(vault, {
      sessionId: "no-such-session",
      charBudget: 100_000,
    });
    expect(coverage.turns).toEqual([]);
    expect(coverage.diagnostics.facets_detected).toBe(0);
    expect(coverage.diagnostics.topics_realized).toBe(0);
    expect(coverage.diagnostics.chars_used).toBe(0);
  });

  test("a non-positive character budget is refused by name", () => {
    importLineageThread();
    expect(() => coverageSessionRecall(vault, { sessionId: "root-seg", charBudget: 0 })).toThrow(
      /charBudget/,
    );
  });
});

describe("omitted-operation byte-identity (grep unchanged)", () => {
  function seedFrozen(): void {
    importSessionRecall(vault, {
      sessionId: "session-frozen",
      turns: [
        turn("t1", "user", "Find continuity receipt details.", 1),
        turn("t2", "assistant", "Receipt summary with tests.", 2),
      ],
      summaryGroupSize: 2,
      createdAt: "2026-07-01T09:00:00.000Z",
    });
  }

  test("grep output equals the frozen pre-coverage fixture", () => {
    seedFrozen();
    const result = searchSessionRecall(vault, {
      query: "receipt",
      sessionId: "session-frozen",
      limit: 4,
    });
    // Frozen fixture: the full serialized outcome of the pre-coverage
    // search path, pinned so the coverage lane's arrival cannot perturb
    // the operation it rides beside.
    expect(JSON.parse(JSON.stringify(result))).toEqual({
      hits: [
        {
          id: "ctn_20260701090000_5fae660366cad639",
          kind: "session_summary_node",
          score: 3,
          snippet:
            "t1 user: Find continuity receipt details.\nt2 assistant: Receipt summary with tests.",
          line_start: 1,
          line_end: 1,
          depth: 1,
          source_record_ids: [
            "ctn_20260701090000_ae7c6b3f8780ed24",
            "ctn_20260701090000_e65d39ed24f732ab",
          ],
        },
        {
          id: "ctn_20260701090000_ae7c6b3f8780ed24",
          kind: "session_turn",
          score: 3,
          snippet: "Find continuity receipt details.",
          line_start: 1,
          line_end: 1,
          turn_id: "t1",
          role: "user",
        },
        {
          id: "ctn_20260701090000_e65d39ed24f732ab",
          kind: "session_turn",
          score: 3,
          snippet: "Receipt summary with tests.",
          line_start: 1,
          line_end: 1,
          turn_id: "t2",
          role: "assistant",
        },
      ],
    });
  });
});
