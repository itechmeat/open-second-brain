/**
 * Agent-source query core tests.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { queryAgentSources } from "../../src/core/brain/agent-source/query.ts";
import { appendLogEvent } from "../../src/core/brain/log.ts";
import { brainDirs } from "../../src/core/brain/paths.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-agent-query-"));
  const dirs = brainDirs(tmp);
  for (const d of [
    dirs.brain,
    dirs.inbox,
    dirs.processed,
    dirs.preferences,
    dirs.retired,
    dirs.log,
  ]) {
    mkdirSync(d, { recursive: true });
  }
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function seedVault(): void {
  const sig = writeSignal(tmp, {
    topic: "agent-query",
    signal: "positive",
    agent: "claude",
    principle: "Keep agent provenance queryable.",
    created_at: "2026-05-20T10:00:00Z",
    date: "2026-05-20",
    slug: "agent-query",
    scope: "brain",
  });
  writeSignal(tmp, {
    topic: "agent-diff",
    signal: "negative",
    agent: "codex",
    principle: "Do not hardcode agent pairs.",
    created_at: "2026-05-21T10:00:00Z",
    date: "2026-05-21",
    slug: "agent-diff",
    scope: "brain",
  });
  writePreference(tmp, {
    slug: "agent-query",
    topic: "agent-query",
    principle: "Keep agent provenance queryable.",
    created_at: "2026-05-22T10:00:00Z",
    unconfirmed_until: "2026-06-05T10:00:00Z",
    status: "unconfirmed",
    evidenced_by: [`[[${sig.id}]]`],
    confirmed_at: null,
    scope: "brain",
  });
  appendLogEvent(tmp, {
    timestamp: "2026-05-23T10:00:00Z",
    eventType: "apply-evidence",
    body: {
      preference: "[[pref-agent-query]]",
      artifact: "[[docs/brainstorm/cross-agent-query-foundation/design.md]]",
      result: "applied",
      agent: "hermes",
    },
  });
}

describe("queryAgentSources", () => {
  test("returns one agent's contributions with deterministic summary", () => {
    seedVault();

    const result = queryAgentSources(tmp, { agents: ["claude"] });

    expect(result.filters.agents).toEqual(["claude"]);
    expect(result.unknown_agents).toEqual([]);
    expect(result.total_matched).toBe(2);
    expect(result.contributions.map((c) => `${c.kind}:${c.id}`)).toEqual([
      "signal:sig-2026-05-20-agent-query",
      "preference:pref-agent-query",
    ]);
    expect(result.summary).toBe("claude: 2 contributions across 1 topic (preference, signal).");
  });

  test("filters by kind, topic, free-text query, and limit", () => {
    seedVault();

    const result = queryAgentSources(tmp, {
      agents: ["codex", "claude"],
      kind: "signal",
      topic: "agent-diff",
      query: "hardcode",
      limit: 1,
    });

    expect(result.total_matched).toBe(1);
    expect(result.returned).toBe(1);
    expect(result.contributions[0]?.id).toBe("sig-2026-05-21-agent-diff");
    expect(result.contributions[0]?.agents).toEqual(["codex"]);
  });

  test("reports unknown agents without throwing", () => {
    seedVault();

    const result = queryAgentSources(tmp, { agents: ["copilot"] });

    expect(result.filters.agents).toEqual(["copilot"]);
    expect(result.unknown_agents).toEqual(["copilot"]);
    expect(result.total_matched).toBe(0);
    expect(result.contributions).toEqual([]);
    expect(result.summary).toBe("No contributions matched the selected filters.");
  });
});
