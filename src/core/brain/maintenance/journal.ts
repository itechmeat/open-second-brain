/**
 * Maintenance run journal (write-time-integrity-governance,
 * t_166d1226): bounded append-only JSONL in the vault-local state
 * dir. Every attempt lands here - including gate refusals - so the
 * operator can see WHY the quiet-window lane did or did not run
 * without trusting silence. Newest-N retention with an explicit
 * sweep on append, matching the activation-store discipline.
 */

import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export const MAINTENANCE_JOURNAL_CAP = 500;

export type MaintenanceVerdict = "run" | "skipped:window" | "skipped:busy" | "skipped:lease";

export interface MaintenanceJournalEntry {
  readonly ts: string;
  readonly holder: string;
  readonly verdict: MaintenanceVerdict;
  /** Present on per-task rows; absent on gate-refusal rows. */
  readonly task?: string;
  readonly ok?: boolean;
  readonly duration_ms?: number;
  readonly error?: string;
}

function journalPath(vault: string): string {
  return join(vault, ".open-second-brain", "maintenance-runs.jsonl");
}

export function appendJournal(vault: string, entry: MaintenanceJournalEntry): void {
  const path = journalPath(vault);
  mkdirSync(dirname(path), { recursive: true });
  // O_APPEND, one line per call: concurrent gate-refusal writers
  // (which run BEFORE the lease is held) interleave instead of
  // overwriting each other through a read-modify-rewrite race. The
  // cap is enforced separately by `sweepJournal`, which runMaintenance
  // calls while it holds the lease - the only safe rewrite point.
  appendFileSync(path, JSON.stringify(entry) + "\n");
}

/** Trim the journal to the newest `cap` lines. Lease-holder only. */
export function sweepJournal(vault: string, cap: number = MAINTENANCE_JOURNAL_CAP): void {
  const path = journalPath(vault);
  const lines = readLines(path);
  if (lines.length <= cap) return;
  const kept = lines.slice(lines.length - cap);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, kept.join("\n") + "\n");
  renameSync(tmp, path);
}

/** Journal entries, newest first. Unparseable lines are skipped. */
export function listJournal(vault: string, limit?: number): MaintenanceJournalEntry[] {
  const lines = readLines(journalPath(vault));
  const out: MaintenanceJournalEntry[] = [];
  for (const line of lines) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        out.push(parsed as MaintenanceJournalEntry);
      }
    } catch {
      // Fail-soft: a torn line never breaks the journal read.
    }
  }
  out.reverse();
  return limit !== undefined ? out.slice(0, Math.max(0, limit)) : out;
}

function readLines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}
