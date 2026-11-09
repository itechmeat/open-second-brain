import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeAgentSummary } from "../../../src/core/brain/digest-agent-summary.ts";
import { appendLogEvent } from "../../../src/core/brain/log.ts";
import { BRAIN_LOG_EVENT_KIND, BRAIN_APPLY_RESULT } from "../../../src/core/brain/types.ts";
import { preferencePath } from "../../../src/core/brain/paths.ts";
import { moveToRetired, writePreference } from "../../../src/core/brain/preference.ts";
import { makeStoreEnv } from "../store/fixtures/store-env.ts";
import { switchDevice } from "./store-only/fixtures.ts";

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

describe("computeAgentSummary on both machines", () => {
  /** A confirmed and a retired preference, each applied once by one agent. */
  function attributions(mode: "legacy" | "switched") {
    const env = makeStoreEnv(`osb-agent-summary-${mode}-`, { dualWrite: false });
    try {
      if (mode === "switched") switchDevice(env.storeRoot);
      const pref = (slug: string, extra: Record<string, unknown>) => ({
        slug,
        topic: slug,
        principle: `principle ${slug}`,
        created_at: "2026-05-01T00:00:00Z",
        unconfirmed_until: "2026-05-31T00:00:00Z",
        status: "confirmed" as const,
        evidenced_by: [] as string[],
        ...extra,
      });
      writePreference(env.vault, pref("kept", { confirmed_at: "2026-05-15T00:00:00Z" }), {
        authority: "agent",
      });
      writePreference(env.vault, pref("gone", { confirmed_at: "2026-04-01T00:00:00Z" }), {
        authority: "agent",
      });
      moveToRetired(env.vault, preferencePath(env.vault, "gone"), "stale-no-evidence", {
        now: new Date("2026-05-16T00:00:00Z"),
        retired_by: "[[Brain/log/2026-05-16]]",
        authority: "agent",
      });
      for (const id of ["pref-kept", "pref-gone"]) {
        appendLogEvent(env.vault, {
          timestamp: "2026-05-14T10:00:00Z",
          eventType: BRAIN_LOG_EVENT_KIND.applyEvidence,
          body: { preference: `[[${id}]]`, result: BRAIN_APPLY_RESULT.applied, artifact: "[[x]]" },
          agent: "claude",
        });
      }
      return computeAgentSummary(
        env.vault,
        new Date("2026-05-13T00:00:00Z"),
        new Date("2026-05-20T00:00:00Z"),
      ).map((a) => [a.agent, a.confirmed_attributed, a.retired_attributed]);
    } finally {
      env.cleanup();
    }
  }

  test("a switched machine attributes confirmations and retirements as an unswitched one", () => {
    const legacy = attributions("legacy");
    expect(legacy).toEqual([["claude", 1, 1]]);
    expect(attributions("switched")).toEqual(legacy);
  });
});
