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
  isRecallChannel,
  isRecallTelemetryMode,
  isRecallTelemetryStatus,
  listRecallTelemetry,
  RECALL_CHANNEL,
  RECALL_CHANNELS,
  RECALL_TELEMETRY_MODES,
  RECALL_TELEMETRY_STATUSES,
  recallTelemetryEnvelope,
  summarizeRecallTelemetry,
} from "../../../src/core/brain/recall-telemetry.ts";
import { CLIP_PROTECTED_PAYLOAD_KEYS } from "../../../src/core/brain/continuity/types.ts";

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
      channel: RECALL_CHANNEL.cli,
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
        {
          id: "note-bravo",
          path: join(vault, "Daily", "2026-05-20.md"),
          score: 0.5,
        },
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
      channel: RECALL_CHANNEL.cli,
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
      channel: RECALL_CHANNEL.cli,
      mode: "context_pack",
      status: "ok",
      durationMs: 5,
      resultCount: 1,
      topArtifacts: [{ id: "pref-alpha" }],
    });
    emitRecallTelemetry(vault, {
      createdAt: "2026-05-20T15:01:00.000Z",
      host: "unit-test",
      channel: RECALL_CHANNEL.cli,
      mode: "context_pack",
      status: "empty",
      durationMs: 3,
      resultCount: 0,
      gaps: ["no_matching_context", "no_matching_context"],
    });
    emitRecallTelemetry(vault, {
      createdAt: "2026-05-20T15:02:00.000Z",
      host: "unit-test",
      channel: RECALL_CHANNEL.cli,
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
      telemetry: {
        host: "unit-test",
        channel: RECALL_CHANNEL.cli,
        createdAt: "2026-05-20T16:00:00.000Z",
      },
    });

    expect(instrumented.telemetryId).toStartWith("ctn_");
    const records = listRecallTelemetry(vault, { mode: "context_pack" });
    expect(records).toHaveLength(1);
    expect(records[0]!.payload).toMatchObject({
      host: "unit-test",
      channel: RECALL_CHANNEL.cli,
      mode: "context_pack",
      status: "ok",
      result_count: 1,
      metadata: {
        max_tokens: 1000,
        tokens_used: instrumented.tokensUsed,
        skipped_count: 0,
      },
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
      telemetry: {
        host: "unit-test",
        channel: RECALL_CHANNEL.cli,
        createdAt: "2026-05-20T16:05:00.000Z",
      },
    });

    expect(pack.telemetryId).toStartWith("ctn_");
    const records = listRecallTelemetry(vault, { mode: "pre_compress" });
    expect(records).toHaveLength(1);
    expect(records[0]!.payload).toMatchObject({
      host: "unit-test",
      channel: RECALL_CHANNEL.cli,
      mode: "pre_compress",
      status: "ok",
      result_count: 1,
      metadata: {
        top_k: 3,
        total_chars: pack.totalChars,
        active_head_included: false,
      },
    });
  });
});

describe("the recall channel vocabulary", () => {
  test("names exactly the three transports that exist in this repository", () => {
    // No `hermes` member: `hermes` is a host name in this tree, not a
    // delivery path, and minting a channel nothing can ever write would
    // hand the doctor a column that is silent by construction.
    expect([...RECALL_CHANNELS]).toEqual(["mcp", "cli", "hook"]);
    expect(Object.values(RECALL_CHANNEL).toSorted()).toEqual([...RECALL_CHANNELS].toSorted());
  });

  test("the guard accepts every member and rejects near-misses", () => {
    for (const channel of RECALL_CHANNELS) expect(isRecallChannel(channel)).toBe(true);
    expect(isRecallChannel("hermes")).toBe(false);
    expect(isRecallChannel("MCP")).toBe(false);
    expect(isRecallChannel("")).toBe(false);
    expect(isRecallChannel(undefined)).toBe(false);
  });

  test("the mode guard is derived from the member list, `query` included", () => {
    // The three stale copies of this list all omitted `query`, which is a
    // mode the tree has recorded since t_405b8053.
    expect([...RECALL_TELEMETRY_MODES]).toContain("query");
    for (const mode of RECALL_TELEMETRY_MODES) expect(isRecallTelemetryMode(mode)).toBe(true);
    expect(isRecallTelemetryMode("searching")).toBe(false);
    expect(isRecallTelemetryMode("")).toBe(false);
  });

  test("the status guard is derived from the member list", () => {
    for (const status of RECALL_TELEMETRY_STATUSES) {
      expect(isRecallTelemetryStatus(status)).toBe(true);
    }
    expect(isRecallTelemetryStatus("")).toBe(false);
    expect(isRecallTelemetryStatus("OK")).toBe(false);
  });
});

describe("the channel a record was delivered on", () => {
  test("survives a payload clip, so a clipped record is still attributable", () => {
    expect([...CLIP_PROTECTED_PAYLOAD_KEYS]).toContain("channel");
  });

  test("filters records and rolls up on the summary", () => {
    for (const [index, channel] of ["mcp", "cli", "hook", "hook"].entries()) {
      emitRecallTelemetry(vault, {
        createdAt: `2026-05-20T15:0${index}:00.000Z`,
        host: "unit-test",
        channel: channel as (typeof RECALL_CHANNELS)[number],
        mode: "search",
        status: "empty",
        durationMs: 1,
        resultCount: 0,
      });
    }

    const hooks = listRecallTelemetry(vault, { channel: RECALL_CHANNEL.hook });
    expect(hooks).toHaveLength(2);
    expect(hooks.every((record) => record.payload["channel"] === "hook")).toBe(true);

    const summary = summarizeRecallTelemetry(vault);
    expect(summary.by_channel).toEqual({ mcp: 1, cli: 1, hook: 2 });
  });

  test("a channel with no record at all is absent from the rollup, never zero", () => {
    emitRecallTelemetry(vault, {
      createdAt: "2026-05-20T15:00:00.000Z",
      host: "unit-test",
      channel: RECALL_CHANNEL.mcp,
      mode: "query",
      status: "ok",
      durationMs: 1,
      resultCount: 1,
    });
    // Absent, not zero: the summary reports what arrived. Whether a
    // silent channel SHOULD have delivered is the doctor check's
    // question, and it needs the install side to answer it.
    expect(summarizeRecallTelemetry(vault).by_channel).toEqual({ mcp: 1 });
  });
});

describe("the correlation envelope", () => {
  test("copies the correlation fields once and omits what was never supplied", () => {
    expect(recallTelemetryEnvelope({ host: "unit-test", channel: RECALL_CHANNEL.mcp })).toEqual({
      host: "unit-test",
      channel: "mcp",
    });

    expect(
      recallTelemetryEnvelope({
        host: "unit-test",
        channel: RECALL_CHANNEL.hook,
        createdAt: "2026-05-20T15:00:00.000Z",
        sessionId: "sess-1",
        turnId: "turn-1",
      }),
    ).toEqual({
      host: "unit-test",
      channel: "hook",
      createdAt: "2026-05-20T15:00:00.000Z",
      sessionId: "sess-1",
      turnId: "turn-1",
    });
  });

  test("an omitted correlation id never reaches the payload as a key", () => {
    const record = emitRecallTelemetry(vault, {
      ...recallTelemetryEnvelope({ host: "unit-test", channel: RECALL_CHANNEL.cli }),
      mode: "search",
      status: "ok",
      durationMs: 1,
      resultCount: 1,
    });
    expect(Object.keys(record.payload)).not.toContain("session_id");
    expect(Object.keys(record.payload)).not.toContain("turn_id");
    expect(record.payload["channel"]).toBe("cli");
  });
});
