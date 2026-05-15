/**
 * Read-only query helpers over Brain state (design doc §9.2).
 *
 * Three callable shapes, all returning frozen result objects so the
 * surfaces consuming them (CLI `o2b brain query`, MCP `brain_query`,
 * future agent introspection) cannot accidentally mutate vault state:
 *
 *   - {@link queryByPreference} — one preference (active or retired)
 *     plus every `apply-evidence` log entry that references it.
 *
 *   - {@link queryByTopic} — every signal under a topic (active +
 *     processed), the current preference for that topic (active or
 *     retired), and every log entry mentioning the preference.
 *
 *   - {@link queryByLogSince} — every log entry across all days whose
 *     `timestamp >= since`. Cron / digest / debugging entry point.
 *
 * All three are pure reads. They do not touch the inbox `processed/`
 * holding area, the snapshots/, or the `_brain.yaml` config — those are
 * dream's job.
 *
 * Wikilink resolution rule: a preference is "referenced" by a log entry
 * when the entry's `preference` payload contains either the bare id or
 * the `[[id]]` wikilink form. We strip both forms so a hand-typed entry
 * (`preference: pref-foo`) and a properly-rendered entry
 * (`preference: [[pref-foo]]`) both match.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { brainDirs } from "./paths.ts";
import { parseLogDay, type BrainLogEntry } from "./log.ts";
import { parsePreference, parseRetired } from "./preference.ts";
import { parseSignal } from "./signal.ts";
import { normaliseWikilinkTarget } from "./wikilink.ts";
import { BRAIN_LOG_EVENT_KIND } from "./types.ts";
import type {
  BrainPreference,
  BrainRetired,
  BrainSignal,
} from "./types.ts";

// ----- Errors ---------------------------------------------------------------

/**
 * Raised when {@link queryByPreference} is asked for a `pref-` id (or
 * `ret-` id) that resolves to no file in either `preferences/` or
 * `retired/`. The CLI translates this to exit code `2` per design doc
 * §9.2 "not an error condition".
 */
export class BrainNotFoundError extends Error {
  readonly id: string;

  constructor(id: string) {
    super(`brain query: no preference or retired entry found for id '${id}'`);
    this.name = "BrainNotFoundError";
    this.id = id;
  }
}

// ----- Result shapes --------------------------------------------------------

export interface QueryByPreferenceResult {
  /** The active preference (`preferences/`) or retired one (`retired/`). */
  readonly preference: BrainPreference | BrainRetired;
  /**
   * Every `apply-evidence` log entry referencing this preference,
   * sorted ascending by `timestamp`. Empty when the preference exists
   * but has never been applied (common for freshly-promoted
   * unconfirmed entries).
   */
  readonly evidence: ReadonlyArray<BrainLogEntry>;
}

export interface QueryByTopicResult {
  /**
   * All signals for the topic — active (`inbox/sig-*.md`) and processed
   * (`inbox/processed/sig-*.md`). Sorted by `created_at` ascending so
   * the caller sees a chronological trail.
   */
  readonly signals: ReadonlyArray<BrainSignal>;
  /**
   * The current state of the topic's rule:
   *   - active preference if one exists in `preferences/`
   *   - retired preference if one exists in `retired/`
   *   - null if the topic has signals but never reached promotion
   *
   * A topic can plausibly have *both* an active and a retired entry
   * (the active rule supersedes a prior retired one). In that case we
   * return the active version — it is the current truth — and the
   * caller can find the historical retired one via `queryByPreference`
   * by id.
   */
  readonly preference: BrainPreference | BrainRetired | null;
  /**
   * Every log entry mentioning the topic's preference id. Sorted by
   * `timestamp` ascending. Includes `apply-evidence`, `promote`,
   * `retire`, `pin` / `unpin`, etc. — anything whose `preference`
   * payload field resolves to the same id.
   */
  readonly all_log_events: ReadonlyArray<BrainLogEntry>;
}

// ----- Public API -----------------------------------------------------------

/**
 * Look up one preference (active or retired) and its evidence trail.
 *
 * Resolution rules:
 *   - A `pref-...` id is searched in `preferences/`. If absent, we also
 *     accept a fallback to `retired/ret-<slug>` (same slug stem) so an
 *     agent that asked for the active id of a now-retired preference
 *     still gets a useful answer.
 *   - A `ret-...` id is searched in `retired/` only.
 *   - Any other prefix raises {@link BrainNotFoundError} immediately.
 */
export function queryByPreference(
  vault: string,
  pref_id: string,
): QueryByPreferenceResult {
  const id = pref_id.trim();
  if (!id) {
    throw new BrainNotFoundError(pref_id);
  }
  const dirs = brainDirs(vault);
  let preference: BrainPreference | BrainRetired | null = null;

  if (id.startsWith("pref-")) {
    const activePath = join(dirs.preferences, `${id}.md`);
    if (existsSync(activePath)) {
      preference = parsePreference(activePath);
    } else {
      // Fallback to the retired version with the same slug stem.
      const slug = id.slice("pref-".length);
      const retiredPathCandidate = join(dirs.retired, `ret-${slug}.md`);
      if (existsSync(retiredPathCandidate)) {
        preference = parseRetired(retiredPathCandidate);
      }
    }
  } else if (id.startsWith("ret-")) {
    const retiredPathCandidate = join(dirs.retired, `${id}.md`);
    if (existsSync(retiredPathCandidate)) {
      preference = parseRetired(retiredPathCandidate);
    }
  } else {
    throw new BrainNotFoundError(pref_id);
  }

  if (!preference) {
    throw new BrainNotFoundError(pref_id);
  }

  // The evidence trail is keyed off the active id (`pref-<slug>`) — the
  // log records `preference: [[pref-<slug>]]` even after retirement.
  const slug = preference.id.startsWith("pref-")
    ? preference.id.slice("pref-".length)
    : preference.id.slice("ret-".length);
  const matchIds = new Set<string>([`pref-${slug}`, `ret-${slug}`]);

  const all = readAllLogEntries(vault);
  const evidence = all
    .filter(
      (e) =>
        e.eventType === BRAIN_LOG_EVENT_KIND.applyEvidence &&
        matchPreferencePayload(e.body["preference"], matchIds),
    )
    .sort(byTimestampAsc);

  return Object.freeze({
    preference,
    evidence: Object.freeze(evidence),
  });
}

/**
 * Aggregate every artifact under a topic. Includes signals across both
 * `inbox/` and `inbox/processed/`, the current rule (active or
 * retired), and every log entry mentioning the preference id (active
 * or retired form). Unknown topic → empty result with `preference: null`.
 */
export function queryByTopic(
  vault: string,
  topic: string,
): QueryByTopicResult {
  const want = topic.trim();
  if (!want) {
    return Object.freeze({
      signals: Object.freeze([]),
      preference: null,
      all_log_events: Object.freeze([]),
    });
  }

  const dirs = brainDirs(vault);
  const signals: BrainSignal[] = [];

  // Collect signals from both inbox/ and inbox/processed/. We do not
  // recurse — `inbox/processed/` is the only allowed sub-folder of
  // `inbox/` and `readdirSync` with `withFileTypes` lets us pick file
  // vs directory entries deterministically.
  collectSignals(dirs.inbox, want, signals);
  collectSignals(dirs.processed, want, signals);
  signals.sort((a, b) => a.created_at.localeCompare(b.created_at));

  // Current rule — prefer the active preference; fall back to retired.
  let preference: BrainPreference | BrainRetired | null = null;
  preference = findPreferenceForTopic(dirs.preferences, want, "preference");
  if (!preference) {
    preference = findPreferenceForTopic(dirs.retired, want, "retired");
  }

  // All log events whose `preference` payload resolves to the topic's
  // pref id (both `pref-` and `ret-` forms, since the slug stem is
  // shared after retirement).
  let all_log_events: ReadonlyArray<BrainLogEntry> = Object.freeze([]);
  if (preference) {
    const slug = preference.id.startsWith("pref-")
      ? preference.id.slice("pref-".length)
      : preference.id.slice("ret-".length);
    const matchIds = new Set<string>([`pref-${slug}`, `ret-${slug}`]);
    const all = readAllLogEntries(vault);
    all_log_events = Object.freeze(
      all
        .filter((e) => matchPreferencePayload(e.body["preference"], matchIds))
        .sort(byTimestampAsc),
    );
  }

  return Object.freeze({
    signals: Object.freeze(signals),
    preference,
    all_log_events,
  });
}

/**
 * Return every log entry across `Brain/log/*.md` whose `timestamp` is
 * `>= since` (inclusive lower bound — same semantics as the digest's
 * window). Entries are returned in chronological order. Malformed log
 * entries are silently skipped (their warnings are the doctor's
 * concern, not this surface's).
 */
export function queryByLogSince(
  vault: string,
  since: Date,
): ReadonlyArray<BrainLogEntry> {
  if (!(since instanceof Date) || Number.isNaN(since.getTime())) {
    throw new TypeError("queryByLogSince: `since` must be a valid Date");
  }
  const sinceIso = since.toISOString();
  const entries = readAllLogEntries(vault).filter(
    (e) => e.timestamp >= sinceIso,
  );
  entries.sort(byTimestampAsc);
  return Object.freeze(entries);
}

// ----- Internals ------------------------------------------------------------

/**
 * Read every log file under `Brain/log/`, parse it via {@link parseLogDay},
 * and concatenate the entries in chronological order (each file is
 * already in-order; we glue them by date prefix). Missing log directory
 * → empty array.
 */
export function readAllLogEntries(vault: string): BrainLogEntry[] {
  const dirs = brainDirs(vault);
  if (!existsSync(dirs.log)) return [];
  const names = readdirSync(dirs.log, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".md"))
    .map((d) => d.name.slice(0, -".md".length))
    .filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n))
    .sort();
  const out: BrainLogEntry[] = [];
  for (const date of names) {
    const { entries } = parseLogDay(vault, date);
    for (const e of entries) out.push(e);
  }
  return out;
}

function collectSignals(
  dir: string,
  topic: string,
  out: BrainSignal[],
): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith("sig-") || !entry.name.endsWith(".md")) {
      continue;
    }
    let sig: BrainSignal;
    try {
      sig = parseSignal(join(dir, entry.name));
    } catch {
      // Corrupted frontmatter is the doctor's concern; queries skip.
      continue;
    }
    if (sig.topic === topic) out.push(sig);
  }
}

function findPreferenceForTopic(
  dir: string,
  topic: string,
  kind: "preference" | "retired",
): BrainPreference | BrainRetired | null {
  if (!existsSync(dir)) return null;
  const prefix = kind === "preference" ? "pref-" : "ret-";
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith(prefix) || !entry.name.endsWith(".md")) {
      continue;
    }
    const path = join(dir, entry.name);
    try {
      const parsed =
        kind === "preference" ? parsePreference(path) : parseRetired(path);
      if (parsed.topic === topic) return parsed;
    } catch {
      // Doctor's job, not query's.
      continue;
    }
  }
  return null;
}

/**
 * The `preference` payload field of an `apply-evidence` (or `promote`,
 * `retire`, …) log entry is typically a wikilink (`[[pref-foo]]`) but
 * we tolerate the bare id form and even a sub-path/alias suffix. Strip
 * brackets, drop everything after `|` or `#`, then compare against the
 * caller's set of allowed ids.
 */
function matchPreferencePayload(
  payload: string | ReadonlyArray<string> | undefined,
  matchIds: ReadonlySet<string>,
): boolean {
  if (payload === undefined) return false;
  const values = Array.isArray(payload) ? payload : [payload as string];
  for (const v of values) {
    const id = normaliseWikilinkTarget(v);
    if (id && matchIds.has(id)) return true;
  }
  return false;
}

function byTimestampAsc(a: BrainLogEntry, b: BrainLogEntry): number {
  return a.timestamp.localeCompare(b.timestamp);
}
