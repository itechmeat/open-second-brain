/**
 * Brain operational status snapshot.
 *
 * One function: {@link computeBrainStatus} walks `Brain/` and returns
 * counts, last-activity timestamps, a `maintenance_debt` block, and a
 * single sanity flag. Pure read — nothing is mutated, nothing is parsed
 * deeply (we cap I/O at `readdirSync` for counts and one `parseLogDay`
 * per log file for timestamps and for the debt count).
 *
 * Used by:
 *
 *   - the MCP `second_brain_status` tool (extended `brain` field)
 *   - the MCP resource `osb://status` (markdown render)
 *   - the MCP `brain_context` tool, which reads only the cheap, bounded
 *     `computeMaintenanceOverdueFlag` below — never this whole function
 *     — because it is the always-loaded reader (see that function's
 *     docblock for the cost bound).
 *
 * Callers that want the timestamps but not the counts can read either
 * field independently — the shape is shallow.
 *
 * ## `maintenance_debt` (nothing-writes-silently, Unit D)
 *
 * DERIVED, not counted: there is no write-time counter and no
 * STATE_SURFACES row backing this block. It is recomputed on every
 * call from the same `Brain/log/` JSONL shards `scanLogTimestamps`
 * already reads to find `last_dream_at`, so it cannot desync from the
 * log and carries no write-path coupling.
 *
 * The field is named `log_events_since_dream`, not `writes_since_dream`,
 * because that is what it measures and nothing more. `write-batch.ts`
 * — the executor behind `brain_create_note`, `brain_update_note`,
 * `brain_append_note`, and the note ops of `brain_write_batch` — never
 * calls `appendLogEvent`; a caller-named note write leaves no log event
 * to count. Calling this field "writes since dream" would be a false
 * label on a true number, which is exactly the dishonesty this wave
 * removes. It counts Brain LOG events (dream/feedback/apply-evidence/
 * retire/promote/… — the full {@link BRAIN_LOG_EVENT_KIND} vocabulary),
 * a real and useful signal of unreviewed lifecycle activity, just not
 * the one its old provisional name would have implied.
 *
 * Two fields the card asked for are deliberately absent, not forgotten:
 *
 *   - `open_conflicts` needs a semantic-health run
 *     (`health/reconcile.ts`) to produce a `SemanticHealthReport`; that
 *     report is not already computed on this path and running it here
 *     would make every `second_brain_status` call pay for a health
 *     pass. Measured too expensive for a status snapshot; callers that
 *     want it run `brain_health` / the reconcile report directly.
 *   - `pending_triggers` was investigated against
 *     `src/core/brain/triggers/store.ts`. Its only readers,
 *     `readTriggers`/`listTriggers`, fully parse frontmatter AND every
 *     body section of EVERY `.md` file under `Brain/triggers/` before a
 *     status filter is even applied — there is no status-only or
 *     count-only accessor — and terminal triggers (acted / dismissed /
 *     expired / suppressed) are never pruned from that directory, so
 *     the read cost grows with the vault's entire trigger history, not
 *     with the currently-open count. Not the cheap count this block
 *     requires; measured too expensive, not forgotten.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { parseFrontmatter } from "../vault.ts";
import { brainDirs } from "./paths.ts";
import { listLogDates, readLogDay } from "./log-jsonl.ts";
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

/**
 * Whether `log_events_since_dream` is counted against a real dream
 * boundary or reports the whole log because no boundary exists yet.
 * `never_dreamed` is a distinct state from "zero events" — see the
 * module docblock.
 */
export const MAINTENANCE_DEBT_STATUS = Object.freeze({
  neverDreamed: "never_dreamed",
  counted: "counted",
} as const);

export type MaintenanceDebtStatus =
  (typeof MAINTENANCE_DEBT_STATUS)[keyof typeof MAINTENANCE_DEBT_STATUS];

/** See the "`maintenance_debt`" section of this module's docblock. */
export interface MaintenanceDebt {
  readonly status: MaintenanceDebtStatus;
  readonly log_events_since_dream: number;
}

const NEVER_DREAMED_DEBT: MaintenanceDebt = Object.freeze({
  status: MAINTENANCE_DEBT_STATUS.neverDreamed,
  log_events_since_dream: 0,
});

export interface BrainStatusSnapshot {
  /** Whether `<vault>/Brain/` exists at all. */
  readonly present: boolean;
  readonly counts: BrainStatusCounts;
  readonly last_dream_at: string | null;
  readonly last_apply_evidence_at: string | null;
  readonly maintenance_debt: MaintenanceDebt;
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
      maintenance_debt: NEVER_DREAMED_DEBT,
      sanity: { signals_awaiting_dream: 0 },
    });
  }

  const counts = countArtifacts(vault);
  const { lastDreamAt, lastApplyEvidenceAt } = scanLogTimestamps(vault);
  const signalsAwaitingDream = countSignalsAwaitingDream(vault, opts.now ?? new Date());
  const maintenanceDebt = computeMaintenanceDebt(vault, lastDreamAt);

  return Object.freeze({
    present: true,
    counts,
    last_dream_at: lastDreamAt,
    last_apply_evidence_at: lastApplyEvidenceAt,
    maintenance_debt: maintenanceDebt,
    sanity: Object.freeze({ signals_awaiting_dream: signalsAwaitingDream }),
  });
}

/**
 * Cheap, bounded proxy for `maintenance_debt` fit for the always-loaded
 * `brain_context` path.
 *
 * Cost bound: at most one {@link listLogDates} call (a `readdirSync` of
 * `Brain/log/` plus filename parsing — no file content is read) and, if
 * any date exists, one {@link readLogDay} call for the SINGLE newest
 * date. That is O(1) in the number of log days regardless of how much
 * history the vault holds — `computeMaintenanceDebt` below, in
 * contrast, walks every day at or after `last_dream_at` (all of them,
 * for a never-dreamed vault) and MUST NOT run on this path.
 *
 * Returns `null` when there is no log history yet, or when the newest
 * day's shard(s) exist but could not be read — both are "unknown",
 * never a false `false`. Returns `true` when the newest log day has at
 * least one event and none of them is a `dream` event, `false` when it
 * has a `dream` event. This is a same-day signal only: a vault that
 * dreamed yesterday and logged something unrelated today still reads
 * `true`. Callers that need the precise count read
 * `maintenance_debt.log_events_since_dream` from `computeBrainStatus`
 * instead (`second_brain_status` / `osb://status`).
 */
export function computeMaintenanceOverdueFlag(vault: string): boolean | null {
  const dates = listLogDates(vault);
  const newest = dates.at(-1);
  if (newest === undefined) return null;
  let entries;
  try {
    entries = readLogDay(vault, newest).entries;
  } catch {
    // Same tolerance as `scanLogTimestamps`: an unreadable day is
    // reported as unknown, not silently folded into a boolean answer.
    return null;
  }
  return !entries.some((e) => e.eventType === BRAIN_LOG_EVENT_KIND.dream);
}

// ----- Implementation ------------------------------------------------------

function countArtifacts(vault: string): BrainStatusCounts {
  const dirs = brainDirs(vault);
  const inbox = countMd(dirs.inbox);
  const inbox_processed = countMd(dirs.processed);
  const retired = countMd(dirs.retired);
  // Shard-aware: count distinct DAYS, not files (several shards share a day).
  const log_days = listLogDates(vault).length;
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
  const days = listLogDates(vault).toReversed(); // newest day first

  let lastDreamAt: string | null = null;
  let lastApplyEvidenceAt: string | null = null;
  for (const date of days) {
    // We only need the most-recent timestamp of each kind, so once
    // both are set we can stop scanning older files.
    let entries;
    try {
      entries = readLogDay(vault, date).entries;
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

/**
 * Derive `maintenance_debt` from the JSONL log shards, AFTER
 * `last_dream_at` has already been resolved by {@link scanLogTimestamps}.
 * No stored counter, no STATE_SURFACES row — see the module docblock.
 *
 * `lastDreamAt === null` (never dreamed) counts every event ever
 * logged, because there is no dream boundary to count "since". A real
 * `last_dream_at` counts only events with a strictly later timestamp —
 * the dream event itself is the boundary, not a countable event — and
 * walks days newest-first, stopping as soon as a day predates the
 * dream's own day, so the scan is bounded to "since the last dream",
 * not the whole log history, on every vault that HAS dreamed.
 */
function computeMaintenanceDebt(vault: string, lastDreamAt: string | null): MaintenanceDebt {
  const dirs = brainDirs(vault);
  if (!existsSync(dirs.log)) return NEVER_DREAMED_DEBT;

  const cutoffMs = lastDreamAt !== null ? Date.parse(lastDreamAt) : null;
  const cutoffDate = lastDreamAt !== null ? lastDreamAt.slice(0, 10) : null;
  const days = listLogDates(vault).toReversed(); // newest day first

  let count = 0;
  for (const date of days) {
    // Every earlier day is entirely pre-dream once we're past the
    // dream's own day — no need to open its shards at all.
    if (cutoffDate !== null && date < cutoffDate) break;
    let entries;
    try {
      entries = readLogDay(vault, date).entries;
    } catch {
      continue; // Same tolerance as scanLogTimestamps: skip, don't abort.
    }
    for (const e of entries) {
      if (cutoffMs !== null) {
        const ts = Date.parse(e.timestamp);
        if (!Number.isFinite(ts) || ts <= cutoffMs) continue;
      }
      count++;
    }
  }

  return Object.freeze({
    status:
      lastDreamAt === null ? MAINTENANCE_DEBT_STATUS.neverDreamed : MAINTENANCE_DEBT_STATUS.counted,
    log_events_since_dream: count,
  });
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
