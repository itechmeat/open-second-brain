import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listContinuityRecords } from "../../../src/core/brain/continuity/store.ts";
import {
  emitGenerationReport,
  listGenerationReports,
  summarizeGenerationReports,
} from "../../../src/core/brain/generation-reports.ts";
import { estimateTokens } from "../../../src/core/brain/text/tokenizer.ts";
import { continuityLogPath } from "../../../src/core/brain/continuity/store.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-generation-report-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

const PROMPT =
  "Synthesize the persona for [[pref-keep-short]] using secret token=sk-do-not-store-1234";

describe("generation_report continuity kind", () => {
  test("gate ON writes one record with envelope, kind, and content-hash id", () => {
    const record = emitGenerationReport(
      vault,
      {
        handoff: { kind: "write_session", ref: "ws_session-1" },
        agent: "claude-vps-agent",
        provider: "anthropic",
        model: "claude-opus-4-7",
        finishReason: "stop",
        latencyMs: 1234,
        prompt: PROMPT,
        usage: { inputTokens: 900, outputTokens: 120, cachedTokens: 800, totalTokens: 1020 },
        sourceRefs: [
          { id: "ws_session-1", kind: "write_session" },
          { id: "pref-keep-short", path: "Brain/preferences/pref-keep-short.md" },
        ],
        createdAt: "2026-06-15T10:00:00Z",
      },
      true,
    );

    expect(record).not.toBeNull();
    expect(record!.id).toStartWith("ctn_");
    expect(record!.schema).toBe("o2b.continuity.v1");
    expect(record!.kind).toBe("generation_report");

    const stored = listContinuityRecords(vault, { kind: "generation_report" });
    expect(stored).toHaveLength(1);
    expect(stored[0]!.id).toBe(record!.id);

    // Identical inputs => identical dedup id.
    const again = emitGenerationReport(
      vault,
      {
        handoff: { kind: "write_session", ref: "ws_session-1" },
        agent: "claude-vps-agent",
        provider: "anthropic",
        model: "claude-opus-4-7",
        finishReason: "stop",
        latencyMs: 1234,
        prompt: PROMPT,
        usage: { inputTokens: 900, outputTokens: 120, cachedTokens: 800, totalTokens: 1020 },
        sourceRefs: [
          { id: "ws_session-1", kind: "write_session" },
          { id: "pref-keep-short", path: "Brain/preferences/pref-keep-short.md" },
        ],
        createdAt: "2026-06-15T10:00:00Z",
      },
      true,
    );
    expect(again!.id).toBe(record!.id);
  });

  test("gate OFF builds no payload and writes nothing", () => {
    for (const gate of [false, null, undefined] as const) {
      const record = emitGenerationReport(
        vault,
        {
          handoff: { kind: "dream_stage", ref: "dream-1" },
          agent: "a",
          prompt: PROMPT,
          createdAt: "2026-06-15T10:00:00Z",
        },
        gate,
      );
      expect(record).toBeNull();
    }
    expect(listContinuityRecords(vault, { kind: "generation_report" })).toHaveLength(0);
  });

  test("stores prompt_hash + prompt_chars + usage counts only; never raw prompt or output", () => {
    emitGenerationReport(
      vault,
      {
        handoff: { kind: "context_pack", ref: "ctn_receipt-1" },
        agent: "a",
        prompt: PROMPT,
        usage: { inputTokens: 10, outputTokens: 5 },
        createdAt: "2026-06-15T11:00:00Z",
      },
      true,
    );
    const payload = listContinuityRecords(vault, { kind: "generation_report" })[0]!.payload;
    expect(payload["prompt_hash"]).toMatch(/^[a-f0-9]{64}$/);
    expect(payload["prompt_chars"]).toBe([...PROMPT].length);

    // The raw prompt text must not survive to disk anywhere.
    const onDisk = readFileSync(continuityLogPath(vault, "2026-06"), "utf8");
    expect(onDisk).not.toContain("Synthesize the persona");
    expect(onDisk).not.toContain("sk-do-not-store-1234");
  });

  test("local_estimate.input_tokens always present; usage absent reported as absent", () => {
    emitGenerationReport(
      vault,
      {
        handoff: { kind: "write_session", ref: "ws-x" },
        agent: "a",
        prompt: PROMPT,
        createdAt: "2026-06-15T12:00:00Z",
      },
      true,
    );
    const payload = listGenerationReports(vault)[0]!.payload;
    expect((payload["local_estimate"] as Record<string, unknown>)["input_tokens"]).toBe(
      estimateTokens(PROMPT),
    );
    expect(payload["usage"]).toBeUndefined();
  });

  test("sourceRefs join report to handoff ref and memory paths", () => {
    emitGenerationReport(
      vault,
      {
        handoff: { kind: "write_session", ref: "ws_session-7" },
        agent: "a",
        prompt: "short",
        sourceRefs: [{ id: "pref-foo", path: "Brain/preferences/pref-foo.md" }],
        createdAt: "2026-06-15T13:00:00Z",
      },
      true,
    );
    const record = listGenerationReports(vault)[0]!;
    const ids = record.sourceRefs.map((ref) => ref.id);
    expect(ids).toContain("ws_session-7");
    expect(ids).toContain("pref-foo");

    const summary = summarizeGenerationReports(vault);
    expect(summary.total).toBe(1);
    expect(summary.by_handoff_kind["write_session"]).toBe(1);
    expect(summary.local_estimate_tokens).toBe(estimateTokens("short"));
    // memory-path linkage: a path resolves back to the report ids.
    expect(summary.by_path["Brain/preferences/pref-foo.md"]).toEqual([record.id]);
  });

  test("no fetch/provider HTTP call is added under src/core for this feature", () => {
    // The kernel never calls an LLM: tracing is inbound-only. Guard the
    // feature source so a future edit cannot smuggle in an outbound call.
    const source = readFileSync(
      join(import.meta.dir, "../../../src/core/brain/generation-reports.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/https?:\/\//);
    expect(source).not.toMatch(/XMLHttpRequest|node:http|undici/);
  });

  test("fail-open: a throwing build is swallowed (gate carries options)", () => {
    // A non-string prompt would throw inside the build thunk; the emit
    // wrapper must swallow it and return null, never propagate.
    const record = emitGenerationReport(
      vault,
      {
        handoff: { kind: "write_session", ref: "ws-bad" },
        agent: "a",
        // @ts-expect-error deliberately invalid to force a throw inside the thunk
        prompt: 123,
        createdAt: "2026-06-15T14:00:00Z",
      },
      true,
    );
    expect(record).toBeNull();
    expect(listContinuityRecords(vault, { kind: "generation_report" })).toHaveLength(0);
  });
});
