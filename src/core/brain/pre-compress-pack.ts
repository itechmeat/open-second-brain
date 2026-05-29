/**
 * Pre-compress injection pack (v0.20.0).
 *
 * A read-only bundle of the highest-confidence confirmed preferences plus
 * the head of `active.md`, rendered as a compact system-prompt addendum.
 * An external runtime (e.g. a host agent's pre-compression hook) can
 * inject it just before a context-compression event so the brain's
 * highest-salience constraints survive context rotation without the agent
 * having to remember to query. OSB ships only this builder and the MCP
 * tool around it; the host-runtime wiring is an out-of-scope recipe.
 *
 * It reuses the shared recall-budget primitive (the same per-entry and
 * total character caps as `brain_context_pack`) so one oversized
 * preference cannot dominate the addendum. Deterministic given the vault:
 * the only ordering inputs are confidence, creation time, and id.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { brainActivePath, brainDirs } from "./paths.ts";
import { parsePreference } from "./preference.ts";
import { applyCharBudget } from "./recall-budget.ts";
import { BRAIN_PREFERENCE_STATUS } from "./types.ts";

/** Sentinel item id for the active-head entry inside the budget pass. */
const ACTIVE_ID = "__active__";

export interface PreCompressItem {
  readonly id: string;
  /** Preference principle text after any per-entry trim. */
  readonly principle: string;
  /** True when `principle` was truncated by `maxCharsPerMemory`. */
  readonly trimmed: boolean;
}

export interface PreCompressPack {
  /** Rendered system-prompt addendum (empty string when nothing fits). */
  readonly text: string;
  readonly items: ReadonlyArray<PreCompressItem>;
  readonly activeHeadIncluded: boolean;
  readonly totalChars: number;
}

export interface PreCompressOptions {
  /** Maximum number of preferences to consider (highest-confidence first). */
  readonly topK: number;
  /** Per-entry character cap (code points); <= 0 / undefined disables. */
  readonly maxCharsPerMemory?: number;
  /** Total character cap across the bundle; <= 0 / undefined disables. */
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

function readActiveHead(vault: string): string | null {
  const path = brainActivePath(vault);
  if (!existsSync(path)) return null;
  try {
    const text = readFileSync(path, "utf8").trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/**
 * Build the pre-compress addendum for a vault. Confirmed preferences are
 * ranked by confidence (desc), then recency (desc), then id; the top
 * `topK` plus the active head are bounded by the shared char budget.
 */
export function buildPreCompressPack(vault: string, opts: PreCompressOptions): PreCompressPack {
  const ranked = collectConfirmed(vault).toSorted((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const top = ranked.slice(0, Math.max(0, opts.topK));

  const activeHead = readActiveHead(vault);
  const entries: Array<{ item: string; text: string }> = [];
  if (activeHead !== null) entries.push({ item: ACTIVE_ID, text: activeHead });
  for (const p of top) entries.push({ item: p.id, text: p.principle });

  const budgeted = applyCharBudget(entries, {
    maxCharsPerEntry: opts.maxCharsPerMemory,
    maxTotalChars: opts.maxTotalChars,
  });

  let activeText: string | null = null;
  const items: PreCompressItem[] = [];
  for (const kept of budgeted.kept) {
    if (kept.item === ACTIVE_ID) {
      activeText = kept.text;
      continue;
    }
    items.push({ id: kept.item, principle: kept.text, trimmed: kept.trimmed });
  }

  const sections: string[] = [];
  if (activeText !== null) sections.push(`# Active brain context\n\n${activeText}`);
  if (items.length > 0) {
    sections.push(["Preferences:", ...items.map((i) => `- ${i.principle}`)].join("\n"));
  }

  return Object.freeze({
    text: sections.join("\n\n"),
    items: Object.freeze(items),
    activeHeadIncluded: activeText !== null,
    totalChars: budgeted.totalChars,
  });
}
