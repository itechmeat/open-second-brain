/**
 * Agent-source diff core tests.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { diffAgentSources } from "../../src/core/brain/agent-source/diff.ts";
import { brainDirs } from "../../src/core/brain/paths.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-agent-diff-"));
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
  writeSignal(tmp, {
    topic: "shared-topic",
    signal: "positive",
    agent: "claude",
    principle: "Both agents know this topic.",
    created_at: "2026-05-20T10:00:00Z",
    date: "2026-05-20",
    slug: "shared-claude",
  });
  writeSignal(tmp, {
    topic: "shared-topic",
    signal: "positive",
    agent: "codex",
    principle: "Codex also knows this topic.",
    created_at: "2026-05-21T10:00:00Z",
    date: "2026-05-21",
    slug: "shared-codex",
  });
  writeSignal(tmp, {
    topic: "claude-only",
    signal: "positive",
    agent: "claude",
    principle: "Claude keeps operator prose concise.",
    created_at: "2026-05-22T10:00:00Z",
    date: "2026-05-22",
    slug: "claude-only",
  });
  writeSignal(tmp, {
    topic: "codex-only",
    signal: "negative",
    agent: "codex",
    principle: "Do not hardcode agent pairs.",
    created_at: "2026-05-23T10:00:00Z",
    date: "2026-05-23",
    slug: "codex-only",
  });
}

describe("diffAgentSources", () => {
  test("diff mode reports shared and unique topics per selected agent", () => {
    seedVault();

    const result = diffAgentSources(tmp, {
      mode: "diff",
      agents: ["claude", "codex"],
    });

    expect(result.diff_mode).toBe("diff");
    expect(result.shared_topics).toEqual(["shared-topic"]);
    expect(result.unique_topics).toEqual({
      claude: ["claude-only"],
      codex: ["codex-only"],
    });
    expect(result.summary).toContain("1 shared topic");
  });

  test("map mode builds a topic-to-agent matrix after search filtering", () => {
    seedVault();

    const result = diffAgentSources(tmp, {
      mode: "map",
      agents: ["claude", "codex"],
      query: "hardcode",
    });

    expect(result.topic_map).toEqual([
      { topic: "codex-only", agents: ["codex"], contribution_count: 1 },
    ]);
    expect(result.per_agent).toEqual([
      { agent: "claude", contribution_count: 0, topics: [], kinds: [] },
      {
        agent: "codex",
        contribution_count: 1,
        topics: ["codex-only"],
        kinds: ["signal"],
      },
    ]);
  });
});
