/**
 * List-pagination census (t_5198f0c7, Lane B).
 *
 * Cursor pagination on the MCP list tools is a decision, not an
 * accident: every tool whose input schema carries a `limit` either walks
 * by the shared offset cursor (src/core/brain/offset-cursor.ts, the
 * base64url form the decisions history shipped first) or is recorded
 * here as a deliberate report cap with the reason written out. A
 * newcomer tool that lands with a `limit` and neither a cursor nor a
 * recorded entry fails this census, so the gap between "can walk a
 * large result set" and "cannot" can only grow by an argued decision.
 *
 * Tiers, from the card census:
 *
 *   - Tier A (ordered logs/listings): full cursor walks. Pinned as an
 *     equality below, so a silently dropped cursor fails here.
 *   - Tier B (diagnostics/analytics): `limit` caps report rows, not an
 *     ordered walk - recorded caps. `brain_truth` action=events keeps
 *     its documented time-window paging ("rows are ascending assertion
 *     ts, so tail-following paginates by advancing since",
 *     knowledge-tools.ts); converting it would churn a convention.
 *   - Tier C (ranked retrieval): `brain_search` and `brain_file_context`
 *     stay limit-only. Ranking stability: the results are a ranked,
 *     index-dependent answer, not a stable set - re-running the query
 *     for a "page 2" races the index and offset paging would present
 *     that race as data.
 *
 * The three cursor encodings that predate this helper (decisions
 * history's base64url, session expand's decimal string, continuity's
 * `offset:` prefix) coexist unchanged: cursors are opaque to callers and
 * may be persisted mid-walk. The two expand surfaces carry a cursor but
 * no `limit`, so they appear in the cursor equality but not the
 * limit-bearing population.
 *
 * Mid-walk totals, stated where the walk is bounded: brain_event_trace
 * and brain_unlinked_mentions cut each page's scan one record past the
 * page's reach (the lookahead proves `next_cursor` without rescanning),
 * so their `total` (and brain_event_trace's `trace_total`) is exact once
 * the walk exhausts and reports the bound the page reached mid-walk -
 * a bound the tool descriptions name, never a silent cap.
 */

import { describe, expect, test } from "bun:test";

import { buildToolTable } from "../../src/mcp/tools.ts";

/** Every registered tool whose input schema declares `limit` or `cursor`. */
function pagingTools(): ReadonlyArray<{
  readonly name: string;
  readonly hasLimit: boolean;
  readonly hasCursor: boolean;
}> {
  return buildToolTable("full")
    .map((tool) => {
      const schema = tool.inputSchema as { properties?: Record<string, unknown> };
      const properties = schema.properties ?? {};
      return {
        name: tool.name,
        hasLimit: "limit" in properties,
        hasCursor: "cursor" in properties,
      };
    })
    .filter((tool) => tool.hasLimit || tool.hasCursor)
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

/**
 * Tier A plus the pre-existing cursor surfaces, pinned as an equality:
 * a moved membership is a finding to name, not a re-measurement chore.
 */
const EXPECTED_CURSORED: ReadonlyArray<string> = [
  "brain_agent_diff",
  "brain_agent_query",
  "brain_analytics",
  "brain_context_receipts",
  "brain_decision",
  "brain_event_trace",
  "brain_generation_reports",
  "brain_maintenance",
  "brain_scaffold_stub",
  "brain_search_expand",
  "brain_session_expand",
  "brain_session_grep",
  "brain_unlinked_mentions",
  "brain_write_destinations",
  "brain_write_session",
  "brain_writes",
  "second_brain_query",
].toSorted((a, b) => a.localeCompare(b));

/**
 * Tier-B report caps and Tier-C ranked retrieval, with the recorded
 * reason per tool. Every reason must be a real sentence: a placeholder
 * excuse is how a decision rots into an oversight.
 */
const REPORT_CAPS: Readonly<Record<string, string>> = {
  brain_recall_telemetry:
    "Report cap: a log-window summary whose rows are aggregate counts, not a walkable log; " +
    "a caller wanting history narrows the window with since/until instead of paging.",
  brain_route_metrics:
    "Report cap: per-route aggregate rates over a window; the rows are a fixed routing table, " +
    "not an ordered log a second page could continue.",
  brain_token_impact:
    "Report cap: a sampled-impact report bounded by max_samples alongside limit; the sample is " +
    "the diagnostic, and paging a resampled report would stitch two different samples together.",
  brain_context_pack_outcome:
    "Report cap: outcome aggregates per item over a window (max_samples-bounded); the fold, " +
    "not the row list, is the answer, so a cursor would page a stale recomputation.",
  brain_knowledge_gaps:
    "Report cap: an aggregated query-demand report; rows are derived groupings whose count " +
    "the window fixes, and the aggregation is the point of the surface.",
  brain_deep_synthesis:
    "Report cap: one synthesis pass with a hard row ceiling (default 30, max 100); the cap " +
    "sizes the synthesis budget, it does not truncate a walkable listing.",
  brain_brief:
    "Report cap: the digest's activity section is a bounded section of a fixed-shape digest; " +
    "the brief is read whole, not paged section by section.",
  brain_truth:
    "Time-window paging by documented convention: rows are ascending assertion ts, so " +
    "tail-following paginates by advancing `since` (knowledge-tools.ts); a cursor would " +
    "duplicate a mechanism the surface already has.",
  brain_search:
    "Ranking stability: results are a ranked, index-dependent answer, not a stable set - " +
    "re-running the query for a second page races the index, and offset paging would present " +
    "that race as data.",
  brain_file_context:
    "Ranking stability: a size-ranked file listing recomputed per call; between two calls the " +
    "ranking's input set can change, so a second page would not be the rest of the first answer.",
};

/** Longest reason that still says something; shorter entries are placeholders. */
const MIN_REASON_LENGTH = 60;

describe("list-pagination census", () => {
  test("every limit-bearing tool either walks by cursor or carries a recorded cap", () => {
    const unaccounted = pagingTools()
      .filter((tool) => tool.hasLimit && !tool.hasCursor && REPORT_CAPS[tool.name] === undefined)
      .map((tool) => tool.name);
    expect(
      "limit-only tools with neither a cursor nor a recorded cap:\n" +
        unaccounted.sort().join("\n"),
    ).toBe("limit-only tools with neither a cursor nor a recorded cap:\n");
  });

  test("the cursor rollouts are pinned as an equality", () => {
    expect(
      pagingTools()
        .filter((tool) => tool.hasCursor)
        .map((tool) => tool.name),
    ).toEqual([...EXPECTED_CURSORED]);
  });

  test("every recorded cap names a registered limit-only tool, with a real reason", () => {
    const byName = new Map(pagingTools().map((tool) => [tool.name, tool]));
    for (const [name, reason] of Object.entries(REPORT_CAPS)) {
      const tool = byName.get(name);
      expect(`${name} is registered: ${tool !== undefined}`).toBe(`${name} is registered: true`);
      expect(`${name} is limit-only: ${tool!.hasLimit && !tool!.hasCursor}`).toBe(
        `${name} is limit-only: true`,
      );
      expect(`${name} reason length: ${reason.trim().length >= MIN_REASON_LENGTH}`).toBe(
        `${name} reason length: true`,
      );
    }
  });

  test("the populations are pinned as equalities", () => {
    // 24 -> 25: brain_write_destinations (actionable-now batch) carries
    // limit + cursor beside brain_writes, so the limit-bearing population
    // grows by one.
    expect(pagingTools().filter((tool) => tool.hasLimit)).toHaveLength(25);
    // 10 recorded caps: eight Tier-B report/window caps and the two
    // Tier-C ranked-retrieval non-goals.
    expect(Object.keys(REPORT_CAPS)).toHaveLength(10);
  });

  test("the census can fail", () => {
    // A sweep that stopped matching would report a clean verdict over an
    // empty set. Pin the measurement, not only its verdict.
    expect(pagingTools().length).toBeGreaterThan(20);
  });
});
