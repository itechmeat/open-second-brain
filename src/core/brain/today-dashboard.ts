/**
 * `buildTodayDashboard(vault, opts)` - today operator surface (Task 4).
 *
 * Composes four independently-computed, live-derived sections into one
 * read-only envelope: due/overdue obligations, open loops, recent
 * activity, and a totals rollup. Each section is built from its own
 * primitive - `listObligations`, `scanOpenLoops`, `buildActivityTimeline`
 * over `buildTimelineIndex` - and nothing here re-scans the vault a
 * second time; `totals` is pure arithmetic over the three already-built
 * sections.
 *
 * Fault isolation: each section is computed inside its own try/catch. A
 * section whose builder throws contributes an explicit entry to the
 * envelope's `errors` array ({ section, message }) and falls back to a
 * well-formed empty shape for that section; the other sections still
 * compute and render normally. The rendered `## <Section>` block for a
 * failed section prints an explicit `- error: <message>` line instead of
 * silently looking like an empty-but-healthy section - an empty render
 * with no accompanying error would misrepresent a scan failure as "there
 * is simply nothing here".
 *
 * Determinism: every date-sensitive computation flows from `opts.now`;
 * nothing here reads the wall clock. The envelope, every section, and
 * every nested array are frozen.
 */

import { listObligations } from "./obligations.ts";
import { scanOpenLoops, type OpenLoopScan } from "./open-loops.ts";
import { isoSecond } from "./time.ts";
import { buildActivityTimeline, type ActivityTimeline } from "./temporal/activity-timeline.ts";
import { buildTimelineIndex } from "./temporal/build-index.ts";

/** Options accepted by {@link buildTodayDashboard}. */
export interface TodayDashboardOptions {
  /** Wall clock; every date/age computation derives from this. */
  readonly now: Date;
  /** Days of log history the recent-activity section windows over. Default 7. */
  readonly activityLookbackDays?: number;
  /** Max recent-activity entries to keep, newest first. Default 20. */
  readonly activityLimit?: number;
}

/** One obligation row surfaced on the dashboard. */
export interface TodayDashboardObligationItem {
  readonly slug: string;
  readonly title: string;
  /** True when next-due is strictly before today (UTC). */
  readonly overdue: boolean;
  /** Whole days until next-due; negative when overdue, zero when due today. */
  readonly daysUntilDue: number;
  readonly nextDue: string;
}

/** Obligations section: due-today / overdue first, via `listObligations`'s own sort. */
export interface TodayDashboardObligationsSection {
  readonly items: ReadonlyArray<TodayDashboardObligationItem>;
}

/** Deterministic counters derived from the other three sections. No second scan. */
export interface TodayDashboardTotals {
  readonly obligationsTotal: number;
  readonly obligationsOverdue: number;
  readonly obligationsDueToday: number;
  readonly openLoopsCount: number;
  readonly recentActivityTotal: number;
  readonly scannedFiles: number;
}

/** The four independently-computed dashboard sections. */
export type TodayDashboardSectionName = "obligations" | "openLoops" | "recentActivity" | "totals";

/** One per-section computation failure. */
export interface TodayDashboardSectionError {
  readonly section: TodayDashboardSectionName;
  readonly message: string;
}

/** Frozen envelope returned by {@link buildTodayDashboard}. */
export interface TodayDashboard {
  readonly obligations: TodayDashboardObligationsSection;
  readonly openLoops: OpenLoopScan;
  readonly recentActivity: ActivityTimeline;
  readonly totals: TodayDashboardTotals;
  /** Per-section failures; empty when every section computed cleanly. */
  readonly errors: ReadonlyArray<TodayDashboardSectionError>;
  /** Rendered Markdown: `## Obligations`, `## Open loops`, `## Recent activity`, `## Totals`, in that order. */
  readonly text: string;
}

const DEFAULT_ACTIVITY_LOOKBACK_DAYS = 7;
const DEFAULT_ACTIVITY_LIMIT = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

const EMPTY_OBLIGATIONS_SECTION: TodayDashboardObligationsSection = Object.freeze({
  items: Object.freeze([]) as ReadonlyArray<TodayDashboardObligationItem>,
});

const EMPTY_OPEN_LOOP_SCAN: OpenLoopScan = Object.freeze({
  openLoops: Object.freeze([]),
  counts: Object.freeze({ openCount: 0, closedCount: 0, scannedFiles: 0 }),
  duplicates: Object.freeze([]),
  orphanCloses: Object.freeze([]),
});

const EMPTY_ACTIVITY_TIMELINE: ActivityTimeline = Object.freeze({
  entries: Object.freeze([]),
  bullets: Object.freeze([]),
  text: "",
  total: 0,
});

const EMPTY_TOTALS: TodayDashboardTotals = Object.freeze({
  obligationsTotal: 0,
  obligationsOverdue: 0,
  obligationsDueToday: 0,
  openLoopsCount: 0,
  recentActivityTotal: 0,
  scannedFiles: 0,
});

/**
 * Validate the caller-supplied option knobs up front, before any section
 * runs. An invalid option is a programmer error, not a data-conditioned
 * partial failure - it is rejected outright rather than routed through
 * per-section fault isolation.
 */
function resolveWindowOptions(opts: TodayDashboardOptions): {
  readonly lookbackDays: number;
  readonly limit: number;
} {
  const lookbackDays = opts.activityLookbackDays ?? DEFAULT_ACTIVITY_LOOKBACK_DAYS;
  if (!Number.isInteger(lookbackDays) || lookbackDays < 0) {
    throw new Error(
      `buildTodayDashboard: activityLookbackDays must be a non-negative integer; got ${JSON.stringify(opts.activityLookbackDays)}`,
    );
  }
  const limit = opts.activityLimit ?? DEFAULT_ACTIVITY_LIMIT;
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(
      `buildTodayDashboard: activityLimit must be a non-negative integer; got ${JSON.stringify(opts.activityLimit)}`,
    );
  }
  return { lookbackDays, limit };
}

/** Run one section's builder, recording a typed error and falling back to an empty shape on throw. */
function computeSection<T>(
  section: TodayDashboardSectionName,
  errors: TodayDashboardSectionError[],
  compute: () => T,
  fallback: T,
): T {
  try {
    return compute();
  } catch (err) {
    errors.push({ section, message: err instanceof Error ? err.message : String(err) });
    return fallback;
  }
}

function buildObligationsSection(vault: string, now: Date): TodayDashboardObligationsSection {
  const items = listObligations(vault, { now }).map((o) =>
    Object.freeze({
      slug: o.slug,
      title: o.title,
      overdue: o.overdue,
      daysUntilDue: o.daysUntilDue,
      nextDue: o.nextDue,
    }),
  );
  return Object.freeze({ items: Object.freeze(items) });
}

function buildRecentActivitySection(
  vault: string,
  now: Date,
  lookbackDays: number,
  limit: number,
): ActivityTimeline {
  const since = isoSecond(new Date(now.getTime() - lookbackDays * DAY_MS));
  const index = buildTimelineIndex(vault, { now, since });
  return buildActivityTimeline(index, { now, since, limit });
}

function computeTotals(
  obligations: TodayDashboardObligationsSection,
  openLoops: OpenLoopScan,
  recentActivity: ActivityTimeline,
): TodayDashboardTotals {
  let overdue = 0;
  let dueToday = 0;
  for (const item of obligations.items) {
    if (item.overdue) overdue++;
    else if (item.daysUntilDue === 0) dueToday++;
  }
  return Object.freeze({
    obligationsTotal: obligations.items.length,
    obligationsOverdue: overdue,
    obligationsDueToday: dueToday,
    openLoopsCount: openLoops.counts.openCount,
    recentActivityTotal: recentActivity.total,
    scannedFiles: openLoops.counts.scannedFiles,
  });
}

function renderObligationLine(item: TodayDashboardObligationItem): string {
  const state = item.overdue
    ? `overdue by ${Math.abs(item.daysUntilDue)}d`
    : item.daysUntilDue === 0
      ? "due today"
      : `due in ${item.daysUntilDue}d`;
  return `- ${item.title} (slug: ${item.slug}) - next due ${item.nextDue} - ${state}`;
}

function renderOpenLoopLine(loop: OpenLoopScan["openLoops"][number]): string {
  return `- ${loop.text} (id: ${loop.id}) - ${loop.path}:${loop.line}`;
}

function renderSection(
  header: string,
  errorMessage: string | undefined,
  lines: ReadonlyArray<string>,
): string {
  if (errorMessage !== undefined) {
    return [header, `- error: ${errorMessage}`].join("\n");
  }
  return [header, ...(lines.length > 0 ? lines : ["(none)"])].join("\n");
}

function renderDashboardText(
  obligations: TodayDashboardObligationsSection,
  openLoops: OpenLoopScan,
  recentActivity: ActivityTimeline,
  totals: TodayDashboardTotals,
  errors: ReadonlyArray<TodayDashboardSectionError>,
): string {
  const errorBySection = new Map(errors.map((e) => [e.section, e.message] as const));

  const obligationsBlock = renderSection(
    "## Obligations",
    errorBySection.get("obligations"),
    obligations.items.map(renderObligationLine),
  );
  const openLoopsBlock = renderSection(
    "## Open loops",
    errorBySection.get("openLoops"),
    openLoops.openLoops.map(renderOpenLoopLine),
  );
  const recentActivityBlock = renderSection(
    "## Recent activity",
    errorBySection.get("recentActivity"),
    recentActivity.bullets,
  );
  const totalsBlock = renderSection("## Totals", errorBySection.get("totals"), [
    `Obligations: ${totals.obligationsTotal}`,
    `Overdue: ${totals.obligationsOverdue}`,
    `Due today: ${totals.obligationsDueToday}`,
    `Open loops: ${totals.openLoopsCount}`,
    `Recent activity: ${totals.recentActivityTotal}`,
    `Scanned files: ${totals.scannedFiles}`,
  ]);

  return [obligationsBlock, openLoopsBlock, recentActivityBlock, totalsBlock].join("\n\n");
}

/**
 * Build the today dashboard for a vault. Read-only; deterministic given
 * `opts.now`. Each of the four sections computes independently - a
 * section that throws is recorded in `errors` and rendered as an
 * explicit error line, the rest of the envelope still reflects a normal
 * computation.
 */
export function buildTodayDashboard(vault: string, opts: TodayDashboardOptions): TodayDashboard {
  const { lookbackDays, limit } = resolveWindowOptions(opts);
  const errors: TodayDashboardSectionError[] = [];

  const obligations = computeSection(
    "obligations",
    errors,
    () => buildObligationsSection(vault, opts.now),
    EMPTY_OBLIGATIONS_SECTION,
  );
  const openLoops = computeSection(
    "openLoops",
    errors,
    () => scanOpenLoops(vault),
    EMPTY_OPEN_LOOP_SCAN,
  );
  const recentActivity = computeSection(
    "recentActivity",
    errors,
    () => buildRecentActivitySection(vault, opts.now, lookbackDays, limit),
    EMPTY_ACTIVITY_TIMELINE,
  );
  const totals = computeSection(
    "totals",
    errors,
    () => computeTotals(obligations, openLoops, recentActivity),
    EMPTY_TOTALS,
  );

  const text = renderDashboardText(obligations, openLoops, recentActivity, totals, errors);

  return Object.freeze({
    obligations,
    openLoops,
    recentActivity,
    totals,
    errors: Object.freeze(errors.slice()),
    text,
  });
}
