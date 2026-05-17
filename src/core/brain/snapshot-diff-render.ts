/**
 * Render a {@link BrainTreeDiff} as Markdown (for human consumption)
 * or as the raw structured object (for `--json` callers).
 *
 * Pure functions — no I/O. Tests pin the markdown shape so a future
 * cron or CI integration can grep against a stable byte layout.
 */

import { renderPrefLink } from "./wikilink.ts";
import type {
  BrainFieldChange,
  BrainTreeChange,
  BrainTreeDiff,
  BrainTreeEntry,
  BrainTreeEntryKind,
} from "./snapshot-diff.ts";

const SECTION_ORDER: ReadonlyArray<BrainTreeEntryKind> = Object.freeze([
  "preference",
  "retired",
  "signal",
  "log",
  "config",
  "other",
]);

const SECTION_TITLE: Readonly<Record<BrainTreeEntryKind, string>> =
  Object.freeze({
    preference: "Preferences",
    retired: "Retired",
    signal: "Signals",
    log: "Logs",
    config: "Config",
    other: "Other",
  });

export interface RenderDiffMarkdownOptions {
  /** Display label for the "A" side (typically a run id). */
  readonly aLabel?: string;
  /** Display label for the "B" side (typically a run id or `"live"`). */
  readonly bLabel?: string;
}

/**
 * Render a {@link BrainTreeDiff} as a Markdown document grouped by
 * artifact kind. Empty sections are still emitted with a `(no
 * changes)` line so the operator can confirm at a glance that the
 * differ examined every category.
 */
export function renderDiffMarkdown(
  diff: BrainTreeDiff,
  opts: RenderDiffMarkdownOptions = {},
): string {
  const aLabel = opts.aLabel ?? "A";
  const bLabel = opts.bLabel ?? "B";
  const lines: string[] = [];
  lines.push("# Brain snapshot diff");
  lines.push("");
  lines.push(`- A: ${aLabel}`);
  lines.push(`- B: ${bLabel}`);
  lines.push("");

  for (const kind of SECTION_ORDER) {
    const sectionLines = renderSection(diff, kind);
    lines.push(`## ${SECTION_TITLE[kind]}`);
    if (sectionLines.length === 0) {
      lines.push("(no changes)");
    } else {
      lines.push(...sectionLines);
    }
    lines.push("");
  }
  return lines.join("\n").replace(/\n+$/, "\n");
}

/**
 * Identity render for the structured payload — the differ already
 * produces the exact shape JSON callers expect. Kept as a function
 * (rather than passing the diff through directly) so future
 * formatting changes have a single hook.
 */
export function renderDiffJson(diff: BrainTreeDiff): BrainTreeDiff {
  return diff;
}

// ----- Internal helpers ----------------------------------------------------

function renderSection(
  diff: BrainTreeDiff,
  kind: BrainTreeEntryKind,
): string[] {
  const out: string[] = [];
  for (const entry of diff.added.filter((e) => e.kind === kind)) {
    out.push(`- + ${renderEntryRef(entry)} (added)`);
  }
  for (const entry of diff.removed.filter((e) => e.kind === kind)) {
    out.push(`- - ${renderEntryRef(entry)} (removed)`);
  }
  for (const change of diff.modified.filter((c) => c.entry.kind === kind)) {
    out.push(...renderModified(change));
  }
  return out;
}

function renderEntryRef(entry: BrainTreeEntry): string {
  if (
    (entry.kind === "preference" || entry.kind === "retired")
    && entry.id !== null
  ) {
    return renderPrefLink({ id: entry.id, principle: entry.principle });
  }
  if (entry.id !== null) {
    return `[[${entry.id}]]`;
  }
  return entry.path;
}

function renderModified(change: BrainTreeChange): string[] {
  const out: string[] = [];
  const ref = renderEntryRef(change.entry);
  if (change.fields.length === 0) {
    if (change.bodyChanged) {
      out.push(`- ~ ${ref} (body changed)`);
    }
    return out;
  }
  out.push(`- ~ ${ref}:`);
  for (const field of change.fields) {
    out.push(`  - ${renderField(field)}`);
  }
  return out;
}

function renderField(field: BrainFieldChange): string {
  return `${field.field}: ${formatValue(field.before)} → ${formatValue(field.after)}`;
}

function formatValue(v: string | number | boolean | null): string {
  if (v === null) return "null";
  return String(v);
}
