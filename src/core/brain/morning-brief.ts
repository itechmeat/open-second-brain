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
import { isoDate } from "./time.ts";
import { BRAIN_LOG_EVENT_KIND, BRAIN_PREFERENCE_STATUS } from "./types.ts";

export interface MorningBriefPreference {
  readonly id: string;
  readonly principle: string;
  readonly trimmed: boolean;
}

export interface MorningBriefOpenQuestion {
  readonly topic: string;
  readonly domain: string;
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

interface LogScan {
  readonly openQuestions: MorningBriefOpenQuestion[];
  readonly notes: string[];
}

function scanRecentLog(vault: string, now: Date, lookbackDays: number): LogScan {
  const openQuestions: MorningBriefOpenQuestion[] = [];
  const notes: string[] = [];
  const seenTopics = new Set<string>();
  const dayMs = 24 * 60 * 60 * 1000;
  // Newest day first so dedup keeps the most recent open question per topic.
  for (let i = 0; i <= lookbackDays; i++) {
    const date = isoDate(new Date(now.getTime() - i * dayMs));
    const entries = readLogDay(vault, date).entries;
    for (const e of entries) {
      if (e.eventType === BRAIN_LOG_EVENT_KIND.reconcile) {
        // Auto-resolutions carry a `resolution` field; only open
        // questions (no resolution) are surfaced to the operator.
        if (typeof e.body["resolution"] === "string") continue;
        const topic = typeof e.body["topic"] === "string" ? e.body["topic"] : "";
        const domain = typeof e.body["domain"] === "string" ? e.body["domain"] : "";
        if (topic && !seenTopics.has(topic)) {
          seenTopics.add(topic);
          openQuestions.push({ topic, domain });
        }
      } else if (e.eventType === BRAIN_LOG_EVENT_KIND.note) {
        const text = typeof e.body["text"] === "string" ? e.body["text"] : "";
        if (text) notes.push(text);
      }
    }
  }
  return { openQuestions, notes };
}

const PREF_PREFIX = "pref:";
const OQ_PREFIX = "oq:";
const NOTE_PREFIX = "note:";

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
    entries.push({ item: `${NOTE_PREFIX}${i}`, text: notes[i]! });
  }

  const budgeted = applyCharBudget(entries, {
    maxCharsPerEntry: opts.maxCharsPerMemory,
    maxTotalChars: opts.maxTotalChars,
  });

  const preferences: MorningBriefPreference[] = [];
  const keptQuestions: MorningBriefOpenQuestion[] = [];
  const keptNotes: string[] = [];
  for (const kept of budgeted.kept) {
    if (kept.item.startsWith(PREF_PREFIX)) {
      preferences.push({
        id: kept.item.slice(PREF_PREFIX.length),
        principle: kept.text,
        trimmed: kept.trimmed,
      });
    } else if (kept.item.startsWith(OQ_PREFIX)) {
      const topic = kept.item.slice(OQ_PREFIX.length);
      const found = openQuestions.find((q) => q.topic === topic);
      keptQuestions.push({ topic, domain: found?.domain ?? "" });
    } else if (kept.item.startsWith(NOTE_PREFIX)) {
      keptNotes.push(kept.text);
    }
  }

  const sections: string[] = [];
  if (preferences.length > 0) {
    sections.push(
      ["## Top preferences", ...preferences.map((p) => `- ${p.principle}`)].join("\n"),
    );
  }
  if (keptQuestions.length > 0) {
    sections.push(
      ["## Open questions", ...keptQuestions.map((q) => `- ${q.topic} (${q.domain})`)].join("\n"),
    );
  }
  if (keptNotes.length > 0) {
    sections.push(["## Recent notes", ...keptNotes.map((n) => `- ${n}`)].join("\n"));
  }

  return Object.freeze({
    text: sections.join("\n\n"),
    preferences: Object.freeze(preferences),
    openQuestions: Object.freeze(keptQuestions),
    recentNotes: Object.freeze(keptNotes),
    totalChars: budgeted.totalChars,
  });
}
