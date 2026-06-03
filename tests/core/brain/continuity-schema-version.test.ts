/**
 * Versioned continuity schema (Memory Observability Suite, t_26040ee8).
 *
 * Every new continuity record is stamped with one contract-wide schema
 * version; legacy records without the field read as v1; the dedup id
 * deliberately EXCLUDES the version so identical records keep identical
 * ids across the stamp transition (no migration of existing JSONL).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { join } from "node:path";

import {
  appendContinuityRecord,
  appendContinuitySourceInvalidation,
  continuityLogPath,
  listContinuityRecords,
} from "../../../src/core/brain/continuity/store.ts";
import { CONTINUITY_SCHEMA_VERSION } from "../../../src/core/brain/continuity/types.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-continuity-schema-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("continuity schema version", () => {
  test("the contract-wide constant is o2b.continuity.v1", () => {
    expect(CONTINUITY_SCHEMA_VERSION).toBe("o2b.continuity.v1");
  });

  test("new records are stamped with the schema version, in memory and on disk", () => {
    const record = appendContinuityRecord(vault, {
      kind: "recall_telemetry",
      createdAt: "2026-06-03T10:00:00Z",
      sourceRefs: [{ id: "note-a" }],
      payload: { status: "ok" },
    });
    expect(record.schema).toBe(CONTINUITY_SCHEMA_VERSION);

    const raw = readFileSync(continuityLogPath(vault, "2026-06"), "utf8").trim();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed["schema"]).toBe(CONTINUITY_SCHEMA_VERSION);
  });

  test("source invalidation records carry the version too", () => {
    const record = appendContinuitySourceInvalidation(vault, {
      createdAt: "2026-06-03T10:00:00Z",
      source: { id: "note-b", path: "Brain/notes/b.md" },
      reason: "content drift",
    });
    expect(record.schema).toBe(CONTINUITY_SCHEMA_VERSION);
  });

  test("legacy records without the field are still read and report no version", () => {
    const path = continuityLogPath(vault, "2026-05");
    mkdirSync(dirname(path), { recursive: true });
    const legacy = {
      id: "ctn_20260531120000_aaaaaaaaaaaaaaaa",
      kind: "recall_telemetry",
      createdAt: "2026-05-31T12:00:00Z",
      sourceRefs: [],
      payload: { status: "ok" },
      private: false,
      redacted: false,
    };
    appendFileSync(path, `${JSON.stringify(legacy)}\n`, "utf8");

    const listed = listContinuityRecords(vault, { kind: "recall_telemetry" });
    expect(listed).toHaveLength(1);
    expect(listed[0]!.schema).toBeUndefined();
  });

  test("recordId excludes the schema field: stamped id matches the legacy formula", () => {
    // Two records with identical kind/createdAt/sourceRefs/payload must get
    // the same id regardless of the version stamp. The stamped record's id
    // is reproducible from the pre-stamp input shape - locked here so a
    // future change that folds `schema` into the hash fails loudly.
    const a = appendContinuityRecord(vault, {
      kind: "context_receipt",
      createdAt: "2026-06-03T11:00:00Z",
      sourceRefs: [{ id: "note-c" }],
      payload: { query: "alpha" },
    });
    const b = appendContinuityRecord(vault, {
      kind: "context_receipt",
      createdAt: "2026-06-03T11:00:00Z",
      sourceRefs: [{ id: "note-c" }],
      payload: { query: "alpha" },
    });
    expect(a.id).toBe(b.id);
    // Known-answer id computed with the pre-suite formula (sha-256 over
    // kind/createdAt/sourceRefs/payload only).
    expect(a.id).toBe("ctn_20260603110000_4eecda1810fdbf02");
  });
});
