import { buildTimelineIndex } from "./temporal/build-index.ts";
import { collectTransitions } from "./temporal/period-common.ts";
import type { TemporalEvent } from "./temporal/types.ts";
import { BRAIN_APPLY_RESULT, BRAIN_LOG_EVENT_KIND } from "./types.ts";

export interface MonthlyReviewWindow {
  readonly since: string;
  readonly until: string;
}

export interface MonthlyReviewSummary {
  readonly events: number;
  readonly status_transitions: number;
  readonly retired: number;
  readonly contradictions: number;
  readonly neglected_areas: ReadonlyArray<string>;
}

export interface MonthlyReviewReport {
  readonly schema_version: 1;
  readonly generated_at: string;
  readonly month: string;
  readonly window: MonthlyReviewWindow;
  readonly summary: MonthlyReviewSummary;
}

export interface BuildMonthlyReviewOptions {
  /** Target month in `YYYY-MM` form. Defaults to current UTC month. */
  readonly month?: string;
  readonly now?: Date;
  /** Optional area labels expected to show activity in the month. */
  readonly expectedAreas?: ReadonlyArray<string>;
}

const MONTH_RE = /^\d{4}-\d{2}$/;

export function buildMonthlyReview(
  vault: string,
  options: BuildMonthlyReviewOptions = {},
): MonthlyReviewReport {
  const now = options.now ?? new Date();
  const month = normalizeMonthlyReviewMonth(
    options.month ?? now.toISOString().slice(0, 7),
  );
  const window = monthWindow(month);
  const index = buildTimelineIndex(vault, window);
  const transitions = collectTransitions(index.events);
  const retired = transitions.filter(
    (transition) => transition.kind === "retirement",
  ).length;
  const contradictions = countContradictions(index.events);

  return Object.freeze({
    schema_version: 1 as const,
    generated_at: now.toISOString(),
    month,
    window,
    summary: Object.freeze({
      events: index.events.length,
      status_transitions: transitions.length,
      retired,
      contradictions,
      neglected_areas: Object.freeze(
        neglectedAreas(index.events, options.expectedAreas ?? []),
      ),
    }),
  });
}

export function normalizeMonthlyReviewMonth(month: string): string {
  const normalized = month.trim();
  if (!MONTH_RE.test(normalized)) {
    throw new Error(
      `buildMonthlyReview: month must be YYYY-MM; got ${JSON.stringify(month)}`,
    );
  }
  const monthNumber = Number(normalized.slice(5, 7));
  if (monthNumber < 1 || monthNumber > 12) {
    throw new Error(
      `buildMonthlyReview: invalid month ${JSON.stringify(month)}`,
    );
  }
  return normalized;
}

function monthWindow(month: string): MonthlyReviewWindow {
  const start = Date.parse(`${month}-01T00:00:00Z`);
  if (!Number.isFinite(start)) {
    throw new Error(
      `buildMonthlyReview: invalid month ${JSON.stringify(month)}`,
    );
  }
  const startDate = new Date(start);
  const endDate = new Date(
    Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth() + 1, 1),
  );
  return Object.freeze({
    since: `${month}-01T00:00:00Z`,
    until: endDate.toISOString().replace(".000Z", "Z"),
  });
}

function countContradictions(events: ReadonlyArray<TemporalEvent>): number {
  let count = 0;
  for (const event of events) {
    if (event.kind === BRAIN_LOG_EVENT_KIND.signalSuppressed) count += 1;
    if (
      event.kind === BRAIN_LOG_EVENT_KIND.applyEvidence &&
      event.result === BRAIN_APPLY_RESULT.violated
    ) {
      count += 1;
    }
  }
  return count;
}

function neglectedAreas(
  events: ReadonlyArray<TemporalEvent>,
  expectedAreas: ReadonlyArray<string>,
): string[] {
  if (expectedAreas.length === 0) return [];
  const lowerText = events
    .map((event) => JSON.stringify(event).toLowerCase())
    .join("\n");
  return expectedAreas
    .filter((area) => !lowerText.includes(area.toLowerCase()))
    .toSorted();
}
