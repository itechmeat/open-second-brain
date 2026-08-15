import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emitRecallTelemetry, RECALL_CHANNEL } from "../../../src/core/brain/recall-telemetry.ts";
import {
  autoCloseRecalledGaps,
  detectRecurringGaps,
  gapTaskKey,
  GAP_SOURCE_ADEQUACY,
  GAP_SOURCE_TELEMETRY,
  GAP_SOURCES,
  GAP_TASK_CLOSED_RETENTION_MS,
  GAP_TASK_KIND,
  GAP_TASK_STATUS_CLOSED,
  GAP_TASK_STATUS_OPEN,
  GAP_TASKS_MAX_NOTES,
  listGapTasks,
  promoteGapsToTasks,
  renderGapAgenda,
} from "../../../src/core/brain/gaps/gap-loop.ts";
import { brainGapTasksDir } from "../../../src/core/brain/paths.ts";
import type { RecallRetriever, RecallResultSet } from "../../../src/core/brain/recall-inject.ts";
import { parseFrontmatterText, writeFrontmatterAtomic } from "../../../src/core/vault.ts";

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
      channel: RECALL_CHANNEL.cli,
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

// ----- the directory the loop writes into is bounded ------------------------

describe("gap-task retention", () => {
  /** Write one gap-task note directly, bypassing the mint budget. */
  function writeTask(key: string, status: string, closedAt?: string): void {
    writeFrontmatterAtomic(
      join(brainGapTasksDir(vault), `${key}.md`),
      {
        kind: GAP_TASK_KIND,
        gap_key: key,
        gap_topic: key,
        gap_source: GAP_SOURCE_TELEMETRY,
        status,
        occurrences: "3",
        created_at: "2026-01-01T00:00:00.000Z",
        ...(closedAt !== undefined ? { closed_at: closedAt, closed_reason: "recalled" } : {}),
      },
      "body",
      { vaultForRelativePath: vault, overwrite: true },
    );
  }

  test("a closed task past the retention window is removed, and the removal is reported", () => {
    const stale = new Date(NOW.getTime() - GAP_TASK_CLOSED_RETENTION_MS - 1).toISOString();
    writeTask("gap-stale", GAP_TASK_STATUS_CLOSED, stale);
    writeTask("gap-recent", GAP_TASK_STATUS_CLOSED, NOW.toISOString());
    writeTask("gap-open", GAP_TASK_STATUS_OPEN);

    const result = promoteGapsToTasks(vault, { threshold: 2, now: NOW });
    expect(result.pruned).toEqual(["gap-stale"]);
    expect(
      listGapTasks(vault)
        .map((t) => t.key)
        .toSorted(),
    ).toEqual(["gap-open", "gap-recent"]);
  });

  test("an open task is never pruned, however old it is", () => {
    writeTask("gap-open", GAP_TASK_STATUS_OPEN);
    const result = promoteGapsToTasks(vault, {
      threshold: 2,
      now: new Date(NOW.getTime() + GAP_TASK_CLOSED_RETENTION_MS * 10),
    });
    expect(result.pruned).toEqual([]);
    expect(listGapTasks(vault)).toHaveLength(1);
  });

  test("at the cap, minting is REFUSED and named - never silently skipped", () => {
    for (let i = 0; i < GAP_TASKS_MAX_NOTES; i++)
      writeTask(`gap-filler-${i}`, GAP_TASK_STATUS_OPEN);
    seedGap("alpha topic", 3);
    const result = promoteGapsToTasks(vault, { threshold: 2, now: NOW });
    expect(result.created).toEqual([]);
    expect(result.capped).toBe(1);
    expect(listGapTasks(vault)).toHaveLength(GAP_TASKS_MAX_NOTES);
  });

  test("at the cap, a topic that already has a note is skipped, not counted as refused", () => {
    writeTask(gapTaskKey("alpha topic"), GAP_TASK_STATUS_OPEN);
    for (let i = 0; i < GAP_TASKS_MAX_NOTES - 1; i++) {
      writeTask(`gap-filler-${i}`, GAP_TASK_STATUS_OPEN);
    }
    seedGap("alpha topic", 3);
    const result = promoteGapsToTasks(vault, { threshold: 2, now: NOW });
    expect(result.capped).toBe(0);
    expect(result.skipped).toEqual([gapTaskKey("alpha topic")]);
  });

  test("room freed by pruning is usable in the same run", () => {
    const stale = new Date(NOW.getTime() - GAP_TASK_CLOSED_RETENTION_MS - 1).toISOString();
    for (let i = 0; i < GAP_TASKS_MAX_NOTES - 1; i++) {
      writeTask(`gap-filler-${i}`, GAP_TASK_STATUS_OPEN);
    }
    writeTask("gap-stale", GAP_TASK_STATUS_CLOSED, stale);
    seedGap("alpha topic", 3);
    const result = promoteGapsToTasks(vault, { threshold: 2, now: NOW });
    expect(result.pruned).toEqual(["gap-stale"]);
    expect(result.created).toEqual([gapTaskKey("alpha topic")]);
    expect(result.capped).toBe(0);
  });
});

// ----- keys are collision-free across the two recurrence sources ------------

describe("gapTaskKey", () => {
  test("a telemetry topic spelled like the adequacy namespace does not collide", () => {
    expect(gapTaskKey(`${GAP_SOURCE_ADEQUACY}:alpha`, GAP_SOURCE_TELEMETRY)).not.toBe(
      gapTaskKey("alpha", GAP_SOURCE_ADEQUACY),
    );
  });

  test("both sources are namespaced, so no pair of (source, topic) can share a key", () => {
    const seen = new Set<string>();
    for (const source of GAP_SOURCES) {
      for (const topic of ["alpha", "recall_adequacy:alpha", "recall_telemetry:alpha", "2:alpha"]) {
        seen.add(gapTaskKey(topic, source));
      }
    }
    expect(seen.size).toBe(8);
  });
});
