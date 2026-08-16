import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emitRecallTelemetry, RECALL_CHANNEL } from "../../../src/core/brain/recall-telemetry.ts";
import { assessRecallAdequacy } from "../../../src/core/brain/recall-adequacy.ts";
import {
  normalizeQueryTerms,
  readQueryDemand,
  recordRecallAdequacyDemand,
} from "../../../src/core/brain/query-demand.ts";
import {
  autoCloseRecalledGaps,
  detectRecurringGaps,
  gapTaskKey,
  GAP_LOOP_MAX_PROMOTIONS_PER_RUN,
  GAP_SOURCE_ADEQUACY,
  GAP_SOURCE_TELEMETRY,
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
  vault = mkdtempSync(join(tmpdir(), "o2b-gap-adequacy-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

const NOW = new Date("2026-06-01T12:00:00.000Z");

/** A query whose bucket key is stable and shared across the tests below. */
const QUERY = "widget calibration procedure";
/** The bucket key `normalizeQueryTerms` derives for {@link QUERY}. */
const QUERY_BUCKET = normalizeQueryTerms(QUERY).join(" ");

/**
 * Recall attempts producing each verdict level under the default
 * thresholds. The level follows `matchQuality`; the scores only carry the
 * usable-result count that `minResults` gates on.
 *
 * Each pair puts its score on the OPPOSITE side of the boundary from its
 * quality, so no case here can be produced by reading the score instead -
 * the substitution this release removed and which several sibling
 * fixtures still could not have detected.
 */
const WEAK_RECALL = Object.freeze({ matchQuality: 0.4, scores: [0.9] });
const SUFFICIENT_RECALL = Object.freeze({ matchQuality: 0.9, scores: [0.1] });
const INSUFFICIENT_RECALL = Object.freeze({
  matchQuality: 0,
  scores: [] as ReadonlyArray<number>,
});

function stampUnmet(
  query: string,
  times: number,
  attempt: { readonly matchQuality: number; readonly scores: ReadonlyArray<number> },
): void {
  const verdict = assessRecallAdequacy(attempt);
  for (let i = 0; i < times; i++) {
    recordRecallAdequacyDemand(vault, {
      query,
      verdict,
      at: `2026-05-1${i}T09:00:00.000Z`,
    });
  }
}

function seedStructuralGap(topic: string, times: number): void {
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

/**
 * A retrieval that covers `matchQuality` of the topic with a candidate
 * scoring `score`.
 *
 * Both are parameters, and callers pass them on opposite sides of the
 * floor. The score used to be hardcoded at 0.92 while every caller passed
 * 0.92 as the coverage too, which made the fixture unable to tell the
 * coverage gate from a score gate.
 */
function retrieverWithCoverage(matchQuality: number, score: number): RecallRetriever {
  return async () =>
    ({
      candidates: [
        {
          path: "Brain/x.md",
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

describe("recall-adequacy stamps the demand record (signals-that-survive, unit 6)", () => {
  test("a weak verdict stamps the record under the normalizeQueryTerms bucket key", () => {
    const record = recordRecallAdequacyDemand(vault, {
      query: QUERY,
      verdict: assessRecallAdequacy(WEAK_RECALL),
    });
    expect(record).not.toBeNull();
    expect(record!.adequacy).toBe("weak");
    // The bucket key is exactly what normalizeQueryTerms already computes —
    // no second identity concept.
    expect(record!.terms).toEqual(normalizeQueryTerms(QUERY));
    const [persisted] = readQueryDemand(vault);
    expect(persisted?.adequacy).toBe("weak");
    expect(persisted?.terms.join(" ")).toBe(QUERY_BUCKET);
  });

  test("an insufficient verdict stamps the record and carries its result count", () => {
    const verdict = assessRecallAdequacy(INSUFFICIENT_RECALL);
    const record = recordRecallAdequacyDemand(vault, { query: QUERY, verdict });
    expect(record!.adequacy).toBe("insufficient");
    expect(record!.results).toBe(verdict.resultCount);
  });

  test("a sufficient verdict stamps nothing — only unmet recall is demand", () => {
    const record = recordRecallAdequacyDemand(vault, {
      query: QUERY,
      verdict: assessRecallAdequacy(SUFFICIENT_RECALL),
    });
    expect(record).toBeNull();
    expect(readQueryDemand(vault)).toHaveLength(0);
  });

  test("a query with no significant terms records nothing rather than an empty bucket", () => {
    const record = recordRecallAdequacyDemand(vault, {
      // Punctuation only. "a b c" used to land here, because the term
      // floor dropped every token under three characters - which also
      // dropped every CJK query, so those gaps could never be counted.
      query: "?!? ...",
      verdict: assessRecallAdequacy(WEAK_RECALL),
    });
    expect(record).toBeNull();
    expect(readQueryDemand(vault)).toHaveLength(0);
  });
});

describe("verdict recurrence feeds the gap loop (signals-that-survive, unit 6)", () => {
  test("a bucket at or above the threshold surfaces as an adequacy-sourced gap", () => {
    stampUnmet(QUERY, 3, WEAK_RECALL);
    const gaps = detectRecurringGaps(vault, { threshold: 3 });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.topic).toBe(QUERY_BUCKET);
    expect(gaps[0]?.occurrences).toBe(3);
    expect(gaps[0]?.source).toBe(GAP_SOURCE_ADEQUACY);
  });

  test("a bucket below the threshold mints nothing", () => {
    stampUnmet(QUERY, 2, WEAK_RECALL);
    expect(detectRecurringGaps(vault, { threshold: 3 })).toHaveLength(0);
    const result = promoteGapsToTasks(vault, { threshold: 3, now: NOW });
    expect(result.created).toHaveLength(0);
    expect(existsSync(join(vault, "Brain", "gap-tasks"))).toBe(false);
  });

  test("a recurring bucket promotes to exactly one gap task carrying its source", () => {
    stampUnmet(QUERY, 3, WEAK_RECALL);
    const result = promoteGapsToTasks(vault, { threshold: 3, now: NOW });
    const key = gapTaskKey(QUERY_BUCKET, GAP_SOURCE_ADEQUACY);
    expect(result.created).toEqual([key]);
    const [fm] = parseFrontmatterText(
      readFileSync(join(vault, "Brain", "gap-tasks", `${key}.md`), "utf8"),
    );
    expect(fm["kind"]).toBe(GAP_TASK_KIND);
    expect(fm["gap_source"]).toBe(GAP_SOURCE_ADEQUACY);
    expect(fm["gap_topic"]).toBe(QUERY_BUCKET);
    // Still a plain vault note: never a kanban row.
    expect(fm["board"]).toBeUndefined();
  });

  test("an existing open gap task for the same key is not duplicated", () => {
    stampUnmet(QUERY, 3, WEAK_RECALL);
    const first = promoteGapsToTasks(vault, { threshold: 3, now: NOW });
    const second = promoteGapsToTasks(vault, { threshold: 3, now: NOW });
    expect(first.created).toHaveLength(1);
    expect(second.created).toHaveLength(0);
    expect(second.skipped).toEqual([gapTaskKey(QUERY_BUCKET, GAP_SOURCE_ADEQUACY)]);
    expect(listGapTasks(vault, { status: GAP_TASK_STATUS_OPEN })).toHaveLength(1);
  });

  test("promotion is capped per run at the named constant", () => {
    const buckets = GAP_LOOP_MAX_PROMOTIONS_PER_RUN + 1;
    for (let i = 0; i < buckets; i++) {
      stampUnmet(`coverage gap topic${i}`, 3 + (buckets - i), WEAK_RECALL);
    }
    expect(detectRecurringGaps(vault, { threshold: 3 })).toHaveLength(buckets);
    const first = promoteGapsToTasks(vault, { threshold: 3, now: NOW });
    expect(first.created).toHaveLength(GAP_LOOP_MAX_PROMOTIONS_PER_RUN);
    // The cap bounds NEW notes per run, so the remainder is minted next run
    // rather than being dropped.
    const second = promoteGapsToTasks(vault, { threshold: 3, now: NOW });
    expect(second.created).toHaveLength(buckets - GAP_LOOP_MAX_PROMOTIONS_PER_RUN);
    expect(listGapTasks(vault, { status: GAP_TASK_STATUS_OPEN })).toHaveLength(buckets);
  });

  test("an adequacy gap task auto-closes once its topic recalls with sufficient confidence", async () => {
    stampUnmet(QUERY, 3, WEAK_RECALL);
    promoteGapsToTasks(vault, { threshold: 3, now: NOW });
    // Coverage above the floor, score far below it.
    const result = await autoCloseRecalledGaps(vault, retrieverWithCoverage(0.92, 0.05), {
      confidenceFloor: 0.5,
      now: NOW,
    });
    expect(result.closed).toEqual([gapTaskKey(QUERY_BUCKET, GAP_SOURCE_ADEQUACY)]);
    expect(listGapTasks(vault, { status: GAP_TASK_STATUS_OPEN })).toHaveLength(0);
    expect(listGapTasks(vault, { status: GAP_TASK_STATUS_CLOSED })).toHaveLength(1);
  });
});

describe("the two occurrence sources stay distinguishable (signals-that-survive, unit 6)", () => {
  test("occurrences is never a sum across the structural and verdict sources", () => {
    // Same literal topic string from BOTH sources: a coarse telemetry code
    // bucket and a fine term bucket that happen to collide textually.
    seedStructuralGap(QUERY_BUCKET, 3);
    stampUnmet(QUERY, 4, WEAK_RECALL);

    const gaps = detectRecurringGaps(vault, { threshold: 3 });
    expect(gaps).toHaveLength(2);
    // Never one row of 7.
    expect(gaps.map((g) => g.occurrences).toSorted()).toEqual([3, 4]);
    expect(gaps.some((g) => g.occurrences === 7)).toBe(false);
    const bySource = new Map(gaps.map((g) => [g.source, g.occurrences]));
    expect(bySource.get(GAP_SOURCE_TELEMETRY)).toBe(3);
    expect(bySource.get(GAP_SOURCE_ADEQUACY)).toBe(4);
  });

  test("a textually identical topic from each source mints two separate tasks", () => {
    seedStructuralGap(QUERY_BUCKET, 3);
    stampUnmet(QUERY, 4, WEAK_RECALL);
    const result = promoteGapsToTasks(vault, { threshold: 3, now: NOW });
    expect(result.created).toHaveLength(2);
    // The keys are namespaced by source, so the two rows can never collapse
    // into one note.
    expect(new Set(result.created).size).toBe(2);
    expect(result.created).toContain(gapTaskKey(QUERY_BUCKET, GAP_SOURCE_TELEMETRY));
    expect(result.created).toContain(gapTaskKey(QUERY_BUCKET, GAP_SOURCE_ADEQUACY));
  });

  test("the structural gap key is unchanged by the new source argument", () => {
    // Notes minted before the adequacy source existed must keep resolving.
    expect(gapTaskKey("alpha topic")).toBe(gapTaskKey("alpha topic", GAP_SOURCE_TELEMETRY));
    expect(gapTaskKey("alpha topic")).not.toBe(gapTaskKey("alpha topic", GAP_SOURCE_ADEQUACY));
  });

  test("the agenda labels each row by its source", () => {
    seedStructuralGap("alpha topic", 3);
    stampUnmet(QUERY, 4, WEAK_RECALL);
    promoteGapsToTasks(vault, { threshold: 3, now: NOW });
    const agenda = renderGapAgenda(vault, NOW);
    // The structural row keeps its existing wording verbatim.
    expect(agenda).toContain("alpha topic (recall gap x3)");
    // The verdict row is labelled differently, so a reader can tell a coarse
    // telemetry code bucket from a fine term bucket.
    expect(agenda).toContain(`${QUERY_BUCKET} (weak recall x4)`);
  });
});
