/**
 * Morning brief / day-close summary (Brain lifecycle suite, Feature 4).
 *
 * A read-only, budgeted session-start summary: top confirmed
 * preferences (confidence then recency), open questions raised by the
 * recent reconcile phase, and recent narrative notes. Deterministic on
 * an injected clock; character-bounded via the shared recall budget.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildMorningBrief } from "../../../src/core/brain/morning-brief.ts";
import { appendLogEvent } from "../../../src/core/brain/log.ts";
import { writePreference } from "../../../src/core/brain/preference.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";

let vault: string;
let configHome: string;
let configPath: string;
const now = new Date("2026-05-29T12:00:00Z");

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-morning-brief-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-morning-brief-cfg-"));
  configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function confirmedPref(slug: string, confidence: number): void {
  writePreference(vault, {
    slug,
    topic: slug,
    principle: `Principle ${slug}`,
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-08T00:00:00Z",
    status: "confirmed",
    confirmed_at: "2026-05-02T00:00:00Z",
    evidenced_by: [`[[sig-2026-05-01-${slug}]]`],
    confidence_value: confidence,
  });
}

describe("buildMorningBrief", () => {
  test("returns an empty brief for a fresh vault", () => {
    const brief = buildMorningBrief(vault, { now, topK: 5 });
    expect(brief.preferences).toHaveLength(0);
    expect(brief.openQuestions).toHaveLength(0);
    expect(brief.text).toBe("");
  });

  test("ranks confirmed preferences by confidence (desc)", () => {
    confirmedPref("low", 0.2);
    confirmedPref("high", 0.9);
    const brief = buildMorningBrief(vault, { now, topK: 5 });
    expect(brief.preferences.map((p) => p.id)).toEqual(["pref-high", "pref-low"]);
    expect(brief.text).toContain("Principle high");
  });

  test("surfaces recent reconcile open questions but not auto-resolutions", () => {
    appendLogEvent(vault, {
      timestamp: "2026-05-28T09:00:00Z",
      eventType: "reconcile",
      body: { topic: "commit-style", domain: "claims", reason: "claims-needs-operator" },
    });
    appendLogEvent(vault, {
      timestamp: "2026-05-28T09:01:00Z",
      eventType: "reconcile",
      body: {
        topic: "freshness-one",
        domain: "source-freshness",
        resolution: "auto-resolved",
        winner_sign: "negative",
      },
    });
    const brief = buildMorningBrief(vault, { now, topK: 5, lookbackDays: 7 });
    expect(brief.openQuestions.map((q) => q.topic)).toEqual(["commit-style"]);
    expect(brief.text).toContain("commit-style");
  });

  test("includes recent notes within the lookback window", () => {
    appendLogEvent(vault, {
      timestamp: "2026-05-28T08:00:00Z",
      eventType: "note",
      body: { text: "Shipped the lifecycle suite", agent: "claude" },
    });
    const brief = buildMorningBrief(vault, { now, topK: 5, lookbackDays: 7 });
    expect(brief.recentNotes.some((n) => n.includes("lifecycle suite"))).toBe(true);
  });

  test("honours the total character budget", () => {
    confirmedPref("a", 0.9);
    confirmedPref("b", 0.8);
    const tiny = buildMorningBrief(vault, { now, topK: 5, maxTotalChars: 12 });
    expect(tiny.totalChars).toBeLessThanOrEqual(12);
  });

  test("is deterministic on the injected clock", () => {
    confirmedPref("a", 0.9);
    const a = buildMorningBrief(vault, { now, topK: 5 });
    const b = buildMorningBrief(vault, { now, topK: 5 });
    expect(a.text).toBe(b.text);
  });
});
