/**
 * `buildTimelineIndex(vault, opts)` - the single disk-touching helper
 * in the temporal subsystem.
 *
 * Walks `Brain/log/<YYYY-MM-DD>.jsonl` (via the public `readLogDay`
 * reader, which prefers JSONL with a Markdown fallback) for every date
 * intersecting the requested window. Also walks `Brain/retired/*.md`
 * frontmatter to emit synthetic `retire` events at each retired
 * entry's `retired_at` timestamp. Returns a frozen `TimelineIndex` so
 * all downstream projections (`selectEvents`, `buildBeliefEvolution`,
 * `findStaleEntries`, `buildDailyBrief`, `buildWeeklySynthesis`)
 * observe the same window semantics.
 *
 * Design anchor: `docs/brainstorm/temporal-synthesis/design.md`,
 * Task 2 in `docs/brainstorm/temporal-synthesis/plan.md`.
 */

import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import type { BrainLogEntry } from "./../log.ts";
import { readLogDay } from "./../log-jsonl.ts";
import { brainDirs } from "./../paths.ts";
import { parseFrontmatter } from "../../vault.ts";
import { parseWikilink } from "./../wikilink.ts";
import {
  BRAIN_APPLY_RESULT,
  BRAIN_LOG_EVENT_KIND,
  type BrainApplyResult,
  type BrainLogEventKind,
} from "./../types.ts";
import type {
  TemporalEvent,
  TemporalEventSource,
  TimelineIndex,
  TimelineWindow,
} from "./types.ts";

/** Input shape for {@link buildTimelineIndex}. */
export interface BuildTimelineIndexOptions {
  /**
   * Inclusive lower bound. Accepts an ISO date (`YYYY-MM-DD` -
   * interpreted as `T00:00:00Z`) or a full ISO timestamp. Default:
   * `1970-01-01T00:00:00Z`.
   */
  readonly since?: string;
  /**
   * Exclusive upper bound. Accepts an ISO date (interpreted as
   * `T00:00:00Z`) or a full ISO timestamp. Default: one millisecond
   * past `Date.now()`.
   */
  readonly until?: string;
  /** Wall clock; defaults to `new Date()`. Used to derive the default `until`. */
  readonly now?: Date;
}

const ISO_DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_PREFIX_RE = /^\d{4}-\d{2}-\d{2}/;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Build the timeline index. Pure single-pass scan; the resulting index
 * is frozen and every nested array / map is frozen.
 */
export function buildTimelineIndex(
  vault: string,
  opts: BuildTimelineIndexOptions = {},
): TimelineIndex {
  const window = resolveWindow(opts);

  const events: TemporalEvent[] = [];
  collectLogEvents(vault, window, events);
  collectRetiredEvents(vault, window, events);

  events.sort(compareEvents);

  const byKind = new Map<BrainLogEventKind, TemporalEvent[]>();
  const byPrefId = new Map<string, TemporalEvent[]>();
  const byTopic = new Map<string, TemporalEvent[]>();
  for (const ev of events) {
    pushToMap(byKind, ev.kind, ev);
    if (ev.prefId !== undefined) pushToMap(byPrefId, ev.prefId, ev);
    if (ev.topic !== undefined) pushToMap(byTopic, ev.topic, ev);
  }

  return Object.freeze({
    events: Object.freeze(events.slice()),
    eventsByKind: freezeMap(byKind),
    eventsByPrefId: freezeMap(byPrefId),
    eventsByTopic: freezeMap(byTopic),
    window,
  });
}

function pushToMap<K, V>(m: Map<K, V[]>, key: K, value: V): void {
  const bucket = m.get(key);
  if (bucket === undefined) {
    m.set(key, [value]);
  } else {
    bucket.push(value);
  }
}

function freezeMap<K, V>(
  m: Map<K, V[]>,
): ReadonlyMap<K, ReadonlyArray<V>> {
  const out = new Map<K, ReadonlyArray<V>>();
  for (const [k, v] of m) {
    out.set(k, Object.freeze(v));
  }
  return out;
}

function compareEvents(a: TemporalEvent, b: TemporalEvent): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  if (a.source.path !== b.source.path) {
    return a.source.path < b.source.path ? -1 : 1;
  }
  const la = a.source.line ?? -1;
  const lb = b.source.line ?? -1;
  return la - lb;
}

function resolveWindow(opts: BuildTimelineIndexOptions): TimelineWindow {
  const sinceRaw = opts.since;
  const untilRaw = opts.until;
  const now = opts.now ?? new Date();
  const since = sinceRaw !== undefined ? expandDate(sinceRaw) : "1970-01-01T00:00:00Z";
  const until =
    untilRaw !== undefined
      ? expandDate(untilRaw)
      : new Date(now.getTime() + 1).toISOString();
  return Object.freeze({ since, until });
}

function expandDate(value: string): string {
  return ISO_DATE_ONLY_RE.test(value) ? `${value}T00:00:00Z` : value;
}

function dateKeyFromIso(iso: string): string {
  const m = ISO_DATE_PREFIX_RE.exec(iso);
  return m === null ? iso.slice(0, 10) : m[0];
}

function addDays(day: string, delta: number): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(t)) return day;
  return new Date(t + delta * ONE_DAY_MS).toISOString().slice(0, 10);
}

function collectLogEvents(
  vault: string,
  window: TimelineWindow,
  out: TemporalEvent[],
): void {
  const logDir = brainDirs(vault).log;
  if (!existsSync(logDir)) return;
  const sinceDay = dateKeyFromIso(window.since);
  const untilDay = dateKeyFromIso(window.until);
  // Err permissive by one day on each side (timezone safety - the
  // same convention `digest.ts:readLogsInWindow` uses).
  const lowerBound = addDays(sinceDay, -1);
  const upperBound = addDays(untilDay, 1);
  const dates = new Set<string>();
  for (const entry of readdirSync(logDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const base = stripKnownLogExtension(entry.name);
    if (base !== null && ISO_DATE_ONLY_RE.test(base)) dates.add(base);
  }
  const sortedDates = [...dates].sort();
  for (const date of sortedDates) {
    if (date < lowerBound) continue;
    if (date > upperBound) continue;
    const { entries } = readLogDay(vault, date);
    const filePath = join(logDir, `${date}.jsonl`);
    const vaultPath = relative(vault, filePath);
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      if (entry.timestamp < window.since) continue;
      if (entry.timestamp >= window.until) continue;
      out.push(
        normaliseLogEntry(entry, {
          path: vaultPath,
          line: i + 1,
        }),
      );
    }
  }
}

function stripKnownLogExtension(name: string): string | null {
  if (name.endsWith(".jsonl")) return name.slice(0, -".jsonl".length);
  if (name.endsWith(".md")) return name.slice(0, -".md".length);
  return null;
}

/**
 * Turn one `BrainLogEntry` into one `TemporalEvent`. Optional slots
 * (`prefId`, `topic`, `result`, `artifact`, `reason`, `text`) come
 * from the entry's `body` payload when the event kind documents them.
 * Unknown kinds still produce a `TemporalEvent` with no payload slots
 * populated; consumers that care about a specific kind read the
 * narrower slot off the timeline event directly.
 */
function normaliseLogEntry(
  entry: BrainLogEntry,
  source: TemporalEventSource,
): TemporalEvent {
  const body = entry.body;
  const prefId = extractPrefIdFromBody(entry.eventType, body);
  const topic = readScalar(body["topic"]);
  const reason = readScalar(body["reason"]);
  const result =
    entry.eventType === BRAIN_LOG_EVENT_KIND.applyEvidence
      ? readApplyResult(body["result"])
      : undefined;
  const artifactRaw =
    entry.eventType === BRAIN_LOG_EVENT_KIND.applyEvidence
      ? readScalar(body["artifact"])
      : undefined;
  // Strip surrounding wikilink brackets so the slot carries the raw
  // path / alias. We deliberately do NOT use `parseWikilink` here -
  // that helper collapses folder segments to a basename, which would
  // lose the `src/cli/main.ts` shape operators expect from an audit
  // pointer.
  const artifact =
    artifactRaw !== undefined ? stripWikilinkBrackets(artifactRaw) : undefined;
  const text =
    entry.eventType === BRAIN_LOG_EVENT_KIND.note
      ? readScalar(body["text"])
      : undefined;
  return Object.freeze({
    at: entry.timestamp,
    kind: entry.eventType,
    source,
    ...(prefId !== undefined ? { prefId } : {}),
    ...(topic !== undefined ? { topic } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(result !== undefined ? { result } : {}),
    ...(artifact !== undefined ? { artifact } : {}),
    ...(text !== undefined ? { text } : {}),
  });
}

function readScalar(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readApplyResult(value: unknown): BrainApplyResult | undefined {
  if (
    value === BRAIN_APPLY_RESULT.applied ||
    value === BRAIN_APPLY_RESULT.violated ||
    value === BRAIN_APPLY_RESULT.outdated
  ) {
    return value;
  }
  return undefined;
}

/**
 * Strip `[[…]]` brackets from a wikilink body without collapsing the
 * folder structure inside the bracket. When an alias is present
 * (`[[target|display]]`), keep the bare target. Bare strings pass
 * through unchanged.
 */
function stripWikilinkBrackets(value: string): string {
  let v = value.trim();
  if (v.startsWith("[[") && v.endsWith("]]")) {
    v = v.slice(2, -2);
  }
  const pipe = v.indexOf("|");
  return pipe >= 0 ? v.slice(0, pipe) : v;
}

const PREF_ID_RE = /^(?:pref|ret|sig)-[A-Za-z0-9-]+$/;

function extractPrefIdFromBody(
  kind: BrainLogEventKind,
  body: BrainLogEntry["body"],
): string | undefined {
  switch (kind) {
    case BRAIN_LOG_EVENT_KIND.applyEvidence:
    case BRAIN_LOG_EVENT_KIND.notedRedundant:
    case BRAIN_LOG_EVENT_KIND.retire:
    case BRAIN_LOG_EVENT_KIND.promote:
    case BRAIN_LOG_EVENT_KIND.forceConfirmed:
    case BRAIN_LOG_EVENT_KIND.reject:
      return readWikilinkId(body["preference"]);
    case BRAIN_LOG_EVENT_KIND.signalSuppressed:
      // The retired pref is the lifecycle-meaningful anchor for a
      // suppression event; the inbound signal slug is one-off.
      return (
        readWikilinkId(body["retired"]) ?? readWikilinkId(body["signal"])
      );
    case BRAIN_LOG_EVENT_KIND.feedback:
      return readWikilinkId(body["signal"]);
    default:
      return undefined;
  }
}

function readWikilinkId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const target = parseWikilink(value) ?? value;
  // Accept only the documented id prefixes so a stray artifact path
  // doesn't pollute the per-pref grouping.
  return PREF_ID_RE.test(target) ? target : undefined;
}

function collectRetiredEvents(
  vault: string,
  window: TimelineWindow,
  out: TemporalEvent[],
): void {
  const retiredDir = brainDirs(vault).retired;
  if (!existsSync(retiredDir)) return;
  for (const entry of readdirSync(retiredDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    if (!entry.name.startsWith("ret-")) continue;
    const path = join(retiredDir, entry.name);
    let meta: Record<string, unknown>;
    try {
      const [parsed] = parseFrontmatter(path);
      meta = parsed;
    } catch {
      continue;
    }
    const retiredAt = readScalar(meta["retired_at"]);
    if (retiredAt === undefined) continue;
    if (retiredAt < window.since) continue;
    if (retiredAt >= window.until) continue;
    const id = readScalar(meta["id"]) ?? entry.name.slice(0, -".md".length);
    const topic = readScalar(meta["topic"]);
    const reason = readScalar(meta["reason"]);
    const validFrom = readScalar(meta["valid_from"]);
    const validUntil = readScalar(meta["valid_until"]);
    const recordedAt = readScalar(meta["recorded_at"]);
    out.push(
      Object.freeze({
        at: retiredAt,
        kind: BRAIN_LOG_EVENT_KIND.retire,
        source: { path: relative(vault, path), line: null },
        prefId: id,
        ...(topic !== undefined ? { topic } : {}),
        ...(reason !== undefined ? { reason } : {}),
        ...(validFrom !== undefined ? { validFrom } : {}),
        ...(validUntil !== undefined ? { validUntil } : {}),
        ...(recordedAt !== undefined ? { recordedAt } : {}),
      }),
    );
  }
}
