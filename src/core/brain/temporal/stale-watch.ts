/**
 * `findStaleEntries(index, vault, cfg, opts)` - reports preferences,
 * signals, and log files that have been idle past their configured
 * threshold.
 *
 * The TimelineIndex contributes the most-recent event timestamp per
 * preference - that's the canonical staleness anchor (more accurate
 * than `last_evidence_at` on disk, which lags behind the dream pass).
 * Falls back to the file's own `last_evidence_at` / `created_at` when
 * no event is on the timeline.
 *
 * Design anchor: `docs/brainstorm/temporal-synthesis/design.md`,
 * Task 5 in `plan.md`.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { brainDirs } from "./../paths.ts";
import { parsePreference } from "./../preference.ts";
import { parseSignal } from "./../signal.ts";
import type { ResolvedBrainTemporalConfig } from "./../types.ts";
import type { TimelineIndex } from "./types.ts";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export interface FindStaleEntriesOptions {
  /** Wall clock; defaults to `new Date()`. */
  readonly now?: Date;
}

export interface StalePreferenceRow {
  readonly prefId: string;
  readonly topic: string;
  readonly path: string;
  /** ISO timestamp of the most-recent event used as the staleness anchor. */
  readonly lastSeenAt: string;
  /** Whole days between `lastSeenAt` and `now`. */
  readonly ageDays: number;
}

export interface StaleSignalRow {
  readonly signalId: string;
  readonly topic: string;
  readonly path: string;
  readonly lastSeenAt: string;
  readonly ageDays: number;
}

export interface StaleLogFileRow {
  readonly path: string;
  readonly mtime: string;
  readonly ageDays: number;
}

export interface StaleWatchEnvelope {
  readonly stalePreferences: ReadonlyArray<StalePreferenceRow>;
  readonly staleSignals: ReadonlyArray<StaleSignalRow>;
  readonly staleLogFiles: ReadonlyArray<StaleLogFileRow>;
  readonly thresholds: ResolvedBrainTemporalConfig;
  readonly generatedAt: string;
}

export function findStaleEntries(
  index: TimelineIndex,
  vault: string,
  cfg: ResolvedBrainTemporalConfig,
  opts: FindStaleEntriesOptions = {},
): StaleWatchEnvelope {
  const now = opts.now ?? new Date();
  const generatedAt = now.toISOString();
  const nowMs = now.getTime();
  return Object.freeze({
    stalePreferences: Object.freeze(
      scanPreferences(index, vault, cfg.stale_pref_days, nowMs),
    ),
    staleSignals: Object.freeze(
      scanSignals(vault, cfg.stale_signal_days, nowMs),
    ),
    staleLogFiles: Object.freeze(
      scanLogFiles(vault, cfg.stale_log_days, nowMs),
    ),
    thresholds: cfg,
    generatedAt,
  });
}

function scanPreferences(
  index: TimelineIndex,
  vault: string,
  thresholdDays: number,
  nowMs: number,
): StalePreferenceRow[] {
  const out: StalePreferenceRow[] = [];
  const dirs = brainDirs(vault);
  if (!existsSync(dirs.preferences)) return out;
  for (const entry of readdirSync(dirs.preferences, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    if (!entry.name.startsWith("pref-")) continue;
    const path = join(dirs.preferences, entry.name);
    let pref;
    try {
      pref = parsePreference(path);
    } catch {
      continue;
    }
    const lastSeenAt = mostRecentEventAt(index, pref.id) ??
      pref.last_evidence_at ?? pref.created_at;
    const ageDays = computeAgeDays(lastSeenAt, nowMs);
    if (ageDays === undefined) continue;
    if (ageDays < thresholdDays) continue;
    out.push(
      Object.freeze({
        prefId: pref.id,
        topic: pref.topic,
        path: relative(vault, path),
        lastSeenAt,
        ageDays,
      }),
    );
  }
  out.sort((a, b) => b.ageDays - a.ageDays);
  return out;
}

function scanSignals(
  vault: string,
  thresholdDays: number,
  nowMs: number,
): StaleSignalRow[] {
  const out: StaleSignalRow[] = [];
  const dirs = brainDirs(vault);
  if (!existsSync(dirs.inbox)) return out;
  for (const entry of readdirSync(dirs.inbox, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    if (!entry.name.startsWith("sig-")) continue;
    const path = join(dirs.inbox, entry.name);
    let signal;
    try {
      signal = parseSignal(path);
    } catch {
      continue;
    }
    const ageDays = computeAgeDays(signal.created_at, nowMs);
    if (ageDays === undefined) continue;
    if (ageDays < thresholdDays) continue;
    out.push(
      Object.freeze({
        signalId: signal.id,
        topic: signal.topic,
        path: relative(vault, path),
        lastSeenAt: signal.created_at,
        ageDays,
      }),
    );
  }
  out.sort((a, b) => b.ageDays - a.ageDays);
  return out;
}

function scanLogFiles(
  vault: string,
  thresholdDays: number,
  nowMs: number,
): StaleLogFileRow[] {
  const out: StaleLogFileRow[] = [];
  const dirs = brainDirs(vault);
  if (!existsSync(dirs.log)) return out;
  for (const entry of readdirSync(dirs.log, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".jsonl") && !entry.name.endsWith(".md")) continue;
    const path = join(dirs.log, entry.name);
    const st = statSync(path);
    const mtimeMs = st.mtimeMs;
    const ageDays = Math.floor((nowMs - mtimeMs) / ONE_DAY_MS);
    if (ageDays < thresholdDays) continue;
    out.push(
      Object.freeze({
        path: relative(vault, path),
        mtime: new Date(mtimeMs).toISOString(),
        ageDays,
      }),
    );
  }
  out.sort((a, b) => b.ageDays - a.ageDays);
  return out;
}

function mostRecentEventAt(
  index: TimelineIndex,
  prefId: string,
): string | undefined {
  const events = index.eventsByPrefId.get(prefId);
  if (events === undefined || events.length === 0) return undefined;
  // events is sorted ascending; last element is most recent.
  return events[events.length - 1]!.at;
}

/**
 * Compute whole-day age between an anchor timestamp and `now`.
 * Returns `undefined` when the anchor is unparseable so the caller
 * can skip the row instead of emitting a `NaN` `ageDays`.
 */
function computeAgeDays(anchorIso: string, nowMs: number): number | undefined {
  const ms = Date.parse(anchorIso);
  if (!Number.isFinite(ms)) return undefined;
  return Math.floor((nowMs - ms) / ONE_DAY_MS);
}
