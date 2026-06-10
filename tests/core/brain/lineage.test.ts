/**
 * Unit tests for the session-lineage kernel
 * (continuity-hygiene-freshness suite, Task 2; kanban t_d08ccc5a /
 * t_a94623ad).
 *
 * Resolution order pinned here: native payload fields win; the interim
 * Hermes crutch (CRUTCH(t_1459706f)) links only on compression evidence
 * + same cwd + bounded window; everything else is flat. A false stitch
 * is worse than a missed stitch, so every ambiguous case resolves flat.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  CRUTCH_LINK_WINDOW_MS,
  readLineageLedger,
  recordLineageObservation,
  sessionLineageLedgerPath,
} from "../../../src/core/brain/lineage/ledger.ts";
import { resolveSessionLineage } from "../../../src/core/brain/lineage/resolve.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-lineage-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const T0 = Date.parse("2026-06-10T08:00:00Z");

describe("resolveSessionLineage — native payload path", () => {
  test("uses payload lineage fields when present", () => {
    const lineage = resolveSessionLineage({
      sessionId: "s-child",
      parentSessionId: "s-parent",
      rootSessionId: "s-root",
      compressionDepth: 2,
    });
    expect(lineage).toEqual({
      rootId: "s-root",
      parentId: "s-parent",
      depth: 2,
      source: "payload",
    });
  });

  test("defaults root to parent and depth to 1 when only parent_session_id arrives", () => {
    const lineage = resolveSessionLineage({ sessionId: "s-child", parentSessionId: "s-parent" });
    expect(lineage).toEqual({
      rootId: "s-parent",
      parentId: "s-parent",
      depth: 1,
      source: "payload",
    });
  });

  test("ignores a parent equal to the session itself (flat)", () => {
    const lineage = resolveSessionLineage({ sessionId: "s-1", parentSessionId: "s-1" });
    expect(lineage.source).toBe("flat");
    expect(lineage.rootId).toBe("s-1");
  });
});

describe("resolveSessionLineage — flat fallback", () => {
  test("no payload fields and no ledger resolves flat", () => {
    const lineage = resolveSessionLineage({ sessionId: "s-1" });
    expect(lineage).toEqual({ rootId: "s-1", parentId: null, depth: 0, source: "flat" });
  });
});

describe("lineage ledger — observations", () => {
  test("read of a missing ledger returns an empty state", () => {
    const state = readLineageLedger(tmp);
    expect(state.size).toBe(0);
  });

  test("records observations and reads them back last-wins", () => {
    recordLineageObservation(tmp, {
      sessionId: "s-1",
      at: new Date(T0).toISOString(),
      cwd: "/work",
      event: "UserPromptSubmit",
    });
    recordLineageObservation(tmp, {
      sessionId: "s-1",
      at: new Date(T0 + 60_000).toISOString(),
      cwd: "/work",
      event: "PostCompact",
      compressionEvidence: true,
    });
    const state = readLineageLedger(tmp);
    const entry = state.get("s-1");
    expect(entry?.lastSeenMs).toBe(T0 + 60_000);
    expect(entry?.cwd).toBe("/work");
    expect(entry?.compressionEvidence).toBe(true);
  });

  test("skips corrupt ledger lines instead of throwing", () => {
    const path = sessionLineageLedgerPath(tmp);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, "not-json\n{\n", "utf8");
    recordLineageObservation(tmp, {
      sessionId: "s-1",
      at: new Date(T0).toISOString(),
      event: "Stop",
    });
    const state = readLineageLedger(tmp);
    expect(state.size).toBe(1);
  });
});

describe("resolveSessionLineage — crutch path (CRUTCH(t_1459706f))", () => {
  function seedPredecessor(opts: { evidence: boolean; cwd?: string; endMs?: number }): void {
    recordLineageObservation(tmp, {
      sessionId: "s-old",
      at: new Date(opts.endMs ?? T0).toISOString(),
      cwd: opts.cwd ?? "/work",
      event: opts.evidence ? "PostCompact" : "Stop",
      ...(opts.evidence ? { compressionEvidence: true } : {}),
    });
  }

  test("links a new session to a compression-evidenced predecessor in the same cwd", () => {
    seedPredecessor({ evidence: true });
    const lineage = resolveSessionLineage(
      { sessionId: "s-new", cwd: "/work" },
      { ledger: readLineageLedger(tmp), nowMs: T0 + 30_000 },
    );
    expect(lineage).toEqual({ rootId: "s-old", parentId: "s-old", depth: 1, source: "crutch" });
  });

  test("does not link without compression evidence", () => {
    seedPredecessor({ evidence: false });
    const lineage = resolveSessionLineage(
      { sessionId: "s-new", cwd: "/work" },
      { ledger: readLineageLedger(tmp), nowMs: T0 + 30_000 },
    );
    expect(lineage.source).toBe("flat");
  });

  test("does not link across different cwds", () => {
    seedPredecessor({ evidence: true, cwd: "/elsewhere" });
    const lineage = resolveSessionLineage(
      { sessionId: "s-new", cwd: "/work" },
      { ledger: readLineageLedger(tmp), nowMs: T0 + 30_000 },
    );
    expect(lineage.source).toBe("flat");
  });

  test("does not link outside the bounded window", () => {
    seedPredecessor({ evidence: true });
    const lineage = resolveSessionLineage(
      { sessionId: "s-new", cwd: "/work" },
      { ledger: readLineageLedger(tmp), nowMs: T0 + CRUTCH_LINK_WINDOW_MS + 1 },
    );
    expect(lineage.source).toBe("flat");
  });

  test("does not link when the session already has its own ledger history", () => {
    seedPredecessor({ evidence: true });
    // s-new was already active before the predecessor's compaction -
    // it is a parallel session, not a continuation.
    recordLineageObservation(tmp, {
      sessionId: "s-new",
      at: new Date(T0 - 120_000).toISOString(),
      cwd: "/work",
      event: "UserPromptSubmit",
    });
    const lineage = resolveSessionLineage(
      { sessionId: "s-new", cwd: "/work" },
      { ledger: readLineageLedger(tmp), nowMs: T0 + 30_000 },
    );
    expect(lineage.source).toBe("flat");
  });

  test("persisted crutch links are reused and chain depth across two compactions", () => {
    seedPredecessor({ evidence: true });
    const first = resolveSessionLineage(
      { sessionId: "s-mid", cwd: "/work" },
      { ledger: readLineageLedger(tmp), nowMs: T0 + 10_000 },
    );
    expect(first.source).toBe("crutch");
    recordLineageObservation(tmp, {
      sessionId: "s-mid",
      at: new Date(T0 + 10_000).toISOString(),
      cwd: "/work",
      event: "SessionStart",
      lineage: first,
    });
    recordLineageObservation(tmp, {
      sessionId: "s-mid",
      at: new Date(T0 + 20_000).toISOString(),
      cwd: "/work",
      event: "PostCompact",
      compressionEvidence: true,
    });
    const second = resolveSessionLineage(
      { sessionId: "s-tip", cwd: "/work" },
      { ledger: readLineageLedger(tmp), nowMs: T0 + 40_000 },
    );
    expect(second).toEqual({ rootId: "s-old", parentId: "s-mid", depth: 2, source: "crutch" });

    // A later event for s-mid resolves from its persisted link, not flat.
    const replay = resolveSessionLineage(
      { sessionId: "s-mid", cwd: "/work" },
      { ledger: readLineageLedger(tmp), nowMs: T0 + 60_000 },
    );
    expect(replay).toEqual({ rootId: "s-old", parentId: "s-old", depth: 1, source: "crutch" });
  });
});

describe("lineage ledger — pruning", () => {
  test("rewrites the ledger keeping the most recent sessions once over capacity", () => {
    for (let i = 0; i < 600; i++) {
      recordLineageObservation(tmp, {
        sessionId: `s-${i}`,
        at: new Date(T0 + i * 1_000).toISOString(),
        event: "Stop",
      });
    }
    const state = readLineageLedger(tmp);
    expect(state.size).toBeLessThanOrEqual(512);
    expect(state.has("s-599")).toBe(true);
    expect(state.has("s-0")).toBe(false);
    const raw = readFileSync(sessionLineageLedgerPath(tmp), "utf8");
    expect(raw.split("\n").filter((line) => line.trim().length > 0).length).toBeLessThanOrEqual(
      512,
    );
  });
});
