import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { packContext } from "../../../src/core/brain/context-pack.ts";
import { buildPreCompressPack } from "../../../src/core/brain/pre-compress-pack.ts";
import { writePreference } from "../../../src/core/brain/preference.ts";
import { BRAIN_CONFIDENCE, BRAIN_PREFERENCE_STATUS } from "../../../src/core/brain/types.ts";
import {
  emitRecallTelemetry,
  listRecallTelemetry,
  summarizeRecallTelemetry,
} from "../../../src/core/brain/recall-telemetry.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-recall-telemetry-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("recall telemetry", () => {
  test("emits redaction-safe recall telemetry records with source refs", () => {
    const record = emitRecallTelemetry(vault, {
      createdAt: "2026-05-20T15:00:00.000Z",
      host: "unit-test",
      mode: "search",
      status: "ok",
      durationMs: 42,
      resultCount: 2,
      topArtifacts: [
        {
          id: "pref-alpha",
          path: join(vault, "Brain", "preferences", "pref-alpha.md"),
          score: 0.9,
        },
        { id: "note-bravo", path: join(vault, "Daily", "2026-05-20.md"), score: 0.5 },
      ],
      gaps: ["missing_recent_decision"],
      metadata: {
        cache_hit: true,
        raw: "public <private>secret-value</private>",
      },
    });

    expect(record.id).toStartWith("ctn_");
    expect(record.kind).toBe("recall_telemetry");
    expect(record.sourceRefs.map((source) => source.id)).toEqual(["pref-alpha", "note-bravo"]);
    expect(JSON.stringify(record.payload)).not.toContain("secret-value");
    expect(record.payload).toMatchObject({
      host: "unit-test",
      mode: "search",
      status: "ok",
      duration_ms: 42,
      result_count: 2,
      gaps: ["missing_recent_decision"],
      metadata: { cache_hit: true, raw: "public ***PRIVATE***" },
    });
  });

  test("lists telemetry by mode/status and summarizes coverage gaps", () => {
    emitRecallTelemetry(vault, {
      createdAt: "2026-05-20T15:00:00.000Z",
      host: "unit-test",
      mode: "context_pack",
      status: "ok",
      durationMs: 5,
      resultCount: 1,
      topArtifacts: [{ id: "pref-alpha" }],
    });
    emitRecallTelemetry(vault, {
      createdAt: "2026-05-20T15:01:00.000Z",
      host: "unit-test",
      mode: "context_pack",
      status: "empty",
      durationMs: 3,
      resultCount: 0,
      gaps: ["no_matching_context", "no_matching_context"],
    });
    emitRecallTelemetry(vault, {
      createdAt: "2026-05-20T15:02:00.000Z",
      host: "unit-test",
      mode: "pre_compress",
      status: "ok",
      durationMs: 7,
      resultCount: 1,
      topArtifacts: [{ id: "pref-bravo" }],
    });

    const contextPack = listRecallTelemetry(vault, { mode: "context_pack" });
    expect(contextPack.map((record) => record.payload["status"])).toEqual(["empty", "ok"]);

    const summary = summarizeRecallTelemetry(vault, { host: "unit-test" });
    expect(summary).toMatchObject({
      total: 3,
      by_mode: { context_pack: 2, pre_compress: 1 },
      by_status: { ok: 2, empty: 1 },
      total_results: 2,
      empty_runs: 1,
      gap_counts: { no_matching_context: 1 },
    });
  });

  test("packContext can opt in to recall telemetry without changing defaults", () => {
    mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
    writeFileSync(
      join(vault, "Brain", "preferences", "pref-alpha.md"),
      [
        "---",
        "id: pref-alpha",
        "topic: alpha",
        "principle: Prefer crisp answers",
        "tier: core",
        "---",
        "Body",
      ].join("\n"),
    );

    const plain = packContext(vault, { maxTokens: 1000 });
    expect(plain.telemetryId).toBeUndefined();

    const instrumented = packContext(vault, {
      maxTokens: 1000,
      telemetry: { host: "unit-test", createdAt: "2026-05-20T16:00:00.000Z" },
    });

    expect(instrumented.telemetryId).toStartWith("ctn_");
    const records = listRecallTelemetry(vault, { mode: "context_pack" });
    expect(records).toHaveLength(1);
    expect(records[0]!.payload).toMatchObject({
      host: "unit-test",
      mode: "context_pack",
      status: "ok",
      result_count: 1,
      metadata: { max_tokens: 1000, tokens_used: instrumented.tokensUsed, skipped_count: 0 },
    });
  });

  test("buildPreCompressPack can opt in to recall telemetry", () => {
    mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
    writePreference(vault, {
      slug: "bravo",
      topic: "bravo",
      principle: "Keep decisions explicit",
      created_at: "2026-05-20T00:00:00.000Z",
      unconfirmed_until: "2026-05-21T00:00:00.000Z",
      status: BRAIN_PREFERENCE_STATUS.confirmed,
      evidenced_by: ["[[sig-2026-05-20-bravo]]"],
      confirmed_at: "2026-05-20T01:00:00.000Z",
      applied_count: 1,
      violated_count: 0,
      last_evidence_at: "2026-05-20T01:00:00.000Z",
      confidence: BRAIN_CONFIDENCE.high,
      confidence_value: 0.9,
    });

    const pack = buildPreCompressPack(vault, {
      topK: 3,
      telemetry: { host: "unit-test", createdAt: "2026-05-20T16:05:00.000Z" },
    });

    expect(pack.telemetryId).toStartWith("ctn_");
    const records = listRecallTelemetry(vault, { mode: "pre_compress" });
    expect(records).toHaveLength(1);
    expect(records[0]!.payload).toMatchObject({
      host: "unit-test",
      mode: "pre_compress",
      status: "ok",
      result_count: 1,
      metadata: { top_k: 3, total_chars: pack.totalChars, active_head_included: false },
    });
  });
});
