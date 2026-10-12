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

import {
  appendContinuityRecord,
  listContinuityRecords,
} from "../../../src/core/brain/continuity/store.ts";
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
    // The adaptive topic budget: four facets floor at 12, and the
    // diagnostics report the four realized topics honestly.
    expect(diagnostics.topics_requested).toBe(12);
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

describe("adaptive topic budget over coverage", () => {
  function importFacetThread(facets: number): void {
    importSessionRecall(vault, {
      sessionId: "facet-seg",
      turns: Array.from({ length: facets }, (_, index) =>
        turn(`t${index + 1}`, "user", `topic ${index + 1} distinct material`, index + 1),
      ),
      summaryGroupSize: 1,
      createdAt: "2026-07-02T09:00:00.000Z",
    });
  }

  test("a 40-facet thread caps the budget at 16", () => {
    importFacetThread(40);
    const coverage = coverageSessionRecall(vault, {
      sessionId: "facet-seg",
      charBudget: 1_000_000,
    });
    expect(coverage.diagnostics.facets_detected).toBe(40);
    expect(coverage.diagnostics.topics_requested).toBe(16);
    expect(coverage.diagnostics.topics_realized).toBe(16);
    // Groups of one: each realized cluster establishes exactly one turn,
    // so the capped fan-out reaches the first 16 turns of the thread.
    expect(coverage.turns).toHaveLength(16);
  });

  test("a 3-facet thread floors at 12 and reports 3 realized topics honestly", () => {
    importFacetThread(3);
    const coverage = coverageSessionRecall(vault, { sessionId: "facet-seg", charBudget: 100_000 });
    expect(coverage.diagnostics.topics_requested).toBe(12);
    expect(coverage.diagnostics.topics_realized).toBe(3);
    expect(coverage.diagnostics.topics).toHaveLength(3);
    expect(coverage.turns.map((t) => t.turn_id)).toEqual(["t1", "t2", "t3"]);
  });

  test("coverage is deterministic across repeated calls", () => {
    importLineageThread();
    const first = coverageSessionRecall(vault, { sessionId: "child-seg", charBudget: 100_000 });
    const second = coverageSessionRecall(vault, { sessionId: "child-seg", charBudget: 100_000 });
    expect(JSON.parse(JSON.stringify(first))).toEqual(JSON.parse(JSON.stringify(second)));
  });
});

describe("mined-key facets", () => {
  function importMinedThread(): void {
    importSessionRecall(vault, {
      sessionId: "mined-seg",
      turns: [
        turn("t1", "user", "call `SessionStore` for the receipts flow", 1),
        turn("t2", "assistant", "SessionStore keeps the receipt ledger", 2),
        turn("t3", "user", "unrelated turn about weather", 3),
      ],
      summaryGroupSize: 2,
      createdAt: "2026-07-03T09:00:00.000Z",
    });
    // The mined-mention ledger row the session miner would have written
    // for t1 (one record per family/key/session).
    appendContinuityRecord(vault, {
      kind: "session_entity_mention",
      createdAt: "2026-07-03T09:00:01.000Z",
      sourceRefs: [{ id: "mined-seg:t1:symbol:SessionStore" }],
      payload: { family: "symbol", key: "SessionStore", session_ref: "mined-seg", turn_id: "t1" },
    });
  }

  test("mined keys join the fan-out and match every turn that carries them", () => {
    importMinedThread();
    const coverage = coverageSessionRecall(vault, { sessionId: "mined-seg", charBudget: 100_000 });
    const mined = coverage.diagnostics.topics.find((topic) => topic.origin === "mined");
    expect(mined).toMatchObject({ key: "mined:symbol:SessionStore", turn_count: 1 });
    // The wide pass matches every in-scope turn carrying the key, not
    // only the establishing turn: t2 mentions it too and is returned.
    expect(coverage.turns.map((t) => t.turn_id)).toEqual(["t1", "t2", "t3"]);
  });

  test("a mention scoped outside the requested session contributes no facet", () => {
    importMinedThread();
    const coverage = coverageSessionRecall(vault, {
      sessionId: "other-seg",
      charBudget: 100_000,
    });
    expect(coverage.diagnostics.topics.filter((topic) => topic.origin === "mined")).toEqual([]);
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
