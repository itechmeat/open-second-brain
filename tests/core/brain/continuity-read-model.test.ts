/**
 * Continuity read-model (Memory Observability Suite kernel).
 *
 * One normalization layer between the raw JSONL store and every
 * read-side consumer (ATOF/ATIF export, bench harness): schema-version
 * dispatch with legacy records reading as v1, a caller-explicit masking
 * policy for `private` records, and fail-soft handling of unknown kinds
 * and malformed rows - so consumers cannot disagree on any of it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendContinuityRecord } from "../../../src/core/brain/continuity/store.ts";
import {
  loadNormalizedContinuityRecords,
  normalizeContinuityRecord,
} from "../../../src/core/brain/continuity/read-model.ts";
import { CONTINUITY_SCHEMA_VERSION } from "../../../src/core/brain/continuity/types.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-read-model-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

const LEGACY_RAW = {
  id: "ctn_20260101120000_aaaaaaaaaaaaaaaa",
  kind: "recall_telemetry",
  createdAt: "2026-01-01T12:00:00Z",
  sourceRefs: [{ id: "note-a" }],
  payload: { status: "ok" },
  private: false,
  redacted: false,
};

describe("normalizeContinuityRecord", () => {
  test("a stamped record keeps its version; a legacy record reads as v1", () => {
    const stamped = normalizeContinuityRecord({
      ...LEGACY_RAW,
      schema: CONTINUITY_SCHEMA_VERSION,
    });
    expect(stamped).not.toBeNull();
    expect(stamped!.schema).toBe(CONTINUITY_SCHEMA_VERSION);
    expect(stamped!.legacy).toBe(false);

    const legacy = normalizeContinuityRecord(LEGACY_RAW);
    expect(legacy).not.toBeNull();
    expect(legacy!.schema).toBe(CONTINUITY_SCHEMA_VERSION);
    expect(legacy!.legacy).toBe(true);
  });

  test("session/turn correlation ids surface as first-class fields", () => {
    const normalized = normalizeContinuityRecord({
      ...LEGACY_RAW,
      kind: "session_turn",
      payload: { session_id: "s-1", turn_id: "t-3", role: "user", text: "hello" },
    });
    expect(normalized!.sessionId).toBe("s-1");
    expect(normalized!.turnId).toBe("t-3");
  });

  test("malformed rows and non-record values normalize to null, fail-soft", () => {
    expect(normalizeContinuityRecord(null)).toBeNull();
    expect(normalizeContinuityRecord("garbage")).toBeNull();
    expect(normalizeContinuityRecord({ kind: "recall_telemetry" })).toBeNull();
    // Unknown kinds stay readable - the evolution rule says additive.
    const unknown = normalizeContinuityRecord({ ...LEGACY_RAW, kind: "future_kind" });
    expect(unknown).not.toBeNull();
    expect(unknown!.kind).toBe("future_kind");
  });
});

describe("loadNormalizedContinuityRecords", () => {
  test("private records are dropped by default and kept only on request", () => {
    appendContinuityRecord(vault, {
      kind: "context_receipt",
      createdAt: "2026-06-03T10:00:00Z",
      payload: { text: "open detail" },
    });
    appendContinuityRecord(vault, {
      kind: "context_receipt",
      createdAt: "2026-06-03T10:01:00Z",
      payload: { text: "carries a <private>secret plan</private> region" },
    });

    const safe = loadNormalizedContinuityRecords(vault);
    expect(safe).toHaveLength(1);
    expect(JSON.stringify(safe)).not.toContain("secret plan");

    const all = loadNormalizedContinuityRecords(vault, { keepPrivate: true });
    expect(all).toHaveLength(2);
    // Even kept records stay redaction-masked: the store stripped the
    // region at write time and the read-model never un-masks.
    expect(JSON.stringify(all)).not.toContain("secret plan");
  });

  test("kind and session filters narrow the load", () => {
    appendContinuityRecord(vault, {
      kind: "session_turn",
      createdAt: "2026-06-03T10:00:00Z",
      payload: { session_id: "s-1", turn_id: "t-1", role: "user", text: "alpha" },
    });
    appendContinuityRecord(vault, {
      kind: "session_turn",
      createdAt: "2026-06-03T10:01:00Z",
      payload: { session_id: "s-2", turn_id: "t-1", role: "user", text: "beta" },
    });
    appendContinuityRecord(vault, {
      kind: "recall_telemetry",
      createdAt: "2026-06-03T10:02:00Z",
      payload: { status: "ok", session_id: "s-1" },
    });

    const turns = loadNormalizedContinuityRecords(vault, { kind: "session_turn" });
    expect(turns).toHaveLength(2);
    const sessionOne = loadNormalizedContinuityRecords(vault, { sessionId: "s-1" });
    expect(sessionOne).toHaveLength(2);
    expect(sessionOne.every((r) => r.sessionId === "s-1")).toBe(true);
  });
});
