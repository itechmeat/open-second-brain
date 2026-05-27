import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendLogEvent } from "../../src/core/brain/log.ts";
import { countBrainEvents } from "../../src/core/discipline/log-counts.ts";

function vaultWithLog(dayBody: string): string {
  const v = mkdtempSync(join(tmpdir(), "o2b-disc-log-"));
  const dir = join(v, "Brain", "log");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "2026-05-17.md"),
    "---\nkind: brain-log\ndate: 2026-05-17\ntags: [brain]\n---\n\n" + dayBody,
    "utf8",
  );
  return v;
}

describe("countBrainEvents", () => {
  test("buckets by kind per agent and ignores no-agent blocks", () => {
    const body =
      "## 08:00:00Z — feedback\n- agent: @claude-vps-agent\n- topic: foo\n\n" +
      "## 09:00:00Z — apply-evidence\n- agent: @claude-vps-agent\n- pref_id: pref-x\n\n" +
      "## 10:00:00Z — feedback\n- agent: @codex-vps-agent\n- topic: bar\n\n" +
      "## 11:00:00Z — promote\n- agent: @claude-vps-agent\n- promoted: 0\n\n" +
      "## 12:00:00Z — rollback\n- run_id: x\n";
    const v = vaultWithLog(body);
    const out = countBrainEvents(v, "2026-05-17", ["@claude-vps-agent", "@codex-vps-agent"]);
    expect(out.byAgent["@claude-vps-agent"]).toEqual({
      feedback: 1,
      apply_evidence: 1,
      note: 0,
      other: 1,
      total: 3,
    });
    expect(out.byAgent["@codex-vps-agent"]).toEqual({
      feedback: 1,
      apply_evidence: 0,
      note: 0,
      other: 0,
      total: 1,
    });
    expect(out.total).toBe(4);
    expect(out.unknownAgents).toEqual([]);
    rmSync(v, { recursive: true });
  });

  test("agent missing from known_agents shows under unknownAgents", () => {
    const body = "## 08:00:00Z — feedback\n- agent: @stranger\n- topic: foo\n\n";
    const v = vaultWithLog(body);
    const out = countBrainEvents(v, "2026-05-17", ["@claude-vps-agent"]);
    expect(out.byAgent["@claude-vps-agent"]).toEqual({
      feedback: 0,
      apply_evidence: 0,
      note: 0,
      other: 0,
      total: 0,
    });
    expect(out.unknownAgents).toEqual([
      {
        agent: "@stranger",
        counts: { feedback: 1, apply_evidence: 0, note: 0, other: 0, total: 1 },
      },
    ]);
    rmSync(v, { recursive: true });
  });

  test("missing log file → all zeros, no error", () => {
    const v = mkdtempSync(join(tmpdir(), "o2b-disc-log-empty-"));
    const out = countBrainEvents(v, "2026-05-17", ["@claude-vps-agent"]);
    expect(out.total).toBe(0);
    expect(out.byAgent["@claude-vps-agent"]!.total).toBe(0);
    rmSync(v, { recursive: true });
  });

  test("counts note events (§32B v0.10.8)", () => {
    const v = mkdtempSync(join(tmpdir(), "o2b-disc-log-note-"));
    try {
      appendLogEvent(v, {
        timestamp: "2026-05-19T10:00:00Z",
        eventType: "note",
        body: { text: "v0.10.7 shipped", agent: "@claude-vps-agent" },
      });
      appendLogEvent(v, {
        timestamp: "2026-05-19T10:00:01Z",
        eventType: "feedback",
        body: {
          signal: "[[sig-x]]",
          topic: "x",
          sign: "positive",
          agent: "@claude-vps-agent",
        },
      });
      const out = countBrainEvents(v, "2026-05-19", ["@claude-vps-agent"]);
      expect(out.byAgent["@claude-vps-agent"]).toEqual({
        feedback: 1,
        apply_evidence: 0,
        note: 1,
        other: 0,
        total: 2,
      });
      expect(out.total).toBe(2);
    } finally {
      rmSync(v, { recursive: true });
    }
  });

  test("reads through the JSONL sidecar when present (§23)", () => {
    // appendLogEvent writes both .md and .jsonl. Delete the .md to
    // prove the reader picked the JSONL path.
    const v = mkdtempSync(join(tmpdir(), "o2b-disc-jsonl-"));
    try {
      appendLogEvent(v, {
        timestamp: "2026-05-19T10:00:00Z",
        eventType: "feedback",
        body: {
          signal: "[[sig-x]]",
          topic: "x",
          sign: "positive",
          agent: "@a1",
        },
      });
      rmSync(join(v, "Brain", "log", "2026-05-19.md"));
      const out = countBrainEvents(v, "2026-05-19", ["@a1"]);
      expect(out.byAgent["@a1"]!.feedback).toBe(1);
      expect(out.byAgent["@a1"]!.total).toBe(1);
    } finally {
      rmSync(v, { recursive: true });
    }
  });

  test("falls back to markdown for historical pre-v0.10.8 days", () => {
    // Pure-markdown fixture (no JSONL sidecar) - simulates a day from
    // before the JSONL writer existed.
    const body = "## 09:00:00Z — feedback\n- agent: @a-legacy\n- topic: old\n";
    const v = vaultWithLog(body);
    const out = countBrainEvents(v, "2026-05-17", ["@a-legacy"]);
    expect(out.byAgent["@a-legacy"]!.feedback).toBe(1);
    rmSync(v, { recursive: true });
  });
});
