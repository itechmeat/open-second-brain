import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendSessionSummary,
  getSessionSummary,
  listSessionSummaries,
  SessionSummaryError,
} from "../../src/core/brain/session-summary.ts";
import {
  resolveSessionScope,
  SESSION_SCOPE_MAX_LENGTH,
} from "../../src/core/brain/session-scope.ts";
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

describe("project scope (Task 18)", () => {
  test("carries the project, normalized by the shared session-scope slug rule", () => {
    const digest = appendSessionSummary(vault, {
      sessionId: "sess-proj",
      project: "  Open Second/Brain -- v2!  ",
      decisions: ["scoped"],
      createdAt: "2026-06-14T10:00:00.000Z",
    });
    // Exactly what resolveSessionScope would produce for the same raw
    // input on the session axis: lowercase, non-alphanumerics collapsed
    // to single dashes, edge dashes trimmed.
    const expected = resolveSessionScope("  Open Second/Brain -- v2!  ");
    expect(expected).toBe("open-second-brain-v2");
    expect(digest.project).toBe(expected);
    expect(getSessionSummary(vault, "sess-proj")!.project).toBe(expected);
  });

  test("caps the slug at the shared session-scope length", () => {
    const digest = appendSessionSummary(vault, {
      sessionId: "sess-long",
      project: "p".repeat(SESSION_SCOPE_MAX_LENGTH + 40),
      decisions: ["scoped"],
      createdAt: "2026-06-14T10:00:00.000Z",
    });
    expect(digest.project).toBe("p".repeat(SESSION_SCOPE_MAX_LENGTH));
  });

  test("a digest with no project is byte-identical to today, dedupe key included", () => {
    const digest = appendSessionSummary(vault, {
      sessionId: "sess-plain",
      request: "Add a structured session summary",
      decisions: ["Reuse the continuity store"],
      createdAt: "2026-06-14T10:00:00.000Z",
    });
    expect(digest.project).toBeUndefined();
    expect(Object.keys(digest).toSorted()).toEqual([
      "createdAt",
      "decisions",
      "id",
      "learnings",
      "nextSteps",
      "request",
      "sessionId",
    ]);

    const record = listContinuityRecords(vault, { kind: "session_summary_digest" })[0]!;
    // The pre-project key shape, pinned literally: a changed dedupe key
    // would silently stop deduplicating every digest already on disk.
    const contentHash = createHash("sha256")
      .update(
        JSON.stringify([
          "Add a structured session summary",
          ["Reuse the continuity store"],
          [],
          [],
        ]),
      )
      .digest("hex")
      .slice(0, 16);
    expect(record.payload["dedupe_key"]).toBe(`session_summary_digest:sess-plain:${contentHash}`);
    expect(record.payload["project"]).toBeUndefined();
    expect(Object.keys(record.payload).toSorted()).toEqual([
      "content_hash",
      "decisions",
      "dedupe_key",
      "learnings",
      "next_steps",
      "request",
      "session_id",
    ]);
  });

  test("the same content under two projects are two digests, not one dedupe hit", () => {
    const base = {
      sessionId: "sess-two",
      decisions: ["same decision"],
      createdAt: "2026-06-14T10:00:00.000Z",
    } as const;
    const alpha = appendSessionSummary(vault, { ...base, project: "alpha" });
    const beta = appendSessionSummary(vault, { ...base, project: "beta" });
    const unscoped = appendSessionSummary(vault, base);
    expect(new Set([alpha.id, beta.id, unscoped.id]).size).toBe(3);
    // ...and a re-append under the same project still dedupes.
    expect(appendSessionSummary(vault, { ...base, project: "alpha" }).id).toBe(alpha.id);
  });

  test("rejects a project with no alphanumeric by name rather than dropping it", () => {
    expect(() =>
      appendSessionSummary(vault, {
        sessionId: "sess-bad",
        project: "---",
        decisions: ["scoped"],
        createdAt: "2026-06-14T10:00:00.000Z",
      }),
    ).toThrow(SessionSummaryError);
    expect(() =>
      appendSessionSummary(vault, {
        sessionId: "sess-bad",
        project: "   ",
        decisions: ["scoped"],
        createdAt: "2026-06-14T10:00:00.000Z",
      }),
    ).toThrow(/project/);
    expect(listContinuityRecords(vault, { kind: "session_summary_digest" }).length).toBe(0);
  });

  test("listSessionSummaries filters by project", () => {
    appendSessionSummary(vault, {
      sessionId: "s-a",
      project: "Alpha Project",
      decisions: ["a"],
      createdAt: "2026-06-14T10:00:00.000Z",
    });
    appendSessionSummary(vault, {
      sessionId: "s-b",
      project: "beta",
      decisions: ["b"],
      createdAt: "2026-06-14T11:00:00.000Z",
    });
    appendSessionSummary(vault, {
      sessionId: "s-c",
      decisions: ["c"],
      createdAt: "2026-06-14T12:00:00.000Z",
    });

    expect(listSessionSummaries(vault).length).toBe(3);
    // The filter normalizes by the same rule as the write.
    const alpha = listSessionSummaries(vault, { project: "alpha-project" });
    expect(alpha.length).toBe(1);
    expect(alpha[0]!.sessionId).toBe("s-a");
    expect(listSessionSummaries(vault, { project: "ALPHA PROJECT" })[0]!.sessionId).toBe("s-a");
    expect(listSessionSummaries(vault, { project: "beta" }).length).toBe(1);
    expect(listSessionSummaries(vault, { project: "nope" }).length).toBe(0);
  });

  test("a malformed project filter is rejected by name, not silently ignored", () => {
    appendSessionSummary(vault, {
      sessionId: "s-a",
      project: "alpha",
      decisions: ["a"],
      createdAt: "2026-06-14T10:00:00.000Z",
    });
    // Silently ignoring it would return every digest - a wrong answer
    // dressed as a successful filter.
    expect(() => listSessionSummaries(vault, { project: "***" })).toThrow(SessionSummaryError);
  });
});
