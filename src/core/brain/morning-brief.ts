/**
 * Morning brief / day-close summary (Brain lifecycle suite, Feature 4).
 *
 * A read-only, budgeted session-start bundle composed from three
 * existing sources: the highest-confidence confirmed preferences, the
 * open questions the recent reconcile phase raised, and recent narrative
 * notes. It complements the on-demand `brain_digest` by giving a host
 * runtime one compact thing to surface at session start.
 *
 * Deterministic given the vault + injected clock: preference ordering is
 * confidence -> recency -> id; the log lookback iterates a fixed day
 * range; nothing calls the wall clock. Bounded by the shared
 * recall-budget primitive so one oversized entry cannot dominate.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { brainDirs } from "./paths.ts";
import { parsePreference } from "./preference.ts";
import { applyCharBudget } from "./recall-budget.ts";
import { readLogDay } from "./log-jsonl.ts";
import { isoDate, relativeAge } from "./time.ts";
import { BRAIN_LOG_EVENT_KIND, BRAIN_PREFERENCE_STATUS } from "./types.ts";

export interface MorningBriefPreference {
  readonly id: string;
  readonly principle: string;
  readonly trimmed: boolean;
  /** Short relative-age label ("2d ago") of the preference's creation. */
  readonly ageLabel?: string;
}

export interface MorningBriefOpenQuestion {
  readonly topic: string;
  readonly domain: string;
  /** Short relative-age label of the reconcile event that raised it. */
  readonly ageLabel?: string;
}

export interface MorningBrief {
  /** Rendered Markdown summary (empty string when nothing fits). */
  readonly text: string;
  readonly preferences: ReadonlyArray<MorningBriefPreference>;
  readonly openQuestions: ReadonlyArray<MorningBriefOpenQuestion>;
  readonly recentNotes: ReadonlyArray<string>;
  readonly totalChars: number;
}

export interface MorningBriefOptions {
  readonly now: Date;
  /** Max confirmed preferences to consider (highest-confidence first). */
  readonly topK: number;
  /** Days of log history to scan for open questions + notes. Default 7. */
  readonly lookbackDays?: number;
  /** Per-entry character cap (code points); <= 0 / undefined disables. */
  readonly maxCharsPerMemory?: number;
  /** Total character cap across the brief; <= 0 / undefined disables. */
  readonly maxTotalChars?: number;
}

interface ConfirmedPref {
  readonly id: string;
  readonly principle: string;
  readonly confidence: number;
  readonly createdAt: string;
}

function collectConfirmed(vault: string): ConfirmedPref[] {
  const dir = brainDirs(vault).preferences;
  if (!existsSync(dir)) return [];
  const out: ConfirmedPref[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    let pref;
    try {
      pref = parsePreference(join(dir, name));
    } catch {
      continue;
    }
    if (pref.status !== BRAIN_PREFERENCE_STATUS.confirmed) continue;
    out.push({
      id: pref.id,
      principle: pref.principle,
      confidence: pref.confidence_value ?? Number.NEGATIVE_INFINITY,
      createdAt: pref.created_at,
    });
  }
  return out;
}

interface ScannedOpenQuestion {
  readonly topic: string;
  readonly domain: string;
  readonly ts: string;
}

interface ScannedNote {
  readonly text: string;
  readonly ts: string;
}

interface LogScan {
  readonly openQuestions: ScannedOpenQuestion[];
  readonly notes: ScannedNote[];
}

function scanRecentLog(vault: string, now: Date, lookbackDays: number): LogScan {
  const openQuestions: ScannedOpenQuestion[] = [];
  const notes: ScannedNote[] = [];
  const seenTopics = new Set<string>();
  const dayMs = 24 * 60 * 60 * 1000;
  // Newest day and newest same-day entries first so dedup keeps the most recent
  // open question per topic.
  for (let i = 0; i <= lookbackDays; i++) {
    const date = isoDate(new Date(now.getTime() - i * dayMs));
    const entries = readLogDay(vault, date).entries;
    for (let j = entries.length - 1; j >= 0; j--) {
      const e = entries[j]!;
      const ts = typeof e.timestamp === "string" ? e.timestamp : "";
      if (e.eventType === BRAIN_LOG_EVENT_KIND.reconcile) {
        // Auto-resolutions carry a `resolution` field; only open
        // questions (no resolution) are surfaced to the operator.
        if (typeof e.body["resolution"] === "string") continue;
        const topic = typeof e.body["topic"] === "string" ? e.body["topic"] : "";
        const domain = typeof e.body["domain"] === "string" ? e.body["domain"] : "";
        if (topic && !seenTopics.has(topic)) {
          seenTopics.add(topic);
          openQuestions.push({ topic, domain, ts });
        }
      } else if (e.eventType === BRAIN_LOG_EVENT_KIND.note) {
        const text = typeof e.body["text"] === "string" ? e.body["text"] : "";
        if (text) notes.push({ text, ts });
      }
    }
  }
  return { openQuestions, notes };
}

const PREF_PREFIX = "pref:";
const OQ_PREFIX = "oq:";
const NOTE_PREFIX = "note:";

// Per-kind type tags stamped onto every rendered bullet so the
// session-start bundle reads as a scannable typed timeline rather than
// undifferentiated prose (v1.13.1 recent-activity presentation).
const TYPE_TAG_PREF = "pref";
const TYPE_TAG_OPEN = "open";
const TYPE_TAG_NOTE = "note";

/**
 * Render one timeline bullet: a Markdown list item carrying a type tag
 * and, when available, a short relative-age label. The age is omitted
 * (not shown as "· ") when `ageLabel` is empty — e.g. when the source
 * timestamp was missing or unparseable.
 */
function timelineBullet(type: string, text: string, ageLabel: string): string {
  return `- [${type}] ${text}${ageLabel ? ` · ${ageLabel}` : ""}`;
}

/**
 * Build the morning brief for a vault. Read-only; deterministic given
 * the vault and `opts.now`.
 */
export function buildMorningBrief(vault: string, opts: MorningBriefOptions): MorningBrief {
  const lookbackDays = opts.lookbackDays ?? 7;

  const ranked = collectConfirmed(vault).toSorted((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const topPrefs = ranked.slice(0, Math.max(0, opts.topK));

  const { openQuestions, notes } = scanRecentLog(vault, opts.now, lookbackDays);

  // Budget all variable-length entries together so one oversized entry
  // cannot crowd out the rest. Items are tagged by kind so the result
  // can be partitioned back.
  const entries: Array<{ item: string; text: string }> = [];
  for (const p of topPrefs) entries.push({ item: `${PREF_PREFIX}${p.id}`, text: p.principle });
  for (const q of openQuestions) {
    entries.push({ item: `${OQ_PREFIX}${q.topic}`, text: `${q.topic} (${q.domain})` });
  }
  for (let i = 0; i < notes.length; i++) {
    entries.push({ item: `${NOTE_PREFIX}${i}`, text: notes[i]!.text });
  }

  const budgeted = applyCharBudget(entries, {
    maxCharsPerEntry: opts.maxCharsPerMemory,
    maxTotalChars: opts.maxTotalChars,
  });

  // Lookups for relative-age labels: preferences by id, open questions
  // by topic, notes by their original (pre-budget) index. The budget
  // primitive preserves the `item` key, so each kept entry resolves
  // back to its source timestamp.
  const prefCreatedAtById = new Map(topPrefs.map((p) => [p.id, p.createdAt] as const));
  const oqByTopic = new Map(openQuestions.map((q) => [q.topic, q] as const));

  const preferences: MorningBriefPreference[] = [];
  const keptQuestions: MorningBriefOpenQuestion[] = [];
  const keptNotes: string[] = [];
  // Per-note rendered bullets carry the age label; the public
  // `recentNotes` field stays `string[]` for back-compat with MCP
  // clients, so the age is attached only on the rendered `text` path.
  const noteBullets: string[] = [];
  for (const kept of budgeted.kept) {
    if (kept.item.startsWith(PREF_PREFIX)) {
      const id = kept.item.slice(PREF_PREFIX.length);
      const ageLabel = relativeAge(prefCreatedAtById.get(id) ?? "", opts.now) || undefined;
      preferences.push({ id, principle: kept.text, trimmed: kept.trimmed, ageLabel });
    } else if (kept.item.startsWith(OQ_PREFIX)) {
      const topic = kept.item.slice(OQ_PREFIX.length);
      const found = oqByTopic.get(topic);
      const ageLabel = relativeAge(found?.ts ?? "", opts.now) || undefined;
      keptQuestions.push({ topic, domain: found?.domain ?? "", ageLabel });
    } else if (kept.item.startsWith(NOTE_PREFIX)) {
      const idx = Number(kept.item.slice(NOTE_PREFIX.length));
      const ageLabel = relativeAge(notes[idx]?.ts ?? "", opts.now);
      keptNotes.push(kept.text);
      noteBullets.push(timelineBullet(TYPE_TAG_NOTE, kept.text, ageLabel));
    }
  }

  const sections: string[] = [];
  if (preferences.length > 0) {
    sections.push(
      [
        "## Top preferences",
        ...preferences.map((p) => timelineBullet(TYPE_TAG_PREF, p.principle, p.ageLabel ?? "")),
      ].join("\n"),
    );
  }
  if (keptQuestions.length > 0) {
    sections.push(
      [
        "## Open questions",
        ...keptQuestions.map((q) =>
          timelineBullet(TYPE_TAG_OPEN, `${q.topic} (${q.domain})`, q.ageLabel ?? ""),
        ),
      ].join("\n"),
    );
  }
  if (noteBullets.length > 0) {
    sections.push(["## Recent notes", ...noteBullets].join("\n"));
  }

  return Object.freeze({
    text: sections.join("\n\n"),
    preferences: Object.freeze(preferences),
    openQuestions: Object.freeze(keptQuestions),
    recentNotes: Object.freeze(keptNotes),
    totalChars: budgeted.totalChars,
  });
}
