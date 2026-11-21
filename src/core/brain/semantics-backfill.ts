import type { FrontmatterMap } from "../types.ts";
import { memoryFolderPages } from "./memory-pages.ts";
import { parsePreferenceMeta, parseRetiredMeta } from "./preference.ts";
import { normaliseWikilinkTarget } from "./wikilink.ts";
import type { BrainPreference, BrainRetired } from "./types.ts";

export interface SemanticsBackfillProposal {
  readonly source_id: string;
  readonly target_id: string;
  readonly relation: "superseded_by";
  readonly field: "superseded_by";
  readonly value: string;
  readonly reason: "active-supersedes-retired-missing-inverse";
  readonly path: string;
}

export interface SemanticsBackfillPlan {
  readonly proposals: ReadonlyArray<SemanticsBackfillProposal>;
}

interface ParsedPreferenceEntry {
  readonly path: string;
  readonly pref: BrainPreference;
}

interface ParsedRetiredEntry {
  readonly path: string;
  readonly retired: BrainRetired;
}

export function planSemanticsBackfill(vault: string): SemanticsBackfillPlan {
  const active = readPreferences(vault);
  const retiredById = new Map(readRetired(vault).map((entry) => [entry.retired.id, entry]));
  const proposals: SemanticsBackfillProposal[] = [];

  for (const entry of active) {
    const supersedes = entry.pref.supersedes;
    if (!supersedes) continue;
    const retiredId = normaliseWikilinkTarget(supersedes);
    if (!retiredId.startsWith("ret-")) continue;
    const retired = retiredById.get(retiredId);
    if (!retired) continue;
    if (retired.retired.superseded_by !== undefined) continue;
    proposals.push({
      source_id: retired.retired.id,
      target_id: entry.pref.id,
      relation: "superseded_by",
      field: "superseded_by",
      value: `[[${entry.pref.id}]]`,
      reason: "active-supersedes-retired-missing-inverse",
      path: retired.path,
    });
  }

  proposals.sort((a, b) => {
    const source = a.source_id.localeCompare(b.source_id);
    if (source !== 0) return source;
    return a.target_id.localeCompare(b.target_id);
  });

  return Object.freeze({ proposals: Object.freeze(proposals) });
}

/**
 * The pages of one rule folder, parsed: the folder's files on an
 * unswitched machine, the pages the store's fold rebuilds on a switched
 * one ({@link memoryFolderPages}). A page that does not parse is skipped.
 */
function readFolder<T>(
  vault: string,
  folder: "preferences" | "retired",
  prefix: string,
  parse: (meta: FrontmatterMap, path: string) => T,
): ReadonlyArray<{ readonly path: string; readonly value: T }> {
  const out: Array<{ path: string; value: T }> = [];
  for (const page of memoryFolderPages(vault, folder)) {
    if (!page.name.startsWith(prefix) || !page.name.endsWith(".md")) continue;
    try {
      out.push({ path: page.path, value: parse(page.read()[0], page.path) });
    } catch {
      continue;
    }
  }
  return out;
}

function readPreferences(vault: string): ReadonlyArray<ParsedPreferenceEntry> {
  return readFolder(vault, "preferences", "pref-", parsePreferenceMeta).map(({ path, value }) => ({
    path,
    pref: value,
  }));
}

function readRetired(vault: string): ReadonlyArray<ParsedRetiredEntry> {
  return readFolder(vault, "retired", "ret-", parseRetiredMeta).map(({ path, value }) => ({
    path,
    retired: value,
  }));
}
