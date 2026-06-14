import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { traceIdeaLineage, IdeaLineageError } from "../../src/core/brain/idea-lineage.ts";
import { appendContinuityRecord } from "../../src/core/brain/continuity/store.ts";
import { appendSessionSummary } from "../../src/core/brain/session-summary.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-idea-lineage-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writeDream(date: string, body: Record<string, unknown>): void {
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
  const line = JSON.stringify({ ts: `${date}T08:00:00Z`, kind: "dream", payload: body });
  writeFileSync(join(vault, "Brain", "log", `${date}.jsonl`), `${line}\n`);
}

describe("traceIdeaLineage over the continuity source graph", () => {
  test("a digest traces back to the session turns it was distilled from", () => {
    appendContinuityRecord(vault, {
      kind: "session_turn",
      createdAt: "2026-06-14T09:00:00.000Z",
      payload: { session_id: "s1", turn_id: "t1", role: "user", text: "please add lineage" },
    });
    const digest = appendSessionSummary(vault, {
      sessionId: "s1",
      decisions: ["build the tracer"],
      sourceTurnIds: ["t1"],
      createdAt: "2026-06-14T10:00:00.000Z",
    });

    const result = traceIdeaLineage(vault, { id: digest.id });
    expect(result.root.id).toBe(digest.id);
    expect(result.root.stage).toBe("conclusion");

    const turn = result.nodes.find((n) => n.kind === "session_turn");
    expect(turn).toBeDefined();
    expect(turn!.stage).toBe("observation");
    expect(result.edges.some((e) => e.from === digest.id && e.to === turn!.id)).toBe(true);
  });

  test("a source referenced more than once appears once and traversal terminates", () => {
    const turn = appendContinuityRecord(vault, {
      kind: "session_turn",
      createdAt: "2026-06-14T09:00:00.000Z",
      payload: { session_id: "s2", turn_id: "t1", role: "user", text: "hi" },
    });
    // A node whose sourceRefs reference the same turn twice (by record id
    // and by turn id) must not produce a duplicate node or loop.
    const node = appendContinuityRecord(vault, {
      kind: "session_summary_node",
      createdAt: "2026-06-14T10:00:00.000Z",
      sourceRefs: [
        { id: turn.id, kind: "continuity_record" },
        { id: "t1", kind: "session_turn" },
      ],
      payload: { session_id: "s2", depth: 1, summary: "rollup" },
    });

    const result = traceIdeaLineage(vault, { id: node.id });
    const turnNodes = result.nodes.filter((n) => n.id === turn.id);
    expect(turnNodes.length).toBe(1);
    expect(result.truncated).toBe(false);
  });

  test("a turn ref resolves within the digest's own session when turn ids collide", () => {
    // Two sessions reuse turn_id "t1". The digest in session A must link to
    // A's turn, never B's.
    const turnA = appendContinuityRecord(vault, {
      kind: "session_turn",
      createdAt: "2026-06-14T09:00:00.000Z",
      payload: { session_id: "A", turn_id: "t1", role: "user", text: "in A" },
    });
    appendContinuityRecord(vault, {
      kind: "session_turn",
      createdAt: "2026-06-14T09:30:00.000Z",
      payload: { session_id: "B", turn_id: "t1", role: "user", text: "in B" },
    });
    const digestA = appendSessionSummary(vault, {
      sessionId: "A",
      decisions: ["decided in A"],
      sourceTurnIds: ["t1"],
      createdAt: "2026-06-14T10:00:00.000Z",
    });

    const result = traceIdeaLineage(vault, { id: digestA.id });
    const turnNodes = result.nodes.filter((n) => n.kind === "session_turn");
    expect(turnNodes.length).toBe(1);
    expect(turnNodes[0]!.id).toBe(turnA.id);
  });

  test("an unknown id is a typed error, not a silent empty chain", () => {
    expect(() => traceIdeaLineage(vault, { id: "ctn_does_not_exist" })).toThrow(IdeaLineageError);
  });

  test("a depth bound is reported as truncated", () => {
    // Chain: n2 -> n1 -> turn. maxDepth 1 stops before the turn.
    const turn = appendContinuityRecord(vault, {
      kind: "session_turn",
      createdAt: "2026-06-14T08:00:00.000Z",
      payload: { session_id: "s3", turn_id: "t1", role: "user", text: "root cause" },
    });
    const n1 = appendContinuityRecord(vault, {
      kind: "session_summary_node",
      createdAt: "2026-06-14T09:00:00.000Z",
      sourceRefs: [{ id: turn.id, kind: "continuity_record" }],
      payload: { session_id: "s3", depth: 1, summary: "level 1" },
    });
    const n2 = appendContinuityRecord(vault, {
      kind: "session_summary_node",
      createdAt: "2026-06-14T10:00:00.000Z",
      sourceRefs: [{ id: n1.id, kind: "continuity_record" }],
      payload: { session_id: "s3", depth: 2, summary: "level 2" },
    });

    const result = traceIdeaLineage(vault, { id: n2.id }, { maxDepth: 1 });
    expect(result.truncated).toBe(true);
  });
});

describe("traceIdeaLineage for a preference (belief evolution)", () => {
  test("traces creation then promotion of a preference", () => {
    writeDream("2026-05-01", { run_id: "r1", new_unconfirmed: ["[[pref-foo|First rule]]"] });
    writeDream("2026-05-10", { run_id: "r2", confirmed: ["[[pref-foo|First rule]]"] });

    const result = traceIdeaLineage(vault, { id: "pref-foo" });
    expect(result.root.id).toBe("pref-foo");
    expect(result.root.kind).toBe("preference");
    const stages = result.nodes.map((n) => n.stage);
    expect(stages).toContain("observation"); // creation
    expect(stages).toContain("synthesis"); // promotion
  });

  test("an unknown preference is a typed error", () => {
    expect(() => traceIdeaLineage(vault, { id: "pref-missing" })).toThrow(IdeaLineageError);
  });
});
