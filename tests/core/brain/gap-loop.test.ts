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
  GapRecallScopeError,
  type GapRecallRetriever,
} from "../../../src/core/brain/gaps/gap-loop.ts";
import { brainGapTasksDir } from "../../../src/core/brain/paths.ts";
import type { RecallResultSet } from "../../../src/core/brain/recall-inject.ts";
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

/** Path of the one ordinary note the fixtures below recall. */
const ORDINARY_NOTE = "Brain/x.md";

/** Path of a gap-task note - the row the membership rule excludes. */
const GAP_TASK_NOTE = "Brain/gap-tasks/gap-abc.md";

/**
 * A retrieval that covers `matchQuality` of the topic with a candidate
 * scoring `score`.
 *
 * Both are parameters, and callers are required to pass them on OPPOSITE
 * sides of the floor. A fixture where the two agree cannot tell the gate
 * apart from the substitution this release removed: with `score` and
 * coverage both at 0.92, reverting the gate to `topScore >= floor` leaves
 * the test green, so it asserts the outcome without asserting the reason.
 */
function retrieverWithCoverage(matchQuality: number | null, score: number): GapRecallRetriever {
  return async () =>
    ({
      candidates: [
        {
          path: ORDINARY_NOTE,
          title: "X",
          score,
          searchType: "hybrid",
          startLine: 1,
          endLine: 2,
        },
      ],
      total: 1,
      idfWeightedCoverage: matchQuality,
    }) satisfies RecallResultSet;
}

/** One row of the fixture corpus {@link retrieverOverRows} recalls. */
interface FixtureRow {
  readonly path: string;
  readonly score: number;
  /** Share of the topic this row alone covers. */
  readonly coverage: number;
}

/**
 * A retrieval that honours its membership rule the way a real one must:
 * the predicate selects the rows BEFORE the quality is measured, so the
 * number describes the rows the gate is about to judge.
 *
 * Coverage over the admitted rows is modelled as the best admitted row's
 * share, and zero when none survived - a measured zero, since the topic
 * has terms and nothing covered them.
 */
function retrieverOverRows(rows: ReadonlyArray<FixtureRow>): GapRecallRetriever {
  return async (_topic, admits) => {
    const admitted = rows.filter((row) => admits(row.path));
    return {
      candidates: admitted.map((row) => ({
        path: row.path,
        title: "X",
        score: row.score,
        searchType: "hybrid" as const,
        startLine: 1,
        endLine: 2,
      })),
      total: admitted.length,
      idfWeightedCoverage:
        admitted.length === 0 ? 0 : Math.max(...admitted.map((row) => row.coverage)),
    } satisfies RecallResultSet;
  };
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
    // Coverage above the floor, score far below it: only the gate that
    // reads coverage can close this task.
    const result = await autoCloseRecalledGaps(vault, retrieverWithCoverage(0.92, 0.05), {
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

  test("never self-closes: the gap-task note cannot supply the coverage the floor reads", async () => {
    seedGap("alpha topic", 3);
    promoteGapsToTasks(vault, { threshold: 2, now: NOW });
    // The gap-task note covers its own topic completely - it carries the
    // topic verbatim - and one ordinary note mentions it in passing. The
    // membership rule excludes the first, so the quality the floor reads
    // must be the second's 0.1, not the pair's 1.0.
    //
    // This is the case the previous shape got wrong. It filtered the task
    // note out of `coveredElsewhere` but read a coverage number measured
    // over BOTH rows, so the note it was excluding still cleared the floor
    // for it and the task closed on its own text.
    const result = await autoCloseRecalledGaps(
      vault,
      retrieverOverRows([
        { path: GAP_TASK_NOTE, score: 0.99, coverage: 1 },
        { path: ORDINARY_NOTE, score: 0.4, coverage: 0.1 },
      ]),
      { confidenceFloor: 0.5, now: NOW },
    );
    expect(result.closed).toHaveLength(0);
    expect(listGapTasks(vault, { status: GAP_TASK_STATUS_OPEN })).toHaveLength(1);
  });

  test("a retriever that answers outside the membership rule is refused by name", async () => {
    seedGap("alpha topic", 3);
    promoteGapsToTasks(vault, { threshold: 2, now: NOW });
    // Ignores `admits` and returns the excluded row anyway. Its quality
    // number therefore describes rows the gate rejects, and reading it
    // would be reading a measurement of something else.
    const ignoresTheRule: GapRecallRetriever = async () =>
      ({
        candidates: [
          {
            path: GAP_TASK_NOTE,
            title: "gap",
            score: 0.99,
            searchType: "hybrid",
            startLine: 1,
            endLine: 2,
          },
        ],
        total: 1,
        idfWeightedCoverage: 1,
      }) satisfies RecallResultSet;
    await expect(
      autoCloseRecalledGaps(vault, ignoresTheRule, { confidenceFloor: 0.5, now: NOW }),
    ).rejects.toThrow(GapRecallScopeError);
    expect(listGapTasks(vault, { status: GAP_TASK_STATUS_OPEN })).toHaveLength(1);
  });

  test("keeps a gap task open when recall stays below the confidence floor", async () => {
    seedGap("alpha topic", 3);
    promoteGapsToTasks(vault, { threshold: 2, now: NOW });
    // Coverage below the floor, score far above it: only the gate that
    // reads coverage can keep this task open.
    const result = await autoCloseRecalledGaps(vault, retrieverWithCoverage(0.2, 0.99), {
      confidenceFloor: 0.5,
      now: NOW,
    });
    expect(result.closed).toHaveLength(0);
    expect(listGapTasks(vault, { status: GAP_TASK_STATUS_OPEN })).toHaveLength(1);
  });

  test("an unmeasurable recall never closes a task", async () => {
    seedGap("alpha topic", 3);
    promoteGapsToTasks(vault, { threshold: 2, now: NOW });
    // A confident-looking row with no measurable quality behind it: the
    // exact pair the old `totalIdf === 0 ? 1` produced, which cleared
    // every floor.
    const result = await autoCloseRecalledGaps(vault, retrieverWithCoverage(null, 0.99), {
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
