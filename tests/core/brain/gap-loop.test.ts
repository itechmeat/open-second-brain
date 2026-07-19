import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emitRecallTelemetry } from "../../../src/core/brain/recall-telemetry.ts";
import {
  autoCloseRecalledGaps,
  detectRecurringGaps,
  gapTaskKey,
  GAP_TASK_KIND,
  GAP_TASK_STATUS_CLOSED,
  GAP_TASK_STATUS_OPEN,
  listGapTasks,
  promoteGapsToTasks,
  renderGapAgenda,
} from "../../../src/core/brain/gaps/gap-loop.ts";
import type { RecallRetriever, RecallResultSet } from "../../../src/core/brain/recall-inject.ts";
import { parseFrontmatterText } from "../../../src/core/vault.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-gap-loop-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function seedGap(topic: string, times: number): void {
  for (let i = 0; i < times; i++) {
    emitRecallTelemetry(vault, {
      host: "test",
      mode: "search",
      status: "empty",
      durationMs: 0,
      resultCount: 0,
      gaps: [topic],
      createdAt: `2026-05-2${i}T09:00:00.000Z`,
    });
  }
}

const NOW = new Date("2026-06-01T12:00:00.000Z");

function retrieverWithScore(score: number): RecallRetriever {
  return async () =>
    ({
      candidates: [
        { path: "Brain/x.md", title: "X", score, searchType: "hybrid", startLine: 1, endLine: 2 },
      ],
      total: 1,
    }) satisfies RecallResultSet;
}

describe("gap loop (A3 / t_67d38036)", () => {
  test("detects only gaps at or above the recurrence threshold, most-frequent first", () => {
    seedGap("alpha topic", 3);
    seedGap("beta topic", 2);
    seedGap("gamma topic", 1);
    const recurring = detectRecurringGaps(vault, { threshold: 2 });
    expect(recurring.map((g) => g.topic)).toEqual(["alpha topic", "beta topic"]);
    expect(recurring[0]?.occurrences).toBe(3);
  });

  test("promotes each recurring gap to one durable gap-task note under the Brain area", () => {
    seedGap("alpha topic", 3);
    const result = promoteGapsToTasks(vault, { threshold: 2, now: NOW });
    expect(result.created).toHaveLength(1);
    const key = gapTaskKey("alpha topic");
    const path = join(vault, "Brain", "gap-tasks", `${key}.md`);
    expect(existsSync(path)).toBe(true);
    const [fm] = parseFrontmatterText(readFileSync(path, "utf8"));
    expect(fm["kind"]).toBe(GAP_TASK_KIND);
    expect(fm["status"]).toBe(GAP_TASK_STATUS_OPEN);
    expect(fm["gap_topic"]).toBe("alpha topic");
    // Plain note file: no kanban board fields whatsoever.
    expect(fm["board"]).toBeUndefined();
    expect(fm["column"]).toBeUndefined();
  });

  test("re-promotion dedupes on the stable gap key and never collides", () => {
    seedGap("alpha topic", 3);
    const first = promoteGapsToTasks(vault, { threshold: 2, now: NOW });
    const second = promoteGapsToTasks(vault, { threshold: 2, now: NOW });
    expect(first.created).toHaveLength(1);
    expect(second.created).toHaveLength(0);
    expect(second.skipped).toEqual([gapTaskKey("alpha topic")]);
  });

  test("renders open gap tasks as a compact agenda through the shared helper", () => {
    seedGap("alpha topic", 3);
    promoteGapsToTasks(vault, { threshold: 2, now: NOW });
    const agenda = renderGapAgenda(vault, NOW);
    expect(agenda).toContain("alpha topic");
    // The shared activity helper stamps the fixed "open" marker for questions.
    expect(agenda).toContain("[open]");
  });

  test("agenda is empty when there are no open gap tasks", () => {
    expect(renderGapAgenda(vault, NOW)).toBe("");
  });

  test("auto-closes a gap task once its topic is recalled with sufficient confidence", async () => {
    seedGap("alpha topic", 3);
    promoteGapsToTasks(vault, { threshold: 2, now: NOW });
    const result = await autoCloseRecalledGaps(vault, retrieverWithScore(0.92), {
      confidenceFloor: 0.5,
      now: NOW,
    });
    expect(result.closed).toEqual([gapTaskKey("alpha topic")]);
    const open = listGapTasks(vault, { status: GAP_TASK_STATUS_OPEN });
    expect(open).toHaveLength(0);
    const closed = listGapTasks(vault, { status: GAP_TASK_STATUS_CLOSED });
    expect(closed).toHaveLength(1);
    const [fm] = parseFrontmatterText(readFileSync(closed[0]!.path, "utf8"));
    expect(fm["status"]).toBe(GAP_TASK_STATUS_CLOSED);
    expect(typeof fm["closed_at"]).toBe("string");
  });

  test("never self-closes: a hit on the gap-task note itself does not count as coverage", async () => {
    seedGap("alpha topic", 3);
    promoteGapsToTasks(vault, { threshold: 2, now: NOW });
    // The only confident hit is the gap-task note itself; it must be ignored.
    const selfMatch: RecallRetriever = async () =>
      ({
        candidates: [
          {
            path: "Brain/gap-tasks/gap-abc.md",
            title: "gap",
            score: 0.99,
            searchType: "hybrid",
            startLine: 1,
            endLine: 2,
          },
        ],
        total: 1,
      }) satisfies RecallResultSet;
    const result = await autoCloseRecalledGaps(vault, selfMatch, {
      confidenceFloor: 0.5,
      now: NOW,
    });
    expect(result.closed).toHaveLength(0);
    expect(listGapTasks(vault, { status: GAP_TASK_STATUS_OPEN })).toHaveLength(1);
  });

  test("keeps a gap task open when recall stays below the confidence floor", async () => {
    seedGap("alpha topic", 3);
    promoteGapsToTasks(vault, { threshold: 2, now: NOW });
    const result = await autoCloseRecalledGaps(vault, retrieverWithScore(0.2), {
      confidenceFloor: 0.5,
      now: NOW,
    });
    expect(result.closed).toHaveLength(0);
    expect(listGapTasks(vault, { status: GAP_TASK_STATUS_OPEN })).toHaveLength(1);
  });
});
