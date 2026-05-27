/**
 * Per-preference edit-history sidecar (F4).
 *
 * Each content mutation of a preference appends one JSONL line to
 * `Brain/preferences/pref-<slug>.history.jsonl` recording the field that
 * changed and its before/after. The trail is append-only but
 * convergent under Syncthing: {@link appendEditHistory} skips any entry
 * whose `(revision, field, after)` triple already exists, so two peers
 * replaying the same write converge instead of duplicating. The sidecar
 * never enters the search index because the walker only yields `.md`
 * files.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { preferenceHistoryPath } from "../paths.ts";

export interface EditHistoryEntry {
  /** ISO timestamp of the mutation. */
  readonly ts: string;
  /** Agent identity that performed the write. */
  readonly agent: string;
  /** The preference `_revision` this entry produced. */
  readonly revision: number;
  /** The frontmatter field that changed (e.g. `principle`, `scope`). */
  readonly field: string;
  /** Prior value, or `null` when the field was absent before. */
  readonly before: string | null;
  /** New value, or `null` when the field was removed. */
  readonly after: string | null;
}

function dedupKey(e: EditHistoryEntry): string {
  return `${e.revision}\x00${e.field}\x00${e.after ?? "\x01"}`;
}

function isEntry(value: unknown): value is EditHistoryEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.ts === "string" &&
    typeof v.agent === "string" &&
    typeof v.revision === "number" &&
    typeof v.field === "string" &&
    (typeof v.before === "string" || v.before === null) &&
    (typeof v.after === "string" || v.after === null)
  );
}

/** Read the sidecar, skipping malformed lines. Missing file -> `[]`. */
export function readEditHistory(
  vault: string,
  slug: string,
): EditHistoryEntry[] {
  const path = preferenceHistoryPath(vault, slug);
  if (!existsSync(path)) return [];
  const out: EditHistoryEntry[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isEntry(parsed)) out.push(parsed);
    } catch {
      // malformed line - skip, do not throw
    }
  }
  return out;
}

/**
 * Append `entries` to the sidecar, skipping any whose
 * `(revision, field, after)` already exists. Returns the number of
 * lines actually written. Creates the parent directory if missing.
 */
export function appendEditHistory(
  vault: string,
  slug: string,
  entries: ReadonlyArray<EditHistoryEntry>,
): number {
  if (entries.length === 0) return 0;
  const path = preferenceHistoryPath(vault, slug);
  const seen = new Set(readEditHistory(vault, slug).map(dedupKey));
  const lines: string[] = [];
  for (const e of entries) {
    const key = dedupKey(e);
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(JSON.stringify(e));
  }
  if (lines.length === 0) return 0;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, lines.join("\n") + "\n");
  return lines.length;
}

/**
 * Render a deterministic, human-readable timeline. Entries are sorted
 * by revision then field; values are quoted so empty/whitespace edits
 * stay visible.
 */
export function renderEditHistory(
  entries: ReadonlyArray<EditHistoryEntry>,
): string {
  if (entries.length === 0) return "(no recorded edits)";
  const sorted = entries
    .slice()
    .sort((a, b) => a.revision - b.revision || a.field.localeCompare(b.field));
  const lines = sorted.map((e) => {
    const before = e.before === null ? "(absent)" : `"${e.before}"`;
    const after = e.after === null ? "(removed)" : `"${e.after}"`;
    return `rev ${e.revision} (${e.ts}, ${e.agent}): ${e.field}: ${before} -> ${after}`;
  });
  return lines.join("\n");
}
