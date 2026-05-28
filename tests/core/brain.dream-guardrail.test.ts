/**
 * v0.10.16: dream pass invokes the self-approval guardrail before
 * creating a new unconfirmed preference. Default config preserves
 * pre-v0.10.16 behaviour (defaults are strictly looser than every
 * existing dream-pass gate, so the guardrail never blocks by
 * default); a tighter guardrail routes the cluster to `quarantined`
 * instead.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dream } from "../../src/core/brain/dream.ts";
import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { brainConfigPath } from "../../src/core/brain/paths.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";

let vault: string;

const ONE_DAY = 24 * 60 * 60 * 1000;

function writeBrainCfg(vault: string, body: string) {
  writeFileSync(brainConfigPath(vault), `schema_version: 1\n${body}`);
}

function seedPositiveSignals(
  vault: string,
  count: number,
  agent: string,
  topic = "test-topic",
  ageDays = 1,
): void {
  const baseDate = new Date(Date.now() - ageDays * ONE_DAY);
  for (let i = 0; i < count; i += 1) {
    const created = new Date(baseDate.getTime() - i * 1000);
    const date = created.toISOString().slice(0, 10);
    writeSignal(vault, {
      slug: `${topic}-${agent}-${i}`,
      date,
      created_at: created.toISOString(),
      topic,
      signal: "positive",
      agent,
      principle: "limit X to 10",
    });
  }
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-dream-guardrail-"));
  bootstrapBrain(vault);
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("dream + self-approval guardrail (default config)", () => {
  test("3 signals from 1 agent: promotes (default min_distinct_agents=1)", () => {
    seedPositiveSignals(vault, 3, "agent-a");
    const res = dream(vault);
    expect(res.new_unconfirmed).toEqual(["pref-test-topic"]);
    expect(res.quarantined).toEqual([]);
    expect(res.intent_reviews).toEqual([
      expect.objectContaining({
        topic: "test-topic",
        decision: "ready_for_main_review",
        signal_count: 3,
      }),
    ]);
  });

  test("2 signals from 1 agent: blocked by candidate_threshold, not by guardrail", () => {
    seedPositiveSignals(vault, 2, "agent-a");
    const res = dream(vault);
    expect(res.new_unconfirmed).toEqual([]);
    // candidate_threshold filtered before guardrail, so no quarantine
    // entry is recorded either.
    expect(res.quarantined).toEqual([]);
  });
});

describe("dream + self-approval guardrail (tighter config)", () => {
  test("3 signals from 1 agent: quarantined when min_distinct_agents=2", () => {
    writeBrainCfg(vault, `guardrails:\n  promotion_min_distinct_agents: 2\n`);
    seedPositiveSignals(vault, 3, "agent-a");
    const res = dream(vault);
    expect(res.new_unconfirmed).toEqual([]);
    expect(res.quarantined).toHaveLength(1);
    expect(res.quarantined[0]?.topic).toBe("test-topic");
    expect(res.quarantined[0]?.failed_gates).toContain("min_distinct_agents");
  });

  test("cluster from two agents passes min_distinct_agents=2", () => {
    writeBrainCfg(vault, `guardrails:\n  promotion_min_distinct_agents: 2\n`);
    seedPositiveSignals(vault, 2, "agent-a", "test-topic", 1);
    seedPositiveSignals(vault, 2, "agent-b", "test-topic", 1);
    const res = dream(vault);
    expect(res.new_unconfirmed).toEqual(["pref-test-topic"]);
    expect(res.quarantined).toEqual([]);
  });
});
