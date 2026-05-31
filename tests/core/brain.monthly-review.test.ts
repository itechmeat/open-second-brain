import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendLogEvent } from "../../src/core/brain/log.ts";
import { buildMonthlyReview } from "../../src/core/brain/monthly-review.ts";
import { brainDirs } from "../../src/core/brain/paths.ts";
import { BRAIN_APPLY_RESULT, BRAIN_LOG_EVENT_KIND } from "../../src/core/brain/types.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-monthly-review-"));
  mkdirSync(brainDirs(vault).log, { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("buildMonthlyReview", () => {
  test("aggregates month events, transitions, and contradictions", () => {
    appendLogEvent(vault, {
      timestamp: "2026-05-10T10:00:00Z",
      eventType: BRAIN_LOG_EVENT_KIND.dream,
      body: {
        confirmed: ["[[pref-use-tests|Use tests]]"],
        retired: ["[[ret-old-rule|Old rule]] (stale-no-evidence)"],
      },
    });
    appendLogEvent(vault, {
      timestamp: "2026-05-11T10:00:00Z",
      eventType: BRAIN_LOG_EVENT_KIND.applyEvidence,
      body: {
        preference: "[[pref-use-tests]]",
        artifact: "[[src/core/example.ts]]",
        result: BRAIN_APPLY_RESULT.violated,
      },
    });

    const report = buildMonthlyReview(vault, {
      month: "2026-05",
      now: new Date("2026-06-01T00:00:00Z"),
    });

    expect(report.month).toBe("2026-05");
    expect(report.window).toEqual({
      since: "2026-05-01T00:00:00Z",
      until: "2026-06-01T00:00:00Z",
    });
    expect(report.summary.events).toBe(2);
    expect(report.summary.status_transitions).toBe(2);
    expect(report.summary.retired).toBe(1);
    expect(report.summary.contradictions).toBe(1);
  });
});
