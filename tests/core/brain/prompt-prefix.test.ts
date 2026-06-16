/**
 * Structural prompt-prefix stability (Hindsight brain-loop ops,
 * t_d8c1f7d9): the kernel never calls an LLM, so it cannot attach a
 * provider cache hint to an outbound request. What it CAN guarantee is
 * the byte-stable prompt prefix a provider cache rewards. These tests
 * cover the pure helpers and the gated, fail-soft metric emit.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PROMPT_PREFIX_SURFACE,
  canonicalSegment,
  deterministicPrefix,
  emitPromptPrefixMetric,
  isStable,
  summarizePrefixPass,
} from "../../../src/core/brain/prompt-prefix.ts";
import { METRICS_SCHEMA_VERSION, listMetrics } from "../../../src/core/brain/metrics.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-prompt-prefix-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("deterministicPrefix", () => {
  test("byte-identical prefix and hash for identical inputs", () => {
    const a = deterministicPrefix({
      kind: "write_session",
      segments: ["Decision topic: X", "\n\n"],
    });
    const b = deterministicPrefix({
      kind: "write_session",
      segments: ["Decision topic: X", "\n\n"],
    });
    expect(a.prefix).toBe("Decision topic: X\n\n");
    expect(a.hash).toBe(b.hash);
    expect(a.prefix).toBe(b.prefix);
    expect(a.chars).toBe(b.chars);
    // 64 hex chars = full sha-256.
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("differs predictably when inputs change", () => {
    const a = deterministicPrefix({ kind: "write_session", segments: ["topic A"] });
    const b = deterministicPrefix({ kind: "write_session", segments: ["topic B"] });
    expect(a.hash).not.toBe(b.hash);
  });

  test("chars counts code points, not UTF-16 units", () => {
    const p = deterministicPrefix({ kind: "context_pack", segments: ["💡"] });
    expect(p.chars).toBe(1);
  });
});

describe("canonicalSegment", () => {
  test("key order does not perturb the bytes", () => {
    const a = canonicalSegment({ b: "2", a: "1", c: "3" });
    const b = canonicalSegment({ c: "3", a: "1", b: "2" });
    expect(a).toBe(b);
    expect(a).toBe("a=1\nb=2\nc=3");
  });
});

describe("isStable", () => {
  test("true only when kind and hash both match", () => {
    const base = deterministicPrefix({ kind: "write_session", segments: ["X"] });
    const same = deterministicPrefix({ kind: "write_session", segments: ["X"] });
    const otherText = deterministicPrefix({ kind: "write_session", segments: ["Y"] });
    const otherKind = deterministicPrefix({ kind: "context_pack", segments: ["X"] });
    expect(isStable(base, same)).toBe(true);
    expect(isStable(base, otherText)).toBe(false);
    expect(isStable(base, otherKind)).toBe(false);
  });
});

describe("summarizePrefixPass", () => {
  test("all calls share the head prefix => full stability", () => {
    const p = deterministicPrefix({ kind: "write_session", segments: ["Decision topic: X\n\n"] });
    const summary = summarizePrefixPass({ kind: "write_session", prefixes: [p, p, p, p, p] });
    expect(summary).toEqual({
      kind: "write_session",
      prefix_hash: p.hash,
      prefix_chars: p.chars,
      call_count: 5,
      stable_count: 5,
    });
  });

  test("counts only the calls reusing the head prefix", () => {
    const head = deterministicPrefix({ kind: "write_session", segments: ["A"] });
    const drift = deterministicPrefix({ kind: "write_session", segments: ["B"] });
    const summary = summarizePrefixPass({
      kind: "write_session",
      prefixes: [head, head, drift, head],
    });
    expect(summary.call_count).toBe(4);
    expect(summary.stable_count).toBe(3);
    expect(summary.prefix_hash).toBe(head.hash);
  });

  test("empty pass reports zeros and an empty hash", () => {
    const summary = summarizePrefixPass({ kind: "context_pack", prefixes: [] });
    expect(summary).toEqual({
      kind: "context_pack",
      prefix_hash: "",
      prefix_chars: 0,
      call_count: 0,
      stable_count: 0,
    });
  });
});

describe("emitPromptPrefixMetric", () => {
  const summary = {
    kind: "write_session" as const,
    prefix_hash: "abc",
    prefix_chars: 7,
    call_count: 5,
    stable_count: 5,
  };
  const runAt = "2026-06-05T10:00:00Z";

  test("gate on writes one run-level prompt_prefix record", () => {
    emitPromptPrefixMetric(vault, { runAt, summary }, true);
    const path = join(vault, "Brain", "metrics", `${PROMPT_PREFIX_SURFACE}.jsonl`);
    expect(existsSync(path)).toBe(true);
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      schema: METRICS_SCHEMA_VERSION,
      surface: PROMPT_PREFIX_SURFACE,
      run_at: runAt,
      payload: {
        kind: "write_session",
        prefix_hash: "abc",
        prefix_chars: 7,
        call_count: 5,
        stable_count: 5,
      },
    });
  });

  test("listMetrics discovers the surface with no metrics.ts change", () => {
    emitPromptPrefixMetric(vault, { runAt, summary }, true);
    const records = listMetrics(vault, { surface: PROMPT_PREFIX_SURFACE });
    expect(records).toHaveLength(1);
    expect(records[0]!.surface).toBe(PROMPT_PREFIX_SURFACE);
    expect(records[0]!.payload.call_count).toBe(5);
  });

  test("gate off writes nothing", () => {
    emitPromptPrefixMetric(vault, { runAt, summary }, false);
    emitPromptPrefixMetric(vault, { runAt, summary }, undefined);
    emitPromptPrefixMetric(vault, { runAt, summary }, null);
    expect(existsSync(join(vault, "Brain", "metrics"))).toBe(false);
  });

  test("a bad runAt is swallowed (fail-soft), never throwing", () => {
    expect(() =>
      emitPromptPrefixMetric(vault, { runAt: "not-a-timestamp", summary }, true),
    ).not.toThrow();
    expect(existsSync(join(vault, "Brain", "metrics", `${PROMPT_PREFIX_SURFACE}.jsonl`))).toBe(
      false,
    );
  });
});
