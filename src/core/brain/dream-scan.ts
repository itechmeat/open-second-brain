/**
 * Stage 0 of the dream pass: read the whole `Brain/` tree into memory.
 *
 * Pure with respect to the vault: it opens no writer, takes no clock and
 * touches nothing on disk, which is why it is the one part of the pass
 * that is provably runnable on its own (see `dream-step.ts`).
 *
 * A file whose frontmatter will not parse is collected into `corrupted`
 * rather than aborting the scan; the planning phase turns each entry into
 * a `skip-corrupted-frontmatter` log event.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { parseFrontmatter } from "../vault.ts";
import type {
  CorruptedEntry,
  PreferenceRecord,
  RetiredRecord,
  ScanResult,
  SignalRecord,
} from "./dream-plan.ts";
import { isTombstoned } from "./lifecycle/tombstone.ts";
import { brainDirs } from "./paths.ts";
import { parsePreference } from "./preference.ts";
import { parseSignal } from "./signal.ts";

const MARKDOWN_EXT = ".md";

/** Absolute paths of the `.md` files directly inside `dir`, or nothing when it does not exist. */
function markdownFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.endsWith(MARKDOWN_EXT)) out.push(join(dir, name));
  }
  return out;
}

/**
 * Signals from one directory. `inbox/` and `processed/` differ only in
 * the `active` flag they stamp on each record, so they share this walk.
 */
function collectSignals(
  dir: string,
  active: boolean,
  signals: SignalRecord[],
  corrupted: CorruptedEntry[],
): void {
  for (const full of markdownFilesIn(dir)) {
    // Belief lifecycle suite (t_7d5a3589): a tombstoned signal is
    // excluded from the dream pass so it is never re-clustered.
    if (isTombstoned(parseFrontmatter(full)[0])) continue;
    try {
      signals.push({ path: full, signal: parseSignal(full), active });
    } catch {
      corrupted.push({ path: full });
    }
  }
}

function collectPreferences(
  dir: string,
  preferences: PreferenceRecord[],
  corrupted: CorruptedEntry[],
): void {
  for (const full of markdownFilesIn(dir)) {
    const rawMeta = parseFrontmatter(full)[0];
    if (isTombstoned(rawMeta)) continue;
    // Belief lifecycle suite (A4): capture the raw superseded_by pointer
    // (the typed parser drops it) so accelerated chain decay can see a
    // temporally-superseded ancestor.
    const supersededBy =
      typeof rawMeta["superseded_by"] === "string" && rawMeta["superseded_by"] !== ""
        ? (rawMeta["superseded_by"] as string)
        : null;
    try {
      preferences.push({ path: full, pref: parsePreference(full), supersededBy });
    } catch {
      corrupted.push({ path: full });
    }
  }
}

function collectRetired(dir: string, retired: RetiredRecord[], corrupted: CorruptedEntry[]): void {
  for (const full of markdownFilesIn(dir)) {
    // Retired files we only need for topic + id (for supersede
    // bookkeeping) plus the optional `user_rejected_reason` that
    // drives signal-suppression (v0.10.1, _summary §6). We do a
    // lightweight frontmatter parse to avoid the strict folder
    // invariant check failing on permissive setups.
    try {
      const [meta] = parseFrontmatter(full);
      const topic = typeof meta["topic"] === "string" ? meta["topic"] : "";
      const id = typeof meta["id"] === "string" ? meta["id"] : "";
      const principle = typeof meta["principle"] === "string" ? meta["principle"] : "";
      const scope = typeof meta["scope"] === "string" ? meta["scope"] : undefined;
      const userReason =
        typeof meta["user_rejected_reason"] === "string"
          ? (meta["user_rejected_reason"] as string).trim()
          : "";
      if (topic && id) {
        retired.push({
          path: full,
          topic,
          id,
          principle,
          ...(scope ? { scope } : {}),
          ...(userReason ? { user_rejected_reason: userReason } : {}),
        });
      }
    } catch {
      corrupted.push({ path: full });
    }
  }
}

/**
 * Read the whole `Brain/` tree into memory. Pure: it opens no writer, takes
 * no clock and touches nothing on disk, which is why it is the one part of
 * the pass that is provably runnable on its own (see `dream-step.ts`).
 */
export function scanBrain(vault: string): ScanResult {
  const dirs = brainDirs(vault);
  const signals: SignalRecord[] = [];
  const preferences: PreferenceRecord[] = [];
  const retired: RetiredRecord[] = [];
  const corrupted: CorruptedEntry[] = [];

  collectSignals(dirs.inbox, true, signals, corrupted);
  collectSignals(dirs.processed, false, signals, corrupted);
  collectPreferences(dirs.preferences, preferences, corrupted);
  collectRetired(dirs.retired, retired, corrupted);

  return { signals, preferences, retired, corrupted };
}
