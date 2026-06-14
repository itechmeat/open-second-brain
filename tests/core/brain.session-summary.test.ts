import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendSessionSummary,
  getSessionSummary,
  listSessionSummaries,
  SessionSummaryError,
} from "../../src/core/brain/session-summary.ts";
import { listContinuityRecords } from "../../src/core/brain/continuity/store.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-session-summary-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("appendSessionSummary", () => {
  test("writes a session-scoped digest and reads it back as a unit", () => {
    const digest = appendSessionSummary(vault, {
      sessionId: "sess-1",
      request: "Add a structured session summary",
      decisions: ["Reuse the continuity store", "Agent supplies categories"],
      learnings: ["session_summary_node is a recall rollup, not a digest"],
      nextSteps: ["Wire the MCP tool"],
      createdAt: "2026-06-14T10:00:00.000Z",
    });
    expect(digest.sessionId).toBe("sess-1");
    expect(digest.request).toBe("Add a structured session summary");
    expect(digest.decisions).toEqual(["Reuse the continuity store", "Agent supplies categories"]);
    expect(digest.learnings.length).toBe(1);
    expect(digest.nextSteps).toEqual(["Wire the MCP tool"]);

    const read = getSessionSummary(vault, "sess-1");
    expect(read).not.toBeNull();
    expect(read!.id).toBe(digest.id);
    expect(read!.decisions).toEqual(digest.decisions);
  });

  test("rejects a digest with no content in any category (no empty digest)", () => {
    expect(() =>
      appendSessionSummary(vault, {
        sessionId: "sess-empty",
        request: "   ",
        decisions: ["", "  "],
        learnings: [],
        nextSteps: [],
        createdAt: "2026-06-14T10:00:00.000Z",
      }),
    ).toThrow(SessionSummaryError);
  });

  test("trims and drops empty category entries", () => {
    const digest = appendSessionSummary(vault, {
      sessionId: "sess-trim",
      decisions: ["  keep me  ", "", "   "],
      createdAt: "2026-06-14T10:00:00.000Z",
    });
    expect(digest.decisions).toEqual(["keep me"]);
    expect(digest.request).toBeNull();
    expect(digest.learnings).toEqual([]);
  });

  test("dedupes an identical re-append for the same session", () => {
    const input = {
      sessionId: "sess-dup",
      decisions: ["one decision"],
      createdAt: "2026-06-14T10:00:00.000Z",
    } as const;
    const first = appendSessionSummary(vault, input);
    const second = appendSessionSummary(vault, input);
    expect(second.id).toBe(first.id);
    expect(listContinuityRecords(vault, { kind: "session_summary_digest" }).length).toBe(1);
  });

  test("getSessionSummary returns the latest digest when several exist", () => {
    appendSessionSummary(vault, {
      sessionId: "sess-multi",
      decisions: ["older"],
      createdAt: "2026-06-14T09:00:00.000Z",
    });
    const newer = appendSessionSummary(vault, {
      sessionId: "sess-multi",
      decisions: ["newer"],
      createdAt: "2026-06-14T11:00:00.000Z",
    });
    expect(getSessionSummary(vault, "sess-multi")!.id).toBe(newer.id);
  });

  test("records source refs to the session and its turns for lineage", () => {
    appendSessionSummary(vault, {
      sessionId: "sess-refs",
      decisions: ["decided"],
      sourceTurnIds: ["t-1", "t-2"],
      createdAt: "2026-06-14T10:00:00.000Z",
    });
    const record = listContinuityRecords(vault, { kind: "session_summary_digest" })[0]!;
    const refKinds = record.sourceRefs.map((r) => `${r.kind}:${r.id}`);
    expect(refKinds).toContain("session:sess-refs");
    expect(refKinds).toContain("session_turn:t-1");
    expect(refKinds).toContain("session_turn:t-2");
  });
});

describe("byte-identical when unused", () => {
  test("getSessionSummary returns null and the store stays empty when nothing is written", () => {
    expect(getSessionSummary(vault, "never")).toBeNull();
    expect(listSessionSummaries(vault).length).toBe(0);
    expect(listContinuityRecords(vault).length).toBe(0);
  });
});
