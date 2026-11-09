/**
 * Agent quality summary for the brain digest.
 *
 * Groups Brain/log events by agent within the given window and returns
 * per-agent counts: total events, breakdown by type (feedback /
 * apply-evidence / note), and attribution to confirmed/retired rules.
 */

import {
  memoryPageNamed,
  storeMemoryPages,
  type MemoryFolder,
  type MemoryPage,
} from "./memory-pages.ts";

import type { BrainLogEntry } from "./log.ts";
import { logDayReader } from "./log-days.ts";
import { BRAIN_LOG_EVENT_KIND } from "./types.ts";

export interface AgentSummaryEntry {
  readonly agent: string;
  readonly total_events: number;
  readonly feedback_count: number;
  readonly apply_evidence_count: number;
  readonly note_count: number;
  readonly confirmed_attributed: number;
  readonly retired_attributed: number;
}

interface AgentAccumulator {
  agent: string;
  total_events: number;
  feedback_count: number;
  apply_evidence_count: number;
  note_count: number;
  confirmed_attributed: number;
  retired_attributed: number;
}

/**
 * `keep` answers whether the caller may count an event; an event it
 * refuses moves no count and attributes no rule. Without it every event
 * in the window is counted.
 */
export function computeAgentSummary(
  vault: string,
  since: Date,
  until: Date,
  keep?: (entry: BrainLogEntry) => boolean,
): ReadonlyArray<AgentSummaryEntry> {
  const windowed = readLogsInWindow(vault, since, until);
  const logs = keep === undefined ? windowed : windowed.filter(keep);
  const byAgent = new Map<string, AgentAccumulator>();
  const field = memoryFieldReader(vault);

  for (const entry of logs) {
    const agent = getEntryAgent(entry);
    let acc = byAgent.get(agent);
    if (!acc) {
      acc = {
        agent,
        total_events: 0,
        feedback_count: 0,
        apply_evidence_count: 0,
        note_count: 0,
        confirmed_attributed: 0,
        retired_attributed: 0,
      };
      byAgent.set(agent, acc);
    }
    acc.total_events++;
    switch (entry.eventType) {
      case BRAIN_LOG_EVENT_KIND.feedback:
        acc.feedback_count++;
        break;
      case BRAIN_LOG_EVENT_KIND.applyEvidence:
        acc.apply_evidence_count++;
        break;
      case BRAIN_LOG_EVENT_KIND.note:
        acc.note_count++;
        break;
    }
  }

  const seenPrefs = new Set<string>();
  const prefFirstAgent = new Map<string, string>();

  for (const entry of logs) {
    const agent = getEntryAgent(entry);
    const pref = entry.body["preference"];
    if (typeof pref !== "string") continue;
    const prefId = extractPrefId(pref);
    if (!prefId) continue;

    if (!prefFirstAgent.has(prefId)) {
      prefFirstAgent.set(prefId, agent);
    }
  }

  for (const entry of logs) {
    const agent = getEntryAgent(entry);
    const acc = byAgent.get(agent);
    if (!acc) continue;

    const pref = entry.body["preference"];
    if (typeof pref !== "string") continue;
    const prefId = extractPrefId(pref);
    if (!prefId) continue;

    const key = `${agent}:${prefId}`;
    if (seenPrefs.has(key)) continue;

    const firstAgent = prefFirstAgent.get(prefId);
    if (firstAgent !== agent) continue;

    seenPrefs.add(key);

    const confirmedAt = field("preferences", `${prefId}.md`, "confirmed_at");
    const retiredAt = field("retired", `${prefId.replace("pref-", "ret-")}.md`, "retired_at");

    if (confirmedAt && isInWindow(confirmedAt, since, until)) {
      acc.confirmed_attributed++;
    }
    if (retiredAt && isInWindow(retiredAt, since, until)) {
      acc.retired_attributed++;
    }
  }

  return [...byAgent.values()].toSorted((a, b) => {
    const diff = b.total_events - a.total_events;
    return diff !== 0 ? diff : a.agent.localeCompare(b.agent);
  });
}

function readLogsInWindow(vault: string, since: Date, until: Date): BrainLogEntry[] {
  const sinceIso = since.toISOString();
  const untilIso = until.toISOString();
  const sinceDay = sinceIso.slice(0, 10);
  const untilDay = untilIso.slice(0, 10);
  const out: BrainLogEntry[] = [];
  // Shard-aware (Memory Integrity Suite): one discovery helper, merged reads.
  const log = logDayReader(vault);
  for (const date of log.dates) {
    if (date < addDays(sinceDay, -1)) continue;
    if (date > addDays(untilDay, 1)) continue;
    const { entries } = log.day(date);
    for (const e of entries) {
      if (e.timestamp >= sinceIso && e.timestamp < untilIso) {
        out.push(e);
      }
    }
  }
  out.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return out;
}

function addDays(day: string, delta: number): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(t)) return day;
  return new Date(t + delta * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function extractPrefId(raw: string): string | null {
  const m = /\[\[([^\]|#]+)/.exec(raw);
  if (m) return m[1]!.trim();
  if (raw.startsWith("pref-")) return raw;
  return null;
}

function getEntryAgent(entry: BrainLogEntry): string {
  const runtimeAgent = entry.agent;
  if (typeof runtimeAgent === "string" && runtimeAgent.trim() !== "") {
    return runtimeAgent;
  }
  const bodyAgent = entry.body["agent"];
  if (typeof bodyAgent === "string" && bodyAgent.trim() !== "") {
    return bodyAgent;
  }
  return "unknown";
}

/**
 * A reader of one frontmatter field of memory page `name` of `folder`:
 * the file on an unswitched machine (read when asked), the page the
 * store's fold rebuilds once switched (no file exists there). The field
 * is read from the parsed frontmatter in either `field` or the writer's
 * `_field` spelling, so a page the preference writer wrote counts as a
 * hand-written one does. The store's pages of a folder are loaded once
 * per reader and indexed by name, so a summary costs one fold read per
 * folder, not one per preference. `null` when there is no such page, no
 * such field, or it cannot be read.
 */
function memoryFieldReader(
  vault: string,
): (folder: "preferences" | "retired", name: string, field: string) => string | null {
  const folders = new Map<MemoryFolder, Map<string, MemoryPage> | null>();
  const storedPages = (folder: MemoryFolder): Map<string, MemoryPage> | null => {
    if (!folders.has(folder)) {
      let pages: ReadonlyArray<MemoryPage> | null;
      try {
        pages = storeMemoryPages(vault, folder);
      } catch {
        pages = [];
      }
      folders.set(folder, pages === null ? null : new Map(pages.map((p) => [p.name, p])));
    }
    return folders.get(folder)!;
  };
  return (folder, name, field) => {
    try {
      const stored = storedPages(folder);
      const page = stored === null ? memoryPageNamed(vault, folder, name) : stored.get(name);
      if (page === undefined || page === null) return null;
      const [meta] = page.read();
      const value = meta[field] ?? meta[`_${field}`];
      if (typeof value === "string") return value.trim() || null;
      return value instanceof Date ? value.toISOString() : null;
    } catch {
      return null;
    }
  };
}

function isInWindow(iso: string, since: Date, until: Date): boolean {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  return t >= since.getTime() && t < until.getTime();
}
