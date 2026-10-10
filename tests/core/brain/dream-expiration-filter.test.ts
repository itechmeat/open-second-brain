/**
 * Expiration (C5) on the consolidation path (M10).
 *
 * The ambient TTL stamps `expiration_date = created + N` on extracted
 * signals; the query read path drops a signal past that date from recall
 * (`filterExpired`, reached only through `queryByTopic`). The dream pass
 * read the same files with no such filter, so a transient fact whose TTL
 * lapsed inside the contradiction window was still clustered, still
 * counted toward the candidate threshold, and finally consolidated into a
 * preference that carries no expiration of its own - the one transition
 * the TTL exists to prevent.
 *
 * Both topic readers the pass owns are exercised through their public
 * surfaces: `dream()` for the promotion plan (`new_unconfirmed`) plus the
 * run summary's intent reviews (the per-topic readiness report the pass
 * carries), and `buildIntentReview` for the same report read on its own.
 * A lapsed signal must name neither.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dream } from "../../../src/core/brain/dream.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { buildIntentReview } from "../../../src/core/brain/intent-review.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";

const NOW = new Date("2026-06-05T12:00:00Z");
const SIGNAL_DAY = "2026-06-01";
const SIGNAL_STAMP = `${SIGNAL_DAY}T10:00:00Z`;
/** Two days after the signals were written: lapsed by NOW. */
const LAPSED = "2026-06-03T10:00:00Z";
/** A month out: still live at NOW, and inside the contradiction window. */
const LIVE = "2026-07-05T10:00:00Z";

const LAPSED_TOPIC = "lapsed ambient fact";
const LIVE_TOPIC = "live ambient fact";
const MIXED_TOPIC = "mixed ambient fact";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-dream-expiry-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function newVault(name: string): string {
  const vault = join(tmp, name);
  const configPath = join(tmp, `${name}.yaml`);
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  return vault;
}

function seed(vault: string, topic: string, suffix: string, expiration?: string): void {
  writeSignal(vault, {
    topic,
    signal: "positive",
    agent: "claude",
    principle: "Ship the fact the TTL governs.",
    created_at: SIGNAL_STAMP,
    date: SIGNAL_DAY,
    slug: `${topic}-${suffix}`,
    ...(expiration ? { expiration_date: expiration } : {}),
  });
}

function planOf(vault: string) {
  return dream(vault, { now: NOW, dryRun: true, agentName: "claude" });
}

describe("dream consolidation honours signal expiration", () => {
  test("a fully lapsed cluster promotes nothing and names no dream topic", () => {
    const vault = newVault("lapsed");
    for (const suffix of ["a", "b", "c"]) seed(vault, LAPSED_TOPIC, suffix, LAPSED);

    const summary = planOf(vault);

    expect(summary.new_unconfirmed).toEqual([]);
    expect(summary.intent_reviews.map((r) => r.topic)).toEqual([]);
  });

  test("the same cluster inside its TTL still promotes and reads ready", () => {
    const vault = newVault("live");
    for (const suffix of ["a", "b", "c"]) seed(vault, LIVE_TOPIC, suffix, LIVE);

    const summary = planOf(vault);

    expect(summary.new_unconfirmed).toEqual([`pref-${LIVE_TOPIC}`]);
    const review = summary.intent_reviews.find((r) => r.topic === LIVE_TOPIC);
    expect(review?.decision).toBe("ready_for_main_review");
    expect(review?.signal_count).toBe(3);
  });

  test("a lapsed member of a mixed cluster stops counting toward the topic", () => {
    const vault = newVault("mixed");
    for (const suffix of ["a", "b", "c"]) seed(vault, MIXED_TOPIC, suffix, LAPSED);
    seed(vault, MIXED_TOPIC, "d", LIVE);

    const summary = planOf(vault);

    // One live signal below the threshold of three: no candidate, and the
    // readiness report counts only the signal the vault still recalls.
    expect(summary.new_unconfirmed).toEqual([]);
    const review = summary.intent_reviews.find((r) => r.topic === MIXED_TOPIC);
    expect(review?.signal_count).toBe(1);
    expect(review?.decision).toBe("needs_more_evidence");
  });

  test("buildIntentReview on its own drops a lapsed signal too", () => {
    const vault = newVault("review");
    for (const suffix of ["a", "b", "c"]) seed(vault, LAPSED_TOPIC, suffix, LAPSED);
    for (const suffix of ["a", "b", "c"]) seed(vault, LIVE_TOPIC, suffix, LIVE);

    const report = buildIntentReview(vault, { now: NOW });

    expect(report.reviews.map((r) => r.topic)).toEqual([LIVE_TOPIC]);
  });
});
