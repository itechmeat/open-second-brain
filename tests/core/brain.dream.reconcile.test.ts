/**
 * Reconcile-phase domain classification in the dream pass (Brain
 * lifecycle suite, Feature 3). The flat contradiction-topic list gains
 * a structured `open_questions` view: each contradiction is classified
 * by domain, source-freshness is auto-resolved (recorded, never a
 * sub-threshold mutation), and the rest surface as operator-facing open
 * questions. The legacy `contradictions` field stays a derived view.
 * No forced merge ever happens.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dream } from "../../src/core/brain/dream.ts";
import { readLogDay } from "../../src/core/brain/log-jsonl.ts";
import { isoDate } from "../../src/core/brain/time.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";
import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";

let vault: string;
let configHome: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-dream-reconcile-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-dream-reconcile-cfg-"));
  configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function sig(opts: {
  topic: string;
  slug: string;
  signal: "positive" | "negative";
  date: string;
  scope?: string;
}): void {
  writeSignal(vault, {
    topic: opts.topic,
    signal: opts.signal,
    agent: "claude",
    principle: `Rule for ${opts.topic}`,
    created_at: `${opts.date}T10:00:00Z`,
    date: opts.date,
    slug: opts.slug,
    ...(opts.scope ? { scope: opts.scope } : {}),
  });
}

const now = new Date("2026-05-29T12:00:00Z");

describe("dream reconcile phase", () => {
  test("a same-window contradiction surfaces as a claims open question", () => {
    // topic A promotes (3 positives) so the run is changed; topic B is a
    // 1v1 contradiction in the same window -> claims open question.
    sig({ topic: "topic-a", slug: "a1", signal: "positive", date: "2026-05-20" });
    sig({ topic: "topic-a", slug: "a2", signal: "positive", date: "2026-05-21" });
    sig({ topic: "topic-a", slug: "a3", signal: "positive", date: "2026-05-22" });
    // Same-instant pos + neg -> no recency separation -> claims domain.
    sig({ topic: "topic-b", slug: "b1", signal: "positive", date: "2026-05-25" });
    sig({ topic: "topic-b", slug: "b2", signal: "negative", date: "2026-05-25" });

    const summary = dream(vault, { now });
    expect(summary.changed).toBe(true);
    const q = summary.open_questions.find((x) => x.topic === "topic-b");
    expect(q).toBeDefined();
    expect(q!.domain).toBe("claims");
    // Legacy derived view still lists the topic.
    expect(summary.contradictions).toContain("topic-b");

    const reconcileMetrics = summary.phases.find((p) => p.phase === "reconcile")?.metrics;
    expect(reconcileMetrics?.["open_questions"]).toBe(1);

    // A reconcile log event was emitted for the open question.
    const events = readLogDay(vault, isoDate(now)).entries;
    expect(events.some((e) => e.eventType === "reconcile")).toBe(true);
  });

  test("a wide recency gap is auto-resolved, not surfaced as an open question", () => {
    sig({ topic: "topic-a", slug: "a1", signal: "positive", date: "2026-05-20" });
    sig({ topic: "topic-a", slug: "a2", signal: "positive", date: "2026-05-21" });
    sig({ topic: "topic-a", slug: "a3", signal: "positive", date: "2026-05-22" });
    // topic-c: both within the 14d contradiction window, but the gap
    // (11d) exceeds half the window -> source-freshness auto-resolved.
    sig({ topic: "topic-c", slug: "c1", signal: "positive", date: "2026-05-16" });
    sig({ topic: "topic-c", slug: "c2", signal: "negative", date: "2026-05-27" });

    const summary = dream(vault, { now });
    const open = summary.open_questions.find((x) => x.topic === "topic-c");
    expect(open).toBeUndefined(); // auto-resolved, not an open question
  });

  test("a pure-contradiction no-op run still reports open_questions in-memory but writes no log", () => {
    sig({ topic: "topic-b", slug: "b1", signal: "positive", date: "2026-05-25" });
    sig({ topic: "topic-b", slug: "b2", signal: "negative", date: "2026-05-26" });

    const summary = dream(vault, { now });
    expect(summary.changed).toBe(false);
    expect(summary.open_questions.some((x) => x.topic === "topic-b")).toBe(true);
    // No reconcile event persisted on a no-op run (byte-identical hold).
    const events = readLogDay(vault, isoDate(now)).entries;
    expect(events.some((e) => e.eventType === "reconcile")).toBe(false);
  });
});
