/**
 * §14b Live-counts console collector (session-mining-economy, t_15ebcfc1).
 *
 * One read-only composition of the counts the loopback explorer's
 * console renders and no surface served before:
 *
 *   - the recall-telemetry summary (`summarizeRecallTelemetry` verbatim);
 *   - the most-recalled artifacts, aggregated by the shipped
 *     `deriveUsageSignals` and labelled with the id/path identity the
 *     telemetry records themselves carry, under a named cap;
 *   - a written-per-day histogram over a named 30-day window, bucketed
 *     from continuity record `createdAt` - every continuity append is a
 *     write event, whatever its kind;
 *   - the latest report-snapshot date per surface, fail-soft: with the
 *     feature off the section reads as "disabled", never as empty data
 *     an operator could mistake for "enabled, nothing written yet".
 *
 * Output is deterministic GIVEN the same `opts.now` and frozen like
 * `collectExplorerData`, so the live HTTP handler cannot mutate it.
 * The live route injects no clock: every GET stamps its own render
 * time into `generated_at` and the histogram window rolls at the UTC
 * day boundary, so two GETs agree on every recorded section but never
 * on the stamp. Byte-for-byte reproducibility across calls holds only
 * for callers that inject one `now`.
 *
 * Reads only. This module never appends a continuity record, never
 * captures a report delta, and never writes: a viewer must not fire the
 * lazy writes the stores it reads are allowed to fire.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { listContinuityRecords } from "./continuity/store.ts";
import { deriveUsageSignals, type SourceUsage } from "./continuity/usage-signal.ts";
import { brainDirs } from "./paths.ts";
import {
  listRecallTelemetry,
  summarizeRecallTelemetry,
  type RecallTelemetrySummary,
} from "./recall-telemetry.ts";
import { loadLatestReportSnapshot, reportSnapshotsEnabled } from "./report-snapshot.ts";

export const EXPLORER_CONSOLE_SCHEMA_VERSION = 1 as const;

/** Calendar days the written-per-day histogram covers, ending at `now`. */
export const EXPLORER_CONSOLE_WINDOW_DAYS = 30;

/**
 * Most-recalled entries reported. A named cap, not a query parameter:
 * query parameters add surface to a read-only console for a bound the
 * house can name in one constant.
 */
export const EXPLORER_CONSOLE_MOST_RECALLED_LIMIT = 10;

const DAY_MS = 86_400_000;

export interface ExplorerConsoleMostRecalled {
  /** Artifact id from the telemetry payload, or null when unnamed. */
  readonly id: string | null;
  /** Artifact path from the telemetry payload, or null when unnamed. */
  readonly path: string | null;
  readonly access_count: number;
  /** ISO timestamp of the most recent recorded recall. */
  readonly last_access_at: string;
}

export interface ExplorerConsoleDayBucket {
  /** UTC calendar date, `YYYY-MM-DD`. */
  readonly date: string;
  readonly count: number;
}

export interface ExplorerConsoleSnapshotSurface {
  readonly surface: string;
  /** Latest valid snapshot date, or null when the surface has none yet. */
  readonly latest_date: string | null;
}

/**
 * "disabled" while `report_snapshots_enabled` is off - a state statement,
 * distinct from "enabled with no snapshots yet".
 */
export type ExplorerConsoleReportSnapshots =
  | { readonly status: "disabled" }
  | {
      readonly status: "ok";
      readonly surfaces: ReadonlyArray<ExplorerConsoleSnapshotSurface>;
    };

export interface ExplorerConsolePayload {
  readonly schema_version: typeof EXPLORER_CONSOLE_SCHEMA_VERSION;
  readonly generated_at: string;
  readonly window_days: number;
  readonly window_since: string;
  readonly window_until: string;
  readonly telemetry: RecallTelemetrySummary;
  readonly most_recalled: ReadonlyArray<ExplorerConsoleMostRecalled>;
  readonly written_per_day: ReadonlyArray<ExplorerConsoleDayBucket>;
  readonly report_snapshots: ExplorerConsoleReportSnapshots;
}

export interface CollectExplorerConsoleOptions {
  /** Wall clock for `generated_at` and the histogram window. Defaults to `new Date()`. */
  readonly now?: Date;
  /** Config path for the report-snapshot enablement lookup. */
  readonly configPath?: string;
}

export function collectExplorerConsole(
  vault: string,
  opts: CollectExplorerConsoleOptions = {},
): ExplorerConsolePayload {
  const now = opts.now ?? new Date();
  const windowDays = windowDates(now);
  const since = `${windowDays[0]!}T00:00:00.000Z`;
  const until = `${windowDays[windowDays.length - 1]!}T23:59:59.999Z`;
  return Object.freeze({
    schema_version: EXPLORER_CONSOLE_SCHEMA_VERSION,
    generated_at: now.toISOString(),
    window_days: EXPLORER_CONSOLE_WINDOW_DAYS,
    window_since: since,
    window_until: until,
    telemetry: summarizeRecallTelemetry(vault),
    most_recalled: mostRecalled(vault),
    written_per_day: writtenPerDay(vault, since, until, windowDays),
    report_snapshots: reportSnapshots(vault, now, opts.configPath),
  });
}

/** The `window_days` UTC calendar dates ending at `now`'s date, oldest first. */
function windowDates(now: Date): ReadonlyArray<string> {
  const dates: string[] = [];
  for (let i = EXPLORER_CONSOLE_WINDOW_DAYS - 1; i >= 0; i--) {
    dates.push(new Date(now.getTime() - i * DAY_MS).toISOString().slice(0, 10));
  }
  return dates;
}

/**
 * Most-recalled artifacts over all recorded telemetry.
 *
 * `deriveUsageSignals` aggregates per artifact but registers ONE
 * aggregate object under BOTH identity spellings (id and path), so the
 * map entries are grouped back by aggregate identity - the same
 * object-identity join `usageForRecord` uses - and each group is
 * labelled from the roles the payload `top_artifacts` assign, which the
 * usage map alone cannot distinguish.
 */
function mostRecalled(vault: string): ReadonlyArray<ExplorerConsoleMostRecalled> {
  const signals = deriveUsageSignals(vault);
  const roles = identityRoles(vault);
  const groups = new Map<SourceUsage, Set<string>>();
  for (const [key, usage] of signals) {
    const keys = groups.get(usage) ?? new Set<string>();
    keys.add(key);
    groups.set(usage, keys);
  }
  const entries: ExplorerConsoleMostRecalled[] = [];
  for (const [usage, keys] of groups) {
    let id: string | null = null;
    let path: string | null = null;
    for (const key of keys) {
      if (id === null && roles.ids.has(key)) {
        id = key;
      } else if (path === null && roles.paths.has(key)) {
        path = key;
      } else if (id === null) {
        // A key the roles scan has not seen can only come from a record
        // appended between the two reads of the append-only log; keep it
        // visible as the primary identity rather than dropping the label.
        id = key;
      }
    }
    entries.push({
      id,
      path,
      access_count: usage.accessCount,
      last_access_at: new Date(usage.lastAccessAtMs).toISOString(),
    });
  }
  entries.sort((a, b) => {
    if (a.access_count !== b.access_count) return b.access_count - a.access_count;
    return displayKey(a).localeCompare(displayKey(b));
  });
  return Object.freeze(entries.slice(0, EXPLORER_CONSOLE_MOST_RECALLED_LIMIT));
}

function displayKey(entry: ExplorerConsoleMostRecalled): string {
  return entry.id ?? entry.path ?? "";
}

/** The id and path roles the telemetry payloads themselves assign. */
interface IdentityRoles {
  readonly ids: ReadonlySet<string>;
  readonly paths: ReadonlySet<string>;
}

function identityRoles(vault: string): IdentityRoles {
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const record of listRecallTelemetry(vault)) {
    const artifacts = record.payload["top_artifacts"];
    if (!Array.isArray(artifacts)) continue;
    for (const artifact of artifacts) {
      if (artifact === null || typeof artifact !== "object") continue;
      const entry = artifact as Record<string, unknown>;
      if (typeof entry["id"] === "string" && entry["id"].length > 0) ids.add(entry["id"]);
      if (typeof entry["path"] === "string" && entry["path"].length > 0) paths.add(entry["path"]);
    }
  }
  return { ids, paths };
}

/**
 * Continuity records bucketed per UTC calendar day across the window.
 * Every kind counts - the histogram is about write activity, and every
 * append is a write. Days with no writes are reported as zero rather
 * than left out, so the bucket list is a fixed 30-day axis.
 */
function writtenPerDay(
  vault: string,
  since: string,
  until: string,
  windowDays: ReadonlyArray<string>,
): ReadonlyArray<ExplorerConsoleDayBucket> {
  const counts = new Map<string, number>();
  for (const record of listContinuityRecords(vault, { since, until })) {
    const date = record.createdAt.slice(0, 10);
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  return Object.freeze(
    windowDays.map((date) => Object.freeze({ date, count: counts.get(date) ?? 0 })),
  );
}

/**
 * The latest valid snapshot date per surface. While the feature is off
 * the section is the "disabled" state statement and nothing is read;
 * once on, each `Brain/reports/<surface>/` directory names a surface
 * and the fail-soft reader answers its latest date (a torn file is
 * skipped there, never reported).
 */
function reportSnapshots(
  vault: string,
  now: Date,
  configPath?: string,
): ExplorerConsoleReportSnapshots {
  if (!reportSnapshotsEnabled(configPath)) return Object.freeze({ status: "disabled" });
  const reportsDir = join(brainDirs(vault).brain, "reports");
  const surfaces = existsSync(reportsDir)
    ? readdirSync(reportsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .toSorted()
    : [];
  // Strictly before the day after `now`, matching the delta callers:
  // a snapshot dated today is the latest one the next run can diff against.
  const beforeDate = new Date(now.getTime() + DAY_MS).toISOString().slice(0, 10);
  return Object.freeze({
    status: "ok",
    surfaces: Object.freeze(
      surfaces.map((surface): ExplorerConsoleSnapshotSurface => {
        const latest = loadLatestReportSnapshot(vault, surface, beforeDate);
        return Object.freeze({
          surface,
          latest_date: latest === null ? null : latest.date,
        });
      }),
    ),
  });
}
