import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeAgentSummary } from "../../../src/core/brain/digest-agent-summary.ts";
import { appendLogEvent } from "../../../src/core/brain/log.ts";
import { BRAIN_LOG_EVENT_KIND, BRAIN_APPLY_RESULT } from "../../../src/core/brain/types.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-agent-summary-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
});

afterEach(() => {
  try {
    rmSync(vault, { recursive: true, force: true });
  } catch {}
});

describe("computeAgentSummary", () => {
  test("returns empty array when no log entries", () => {
    const since = new Date("2026-05-13T00:00:00Z");
    const until = new Date("2026-05-20T00:00:00Z");
    const summary = computeAgentSummary(vault, since, until);
    expect(summary).toEqual([]);
  });

  test("counts events per agent", () => {
    appendLogEvent(vault, {
      timestamp: "2026-05-15T10:00:00Z",
      eventType: BRAIN_LOG_EVENT_KIND.feedback,
      body: { topic: "testing", signal: "positive", principle: "test" },
      agent: "claude-vps-agent",
    });
    appendLogEvent(vault, {
      timestamp: "2026-05-16T10:00:00Z",
      eventType: BRAIN_LOG_EVENT_KIND.applyEvidence,
      body: { preference: "[[pref-a]]", result: BRAIN_APPLY_RESULT.applied, artifact: "[[x.md]]" },
      agent: "claude-vps-agent",
    });
    appendLogEvent(vault, {
      timestamp: "2026-05-17T10:00:00Z",
      eventType: BRAIN_LOG_EVENT_KIND.feedback,
      body: { topic: "naming", signal: "negative", principle: "no abbreviations" },
      agent: "codex-agent",
    });

    const since = new Date("2026-05-13T00:00:00Z");
    const until = new Date("2026-05-20T00:00:00Z");
    const summary = computeAgentSummary(vault, since, until);

    expect(summary.length).toBe(2);
    const claude = summary.find((a) => a.agent === "claude-vps-agent")!;
    expect(claude.total_events).toBe(2);
    expect(claude.feedback_count).toBe(1);
    expect(claude.apply_evidence_count).toBe(1);
    expect(claude.note_count).toBe(0);

    const codex = summary.find((a) => a.agent === "codex-agent")!;
    expect(codex.total_events).toBe(1);
  });

  test("excludes events outside the window", () => {
    appendLogEvent(vault, {
      timestamp: "2026-05-01T10:00:00Z",
      eventType: BRAIN_LOG_EVENT_KIND.feedback,
      body: { topic: "old", signal: "positive", principle: "old" },
      agent: "claude-vps-agent",
    });

    const since = new Date("2026-05-13T00:00:00Z");
    const until = new Date("2026-05-20T00:00:00Z");
    const summary = computeAgentSummary(vault, since, until);
    expect(summary).toEqual([]);
  });

  test("only first agent gets confirmed_attributed for a shared pref", () => {
    writeFileSync(
      join(vault, "Brain", "preferences", "pref-a.md"),
      "---\nid: pref-a\ntopic: testing\nstatus: confirmed\nprinciple: test principle\nconfirmed_at: 2026-05-15T11:30:00Z\n---\n",
    );

    appendLogEvent(vault, {
      timestamp: "2026-05-15T10:00:00Z",
      eventType: BRAIN_LOG_EVENT_KIND.applyEvidence,
      body: { preference: "[[pref-a]]", result: BRAIN_APPLY_RESULT.applied, artifact: "[[x.md]]" },
      agent: "agent-a",
    });
    appendLogEvent(vault, {
      timestamp: "2026-05-15T11:00:00Z",
      eventType: BRAIN_LOG_EVENT_KIND.applyEvidence,
      body: { preference: "[[pref-a]]", result: BRAIN_APPLY_RESULT.applied, artifact: "[[y.md]]" },
      agent: "agent-b",
    });
    appendLogEvent(vault, {
      timestamp: "2026-05-15T12:00:00Z",
      eventType: BRAIN_LOG_EVENT_KIND.feedback,
      body: {
        topic: "testing",
        signal: "positive",
        principle: "test principle",
        preference: "[[pref-a]]",
        result: "confirmed",
      },
      agent: "agent-b",
    });

    const since = new Date("2026-05-13T00:00:00Z");
    const until = new Date("2026-05-20T00:00:00Z");
    const summary = computeAgentSummary(vault, since, until);

    const agentA = summary.find((a) => a.agent === "agent-a")!;
    const agentB = summary.find((a) => a.agent === "agent-b")!;

    expect(agentA.confirmed_attributed).toBe(1);
    expect(agentB.confirmed_attributed).toBe(0);
  });
});
