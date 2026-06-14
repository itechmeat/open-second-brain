/**
 * Usage-driven working-memory decay (Recall & Working-Memory Quality
 * Suite, t_c27e1c3f).
 *
 * Continuity records are append-only and immutable, so decay is a pure
 * READ-SIDE weight: never a mutation. The usage signal is derived only
 * from existing `recall_telemetry` records (their surfaced artifacts);
 * a record whose sources were never surfaced has no usage signal and
 * decays by age alone - no fabricated coupling. The weight is a pure,
 * replayable function of (age, access count, last-access age).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emitRecallTelemetry } from "../../../../src/core/brain/recall-telemetry.ts";
import { appendContinuityRecord } from "../../../../src/core/brain/continuity/store.ts";
import { loadNormalizedContinuityRecords } from "../../../../src/core/brain/continuity/read-model.ts";
import {
  decayWeight,
  deriveUsageSignals,
  rankByUsageDecay,
  usageForRecord,
} from "../../../../src/core/brain/continuity/usage-signal.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-06-14T00:00:00.000Z");

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-usage-signal-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("decayWeight (pure)", () => {
  test("is bounded in (0, 1] and equals 1 for a just-touched record", () => {
    const w = decayWeight({ createdAtMs: NOW, accessCount: 0, lastAccessAtMs: NOW }, NOW);
    expect(w).toBeLessThanOrEqual(1);
    expect(w).toBeGreaterThan(0);
    expect(w).toBe(1);
  });

  test("decays monotonically as the reference age grows", () => {
    const fresh = decayWeight(
      { createdAtMs: NOW - 1 * DAY, accessCount: 0, lastAccessAtMs: null },
      NOW,
    );
    const mid = decayWeight(
      { createdAtMs: NOW - 30 * DAY, accessCount: 0, lastAccessAtMs: null },
      NOW,
    );
    const stale = decayWeight(
      { createdAtMs: NOW - 365 * DAY, accessCount: 0, lastAccessAtMs: null },
      NOW,
    );
    expect(fresh).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(stale);
    expect(stale).toBeGreaterThan(0);
  });

  test("a recent access outweighs old creation (recency of use wins)", () => {
    const old = NOW - 200 * DAY;
    const usedRecently = decayWeight(
      { createdAtMs: old, accessCount: 5, lastAccessAtMs: NOW - 1 * DAY },
      NOW,
    );
    const neverUsed = decayWeight({ createdAtMs: old, accessCount: 0, lastAccessAtMs: null }, NOW);
    expect(usedRecently).toBeGreaterThan(neverUsed);
  });

  test("more accesses never lower the weight at equal recency", () => {
    const ref = NOW - 60 * DAY;
    const few = decayWeight({ createdAtMs: ref, accessCount: 1, lastAccessAtMs: ref }, NOW);
    const many = decayWeight({ createdAtMs: ref, accessCount: 20, lastAccessAtMs: ref }, NOW);
    expect(many).toBeGreaterThanOrEqual(few);
  });

  test("is deterministic: identical inputs give identical output", () => {
    const sig = { createdAtMs: NOW - 17 * DAY, accessCount: 3, lastAccessAtMs: NOW - 5 * DAY };
    expect(decayWeight(sig, NOW)).toBe(decayWeight(sig, NOW));
  });
});

describe("deriveUsageSignals + usageForRecord", () => {
  test("counts surfaced artifacts by id and path with last-access recency", () => {
    emitRecallTelemetry(vault, {
      createdAt: "2026-06-10T00:00:00.000Z",
      host: "t",
      mode: "search",
      status: "ok",
      durationMs: 1,
      resultCount: 1,
      topArtifacts: [{ id: "note-x", path: "Brain/notes/x.md", score: 0.9 }],
    });
    emitRecallTelemetry(vault, {
      createdAt: "2026-06-12T00:00:00.000Z",
      host: "t",
      mode: "search",
      status: "ok",
      durationMs: 1,
      resultCount: 1,
      topArtifacts: [{ id: "note-x", path: "Brain/notes/x.md", score: 0.8 }],
    });
    const signals = deriveUsageSignals(vault);
    const byId = signals.get("note-x");
    const byPath = signals.get("Brain/notes/x.md");
    expect(byId).toBeDefined();
    expect(byId!.accessCount).toBe(2);
    expect(byId!.lastAccessAtMs).toBe(Date.parse("2026-06-12T00:00:00.000Z"));
    // id and path resolve to the same aggregate (one artifact, not two).
    expect(byPath).toBe(byId);
  });

  test("a record whose source was surfaced gets the aggregated usage", () => {
    emitRecallTelemetry(vault, {
      createdAt: "2026-06-12T00:00:00.000Z",
      host: "t",
      mode: "search",
      status: "ok",
      durationMs: 1,
      resultCount: 1,
      topArtifacts: [{ id: "note-x", path: "Brain/notes/x.md", score: 0.8 }],
    });
    appendContinuityRecord(vault, {
      kind: "context_receipt",
      createdAt: "2026-06-01T00:00:00.000Z",
      sourceRefs: [{ id: "note-x", path: "Brain/notes/x.md" }],
    });
    const signals = deriveUsageSignals(vault);
    const records = loadNormalizedContinuityRecords(vault, { kind: "context_receipt" });
    const usage = usageForRecord(records[0]!, signals);
    expect(usage.accessCount).toBe(1);
    expect(usage.lastAccessAtMs).toBe(Date.parse("2026-06-12T00:00:00.000Z"));
  });

  test("a session-scoped record with no surfaced source decays by age alone", () => {
    emitRecallTelemetry(vault, {
      createdAt: "2026-06-12T00:00:00.000Z",
      host: "t",
      mode: "search",
      status: "ok",
      durationMs: 1,
      resultCount: 1,
      topArtifacts: [{ id: "note-x", path: "Brain/notes/x.md", score: 0.8 }],
    });
    // Working-memory extracts reference session/turn ids, NOT vault paths,
    // so they never match a surfaced artifact: usage is empty (no fabricated
    // link), and the record decays purely by age.
    appendContinuityRecord(vault, {
      kind: "pre_compact_extract",
      createdAt: "2026-06-01T00:00:00.000Z",
      sourceRefs: [{ id: "sess-1" }],
      payload: { extract_type: "decision", text: "ship the suite", session_id: "sess-1" },
    });
    const signals = deriveUsageSignals(vault);
    const records = loadNormalizedContinuityRecords(vault, { kind: "pre_compact_extract" });
    const usage = usageForRecord(records[0]!, signals);
    expect(usage.accessCount).toBe(0);
    expect(usage.lastAccessAtMs).toBeNull();
  });
});

describe("rankByUsageDecay", () => {
  test("a frequently and recently used record outranks a stale one", () => {
    emitRecallTelemetry(vault, {
      createdAt: "2026-06-13T00:00:00.000Z",
      host: "t",
      mode: "search",
      status: "ok",
      durationMs: 1,
      resultCount: 1,
      topArtifacts: [{ id: "fresh", path: "Brain/notes/fresh.md", score: 0.9 }],
    });
    appendContinuityRecord(vault, {
      kind: "context_receipt",
      createdAt: "2026-05-01T00:00:00.000Z",
      sourceRefs: [{ id: "fresh", path: "Brain/notes/fresh.md" }],
    });
    appendContinuityRecord(vault, {
      kind: "context_receipt",
      createdAt: "2026-05-01T00:00:00.000Z",
      sourceRefs: [{ id: "stale", path: "Brain/notes/stale.md" }],
    });
    const signals = deriveUsageSignals(vault);
    const records = loadNormalizedContinuityRecords(vault, { kind: "context_receipt" });
    const ranked = rankByUsageDecay(records, signals, NOW);
    expect(ranked).toHaveLength(2);
    expect(ranked[0]!.record.sourceRefs[0]!["id"]).toBe("fresh");
    expect(ranked[0]!.weight).toBeGreaterThan(ranked[1]!.weight);
    // Ranking is sorted descending by weight.
    expect(ranked[0]!.weight).toBeGreaterThanOrEqual(ranked[1]!.weight);
  });
});
