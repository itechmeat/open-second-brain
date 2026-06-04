/**
 * Freshness-trend classification (Time-Aware Recall & Activation
 * Suite, t_ee09a6ce): pure classifier over evidence-event time
 * distributions, surfaced on the belief-evolution envelope and stamped
 * into preference frontmatter by the dream refresh pass.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendApplyEvidence } from "../../../src/core/brain/apply-evidence.ts";
import { dream } from "../../../src/core/brain/dream.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { preferencePath } from "../../../src/core/brain/paths.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import { buildBeliefEvolution } from "../../../src/core/brain/temporal/belief-evolution.ts";
import { buildTimelineIndex } from "../../../src/core/brain/temporal/build-index.ts";
import {
  classifyFreshnessTrend,
  type FreshnessTrend,
} from "../../../src/core/brain/temporal/freshness-trend.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";

const NOW = Date.UTC(2026, 5, 1, 12, 0, 0); // 2026-06-01T12:00:00Z
const DAY = 24 * 60 * 60 * 1000;

function iso(offsetDays: number): string {
  return new Date(NOW - offsetDays * DAY).toISOString();
}

function applied(atDaysAgo: number): { at: string; result: "applied" } {
  return { at: iso(atDaysAgo), result: "applied" };
}

function violated(atDaysAgo: number): { at: string; result: "violated" } {
  return { at: iso(atDaysAgo), result: "violated" };
}

function evidenceLine(ts: string, result: string): string {
  return JSON.stringify({
    ts,
    kind: "apply-evidence",
    payload: { preference: "pref-foo", result, artifact: "[[x]]" },
  });
}

describe("classifyFreshnessTrend (pure)", () => {
  test("a young preference with no prior evidence is new", () => {
    const r = classifyFreshnessTrend({ createdAt: iso(3), events: [], nowMs: NOW });
    expect(r.trend).toBe("new" as FreshnessTrend);
  });

  test("no evidence on an old preference is stale", () => {
    const r = classifyFreshnessTrend({ createdAt: iso(200), events: [], nowMs: NOW });
    expect(r.trend).toBe("stale");
  });

  test("last evidence older than the stale window is stale", () => {
    const r = classifyFreshnessTrend({
      createdAt: iso(200),
      events: [applied(90), applied(75)],
      nowMs: NOW,
    });
    expect(r.trend).toBe("stale");
  });

  test("more recent applies than prior-window applies is strengthening", () => {
    const r = classifyFreshnessTrend({
      createdAt: iso(200),
      events: [applied(45), applied(20), applied(10), applied(2)],
      nowMs: NOW,
    });
    expect(r.trend).toBe("strengthening");
    expect(r.recentApplied).toBe(3);
    expect(r.priorApplied).toBe(1);
  });

  test("rising violations or fading applies is weakening", () => {
    const violations = classifyFreshnessTrend({
      createdAt: iso(200),
      events: [applied(45), applied(40), applied(10), violated(5), violated(2)],
      nowMs: NOW,
    });
    expect(violations.trend).toBe("weakening");
    const fading = classifyFreshnessTrend({
      createdAt: iso(200),
      events: [applied(50), applied(45), applied(40), applied(20)],
      nowMs: NOW,
    });
    expect(fading.trend).toBe("weakening");
  });

  test("a steady cadence is stable", () => {
    const r = classifyFreshnessTrend({
      createdAt: iso(200),
      events: [applied(45), applied(35), applied(20), applied(10)],
      nowMs: NOW,
    });
    expect(r.trend).toBe("stable");
  });

  test("deterministic against the injected clock", () => {
    const events = [applied(45), applied(10)];
    const a = classifyFreshnessTrend({ createdAt: iso(200), events, nowMs: NOW });
    const b = classifyFreshnessTrend({ createdAt: iso(200), events, nowMs: NOW });
    expect(a).toEqual(b);
  });
});

describe("belief-evolution envelope carries the trend", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "o2b-trend-evo-"));
    mkdirSync(join(vault, "Brain", "log"), { recursive: true });
    mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
    mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  test("freshnessTrend reflects the evidence distribution", () => {
    writeFileSync(
      join(vault, "Brain", "log", "2026-05-25.jsonl"),
      evidenceLine("2026-05-25T08:00:00Z", "applied") + "\n",
    );
    writeFileSync(
      join(vault, "Brain", "log", "2026-05-30.jsonl"),
      evidenceLine("2026-05-30T08:00:00Z", "applied") + "\n",
    );
    const idx = buildTimelineIndex(vault, {});
    const evo = buildBeliefEvolution(
      idx,
      vault,
      { prefId: "pref-foo" },
      {
        now: new Date(NOW),
      },
    );
    expect(evo.freshnessTrend).toBeDefined();
    expect(evo.freshnessTrend?.trend).toBe("strengthening");
  });
});

describe("dream refresh stamps freshness_trend", () => {
  let vault: string;
  let configHome: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "o2b-trend-dream-"));
    configHome = mkdtempSync(join(tmpdir(), "o2b-trend-cfg-"));
    atomicWriteFileSync(join(configHome, "config.yaml"), `vault: ${vault}\n`);
    bootstrapBrain(vault, { configPath: join(configHome, "config.yaml") });
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
    rmSync(configHome, { recursive: true, force: true });
  });

  test("a refreshed preference carries the computed trend in frontmatter", () => {
    const topic = "trend-stamp";
    for (let i = 0; i < 3; i++) {
      writeSignal(vault, {
        topic,
        signal: "positive",
        agent: "claude",
        principle: "Stamp freshness trends on refresh.",
        created_at: `2026-05-12T0${i + 1}:00:00Z`,
        date: "2026-05-12",
        slug: `seed-${i}`,
        scope: "coding",
      });
    }
    dream(vault, { now: new Date("2026-05-12T10:00:00Z") });
    appendApplyEvidence(
      vault,
      {
        pref_id: `pref-${topic}`,
        artifact: "[[src/lib/example.ts]]",
        result: "applied",
        agent: "claude",
      },
      { now: new Date("2026-05-20T10:00:00Z") },
    );
    dream(vault, { now: new Date("2026-05-21T10:00:00Z") });
    const raw = readFileSync(preferencePath(vault, topic), "utf8");
    expect(raw).toMatch(/freshness_trend: (new|strengthening|stable|weakening|stale)/);

    // No-op rerun stays a no-op: the trend is classified at PLAN time,
    // so the pre-flight render matches the stamped bytes and a rerun
    // with identical state reports changed=false (CodeRabbit PR #73).
    const rerun = dream(vault, { now: new Date("2026-05-21T10:00:00Z") });
    expect(rerun.changed).toBe(false);
    expect(readFileSync(preferencePath(vault, topic), "utf8")).toBe(raw);
  });
});
