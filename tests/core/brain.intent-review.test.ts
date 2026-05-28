import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";
import { buildIntentReview } from "../../src/core/brain/intent-review.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-intent-review-"));
  mkdirSync(vault, { recursive: true });
  bootstrapBrain(vault, {});
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function signal(
  topic: string,
  sign: "positive" | "negative",
  index: number,
): void {
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
    expect(
      report.reviews.find((review) => review.topic === "ready-topic")?.decision,
    ).toBe("ready_for_main_review");
    expect(
      report.reviews.find((review) => review.topic === "weak-topic")?.decision,
    ).toBe("needs_more_evidence");
    expect(
      report.reviews.find((review) => review.topic === "conflicted-topic")
        ?.decision,
    ).toBe("blocked_conflicted");
  });
});
