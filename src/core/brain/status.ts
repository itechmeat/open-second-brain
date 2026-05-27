/**
 * Brain operational status snapshot.
 *
 * One function: {@link computeBrainStatus} walks `Brain/` and returns
 * counts, last-activity timestamps, and a single sanity flag. Pure
 * read — nothing is mutated, nothing is parsed deeply (we cap I/O at
 * `readdirSync` for counts and one `parseLogDay` per log file for
 * timestamps).
 *
 * Used by:
 *
 *   - the MCP `second_brain_status` tool (extended `brain` field)
 *   - the MCP resource `osb://status` (markdown render)
 *
 * Callers that want the timestamps but not the counts can read either
 * field independently — the shape is shallow.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { parseFrontmatter } from "../vault.ts";
import { brainDirs } from "./paths.ts";
import { parseLogDay } from "./log.ts";
import { loadBrainConfig } from "./policy.ts";
import { parseSignal } from "./signal.ts";
import { BRAIN_LOG_EVENT_KIND, BRAIN_PREFERENCE_STATUS } from "./types.ts";

// ----- Public types --------------------------------------------------------

export interface BrainStatusCounts {
  readonly inbox: number;
  readonly inbox_processed: number;
  readonly preferences: number;
  readonly preferences_by_status: Readonly<Record<string, number>>;
  readonly retired: number;
  readonly log_days: number;
  readonly snapshots: number;
}

export interface BrainStatusSnapshot {
  /** Whether `<vault>/Brain/` exists at all. */
  readonly present: boolean;
  readonly counts: BrainStatusCounts;
  readonly last_dream_at: string | null;
  readonly last_apply_evidence_at: string | null;
  readonly sanity: {
    /**
     * Number of signals in `inbox/` whose `created_at` predates
     * `now - dream.unconfirmed_window_days`. A non-zero value means
     * dream hasn't been run for at least an entire trial window and
     * the signals risk silent expiry.
     */
    readonly signals_awaiting_dream: number;
  };
}

export interface ComputeBrainStatusOptions {
  /** Wall clock for staleness math. Defaults to `new Date()`. */
  readonly now?: Date;
}

// ----- Public API ----------------------------------------------------------

export function computeBrainStatus(
  vault: string,
  opts: ComputeBrainStatusOptions = {},
): BrainStatusSnapshot {
  const dirs = brainDirs(vault);
  if (!existsSync(dirs.brain)) {
    return Object.freeze({
      present: false,
      counts: {
        inbox: 0,
        inbox_processed: 0,
        preferences: 0,
        preferences_by_status: Object.freeze({}),
        retired: 0,
        log_days: 0,
        snapshots: 0,
      },
      last_dream_at: null,
      last_apply_evidence_at: null,
      sanity: { signals_awaiting_dream: 0 },
    });
  }

  const counts = countArtifacts(vault);
  const { lastDreamAt, lastApplyEvidenceAt } = scanLogTimestamps(vault);
  const signalsAwaitingDream = countSignalsAwaitingDream(vault, opts.now ?? new Date());

  return Object.freeze({
    present: true,
    counts,
    last_dream_at: lastDreamAt,
    last_apply_evidence_at: lastApplyEvidenceAt,
    sanity: Object.freeze({ signals_awaiting_dream: signalsAwaitingDream }),
  });
}

// ----- Implementation ------------------------------------------------------

function countArtifacts(vault: string): BrainStatusCounts {
  const dirs = brainDirs(vault);
  const inbox = countMd(dirs.inbox);
  const inbox_processed = countMd(dirs.processed);
  const retired = countMd(dirs.retired);
  const log_days = countMd(dirs.log);
  const snapshots = countZst(dirs.snapshots);

  // Per-status preference counts: read frontmatter line `status:` only
  // — no full parse — to keep this cheap. Unknown values bucket under
  // `unknown` so the doctor's parse errors are still visible upstream.
  const preferences_by_status: Record<string, number> = {};
  let preferences = 0;
  if (existsSync(dirs.preferences)) {
    for (const name of readdirSync(dirs.preferences)) {
      if (!name.endsWith(".md")) continue;
      if (!name.startsWith("pref-")) continue;
      preferences++;
      const status = readFrontmatterStatus(`${dirs.preferences}/${name}`);
      preferences_by_status[status] = (preferences_by_status[status] ?? 0) + 1;
    }
  }
  // Always include the canonical bucket names with 0 so consumers
  // don't need to defensively `?? 0`.
  for (const s of Object.values(BRAIN_PREFERENCE_STATUS)) {
    preferences_by_status[s] = preferences_by_status[s] ?? 0;
  }

  return {
    inbox,
    inbox_processed,
    preferences,
    preferences_by_status: Object.freeze(preferences_by_status),
    retired,
    log_days,
    snapshots,
  };
}

function countMd(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".md")) n++;
  }
  return n;
}

function countZst(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".tar.zst")) n++;
  }
  return n;
}

function readFrontmatterStatus(path: string): string {
  // Use the canonical frontmatter parser instead of a regex sniff so
  // quoted values (`_status: "confirmed"`) and other legal YAML
  // shapes round-trip correctly. Files we can't parse bucket under
  // `unknown` — doctor surfaces them as schema errors elsewhere.
  try {
    const [meta] = parseFrontmatter(path);
    const value = meta["_status"];
    if (typeof value !== "string") return "unknown";
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : "unknown";
  } catch {
    return "unknown";
  }
}

function scanLogTimestamps(vault: string): {
  lastDreamAt: string | null;
  lastApplyEvidenceAt: string | null;
} {
  const dirs = brainDirs(vault);
  if (!existsSync(dirs.log)) return { lastDreamAt: null, lastApplyEvidenceAt: null };
  const days = readdirSync(dirs.log)
    .filter((n) => n.endsWith(".md") && /^\d{4}-\d{2}-\d{2}\.md$/.test(n))
    .map((n) => n.slice(0, -".md".length))
    .toSorted()
    .toReversed(); // newest day first

  let lastDreamAt: string | null = null;
  let lastApplyEvidenceAt: string | null = null;
  for (const date of days) {
    // We only need the most-recent timestamp of each kind, so once
    // both are set we can stop scanning older files.
    let entries;
    try {
      entries = parseLogDay(vault, date).entries;
    } catch {
      continue;
    }
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!;
      if (lastDreamAt === null && e.eventType === BRAIN_LOG_EVENT_KIND.dream) {
        lastDreamAt = e.timestamp;
      }
      if (lastApplyEvidenceAt === null && e.eventType === BRAIN_LOG_EVENT_KIND.applyEvidence) {
        lastApplyEvidenceAt = e.timestamp;
      }
      if (lastDreamAt !== null && lastApplyEvidenceAt !== null) break;
    }
    if (lastDreamAt !== null && lastApplyEvidenceAt !== null) break;
  }
  return { lastDreamAt, lastApplyEvidenceAt };
}

function countSignalsAwaitingDream(vault: string, now: Date): number {
  const dirs = brainDirs(vault);
  if (!existsSync(dirs.inbox)) return 0;
  let windowDays: number;
  try {
    windowDays = loadBrainConfig(vault).dream.unconfirmed_window_days;
  } catch {
    return 0; // Config absent: doctor will flag; status reports 0.
  }
  const cutoffMs = now.getTime() - windowDays * 24 * 3600 * 1000;
  let stale = 0;
  for (const name of readdirSync(dirs.inbox)) {
    if (!name.endsWith(".md")) continue;
    if (!name.startsWith("sig-")) continue;
    // Read the authoritative `created_at` from frontmatter — filename
    // is a hint but the timestamp is the source of truth (slug
    // collisions and manual `mv` operations can desync the two).
    let createdAtMs: number;
    try {
      createdAtMs = Date.parse(parseSignal(join(dirs.inbox, name)).created_at);
    } catch {
      continue; // Unparseable signal — doctor's domain, not status's.
    }
    if (!Number.isFinite(createdAtMs)) continue;
    if (createdAtMs < cutoffMs) stale++;
  }
  return stale;
}
