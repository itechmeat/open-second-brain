import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { moveToRetired, writePreference } from "../../src/core/brain/preference.ts";
import { preferencePath } from "../../src/core/brain/paths.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";
import { buildIntentReview } from "../../src/core/brain/intent-review.ts";
import { BRAIN_RETIRED_REASON } from "../../src/core/brain/types.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-intent-review-"));
  mkdirSync(vault, { recursive: true });
  bootstrapBrain(vault, {});
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function signal(topic: string, sign: "positive" | "negative", index: number): void {
  writeSignal(vault, {
    topic,
    signal: sign,
    agent: index % 2 === 0 ? "claude" : "codex",
    principle: `${topic} ${sign} principle`,
    created_at: `2026-05-2${index}T10:00:00Z`,
    date: `2026-05-2${index}`,
    slug: `${topic}-${index}`,
  });
}

describe("buildIntentReview", () => {
  test("classifies ready, weak, and conflicted signal clusters", () => {
    signal("ready-topic", "positive", 1);
    signal("ready-topic", "positive", 2);
    signal("ready-topic", "positive", 3);
    signal("weak-topic", "negative", 1);
    signal("conflicted-topic", "positive", 1);
    signal("conflicted-topic", "positive", 2);
    signal("conflicted-topic", "negative", 3);
    signal("conflicted-topic", "negative", 4);

    const report = buildIntentReview(vault, {
      now: new Date("2026-05-28T00:00:00Z"),
    });

    expect(report.schema_version).toBe(1);
    expect(report.reviews.map((review) => review.topic)).toEqual([
      "conflicted-topic",
      "ready-topic",
      "weak-topic",
    ]);
    expect(report.reviews.find((review) => review.topic === "ready-topic")?.decision).toBe(
      "ready_for_main_review",
    );
    expect(report.reviews.find((review) => review.topic === "weak-topic")?.decision).toBe(
      "needs_more_evidence",
    );
    expect(report.reviews.find((review) => review.topic === "conflicted-topic")?.decision).toBe(
      "blocked_conflicted",
    );
  });

  test("excludes future signals and surfaces user-rejected retired suppressors", () => {
    writePreference(vault, {
      slug: "rejected-topic",
      topic: "rejected-topic",
      principle: "do not regrow rejected rules",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-08T00:00:00Z",
      confirmed_at: "2026-05-08T00:00:00Z",
      status: "confirmed",
      evidenced_by: [],
      applied_count: 1,
      violated_count: 0,
      last_evidence_at: "2026-05-08T00:00:00Z",
    });
    moveToRetired(
      vault,
      preferencePath(vault, "rejected-topic"),
      BRAIN_RETIRED_REASON.userRejected,
      {
        now: new Date("2026-05-20T00:00:00Z"),
        retired_by: "test",
        evidenceApplied: [],
        evidenceViolated: [],
        user_rejected_reason: "operator rejected the rule",
      },
    );
    signal("future-topic", "positive", 9);
    signal("rejected-topic", "positive", 1);

    const report = buildIntentReview(vault, {
      now: new Date("2026-05-28T00:00:00Z"),
    });

    expect(report.reviews.map((review) => review.topic)).toEqual(["rejected-topic"]);
    expect(report.reviews[0]).toMatchObject({
      decision: "suppressed_by_rejected_retired",
      signal_count: 1,
      risk_band: "medium",
    });
  });
});
