import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { brainDirs } from "./paths.ts";
import { parsePreference, parseRetired } from "./preference.ts";
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
  const retiredById = new Map(
    readRetired(vault).map((entry) => [entry.retired.id, entry]),
  );
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

function readPreferences(vault: string): ReadonlyArray<ParsedPreferenceEntry> {
  const dir = brainDirs(vault).preferences;
  if (!existsSync(dir)) return [];
  const out: ParsedPreferenceEntry[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.startsWith("pref-") || !name.endsWith(".md")) continue;
    const path = join(dir, name);
    try {
      out.push({ path, pref: parsePreference(path) });
    } catch {
      continue;
    }
  }
  return out;
}

function readRetired(vault: string): ReadonlyArray<ParsedRetiredEntry> {
  const dir = brainDirs(vault).retired;
  if (!existsSync(dir)) return [];
  const out: ParsedRetiredEntry[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.startsWith("ret-") || !name.endsWith(".md")) continue;
    const path = join(dir, name);
    try {
      out.push({ path, retired: parseRetired(path) });
    } catch {
      continue;
    }
  }
  return out;
}
