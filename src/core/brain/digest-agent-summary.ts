/**
 * Agent quality summary for the brain digest.
 *
 * Groups Brain/log events by agent within the given window and returns
 * per-agent counts: total events, breakdown by type (feedback /
 * apply-evidence / note), and attribution to confirmed/retired rules.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { brainDirs } from "./paths.ts";
import { parseLogDay, type BrainLogEntry } from "./log.ts";
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

export function computeAgentSummary(
  vault: string,
  since: Date,
  until: Date,
): ReadonlyArray<AgentSummaryEntry> {
  const logs = readLogsInWindow(vault, since, until);
  const byAgent = new Map<string, AgentAccumulator>();

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

    const confirmedAt = getConfirmedAt(vault, prefId);
    const retiredAt = getRetiredAt(vault, prefId);

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
  const dirs = brainDirs(vault);
  if (!existsSync(dirs.log)) return [];
  const sinceIso = since.toISOString();
  const untilIso = until.toISOString();
  const sinceDay = sinceIso.slice(0, 10);
  const untilDay = untilIso.slice(0, 10);
  const out: BrainLogEntry[] = [];
  const dates = readdirSync(dirs.log, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".md"))
    .map((d) => d.name.slice(0, -3))
    .filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n))
    .toSorted();
  for (const date of dates) {
    if (date < addDays(sinceDay, -1)) continue;
    if (date > addDays(untilDay, 1)) continue;
    const { entries } = parseLogDay(vault, date);
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

function getConfirmedAt(vault: string, prefId: string): string | null {
  const dirs = brainDirs(vault);
  const path = join(dirs.preferences, `${prefId}.md`);
  if (!existsSync(path)) return null;
  try {
    const text = readFileSync(path, "utf8");
    const m = /^confirmed_at:\s*(.+)$/m.exec(text);
    return m ? m[1]!.trim() : null;
  } catch {
    return null;
  }
}

function getRetiredAt(vault: string, prefId: string): string | null {
  const dirs = brainDirs(vault);
  const retiredId = prefId.replace("pref-", "ret-");
  const path = join(dirs.retired, `${retiredId}.md`);
  if (!existsSync(path)) return null;
  try {
    const text = readFileSync(path, "utf8");
    const m = /^retired_at:\s*(.+)$/m.exec(text);
    return m ? m[1]!.trim() : null;
  } catch {
    return null;
  }
}

function isInWindow(iso: string, since: Date, until: Date): boolean {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  return t >= since.getTime() && t < until.getTime();
}
