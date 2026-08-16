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
import {
  OPERATION,
  progressCounter,
  withProgress,
  type ProgressCounter,
  type ProgressSink,
} from "./progress.ts";
import type { Safeguard } from "./safeguard.ts";

const MARKDOWN_EXT = ".md";

/** The one stage this read has: it walks the four Brain directories. */
const SCAN_STAGE = "scan";

/**
 * What a caller may hand the scan.
 *
 * Both members are optional and absence means nobody asked, which is the
 * house observer idiom. They arrived together because the scan is one of
 * the two units `runDreamStep` runs on its own: reached that way it is a
 * whole call rather than a phase of one, and a call that can walk a large
 * tree needs a deadline and something to say while it does.
 */
export interface ScanBrainOptions {
  /**
   * Cooperative deadline; checked once per file read and once per
   * directory.
   *
   * `dream()` DOES pass this one, and the asymmetry with `onProgress`
   * below is deliberate rather than an oversight. A deadline is about the
   * wall-clock the work costs, and the work costs the same inside a pass
   * as it does on its own: the scan is where a large `Brain/` tree is
   * read, so a pass whose scan was unguarded would sit past its budget
   * with the next checkpoint hundreds of files away. A stream, by
   * contrast, is about who is speaking, and inside a pass that is the
   * pass.
   */
  readonly safeguard?: Safeguard;
  /**
   * Where this scan reports, when it is the whole run.
   *
   * `dream()` deliberately does NOT pass one: its own counter already
   * owns a `scan` stage and hands the same sink a second stream would
   * duplicate. A counter with no sink emits nothing, so the pass costs
   * the full run exactly what it did before.
   */
  readonly onProgress?: ProgressSink;
}

/** The per-file boundary every collector crosses: deadline, then tick. */
interface DirectoryWalk {
  step(): void;
}

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
  files: ReadonlyArray<string>,
  active: boolean,
  signals: SignalRecord[],
  corrupted: CorruptedEntry[],
  walk: DirectoryWalk,
): void {
  for (const full of files) {
    walk.step();
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
  files: ReadonlyArray<string>,
  preferences: PreferenceRecord[],
  corrupted: CorruptedEntry[],
  walk: DirectoryWalk,
): void {
  for (const full of files) {
    walk.step();
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

function collectRetired(
  files: ReadonlyArray<string>,
  retired: RetiredRecord[],
  corrupted: CorruptedEntry[],
  walk: DirectoryWalk,
): void {
  for (const full of files) {
    walk.step();
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
export function scanBrain(vault: string, opts: ScanBrainOptions = {}): ScanResult {
  const progress = progressCounter(OPERATION.dream, opts.onProgress);
  return withProgress(progress, () => scanBrainRun(vault, opts, progress));
}

function scanBrainRun(
  vault: string,
  opts: ScanBrainOptions,
  progress: ProgressCounter,
): ScanResult {
  const dirs = brainDirs(vault);
  // The four listings are `readdirSync` with no parse, so front-loading
  // them costs a directory read each and buys the stage its denominator:
  // the file count IS the unit this stage ticks in, and a reader watching
  // a bare counter cannot tell a scan a tenth of the way through from one
  // about to finish. The stage still opens before the first checkpoint,
  // so an already-elapsed guard leaves a stream that spoke once.
  const inbox = markdownFilesIn(dirs.inbox);
  const processed = markdownFilesIn(dirs.processed);
  const preferenceFiles = markdownFilesIn(dirs.preferences);
  const retiredFiles = markdownFilesIn(dirs.retired);
  progress.start(
    SCAN_STAGE,
    inbox.length + processed.length + preferenceFiles.length + retiredFiles.length,
  );
  const signals: SignalRecord[] = [];
  const preferences: PreferenceRecord[] = [];
  const retired: RetiredRecord[] = [];
  const corrupted: CorruptedEntry[] = [];
  // One boundary for all four collectors: the per-file read is where the
  // work is, so it is where the deadline is honoured and where a reader
  // learns the scan is still moving. Collapsed into one object because
  // four collectors taking two more parameters each is four chances to
  // thread one of them and forget the other.
  const walk: DirectoryWalk = {
    step: () => {
      opts.safeguard?.checkpoint();
      progress.advance(SCAN_STAGE);
    },
  };

  // The directory boundary is a checkpoint too, and not only for
  // symmetry: a tree with no markdown in it crosses no per-file boundary
  // at all, and a deadline that only a populated vault can trip is a
  // deadline that is absent exactly where a caller cannot predict it.
  // The tick stays per file - a directory is not a unit of work a reader
  // can count.
  const collectors: ReadonlyArray<() => void> = [
    () => collectSignals(inbox, true, signals, corrupted, walk),
    () => collectSignals(processed, false, signals, corrupted, walk),
    () => collectPreferences(preferenceFiles, preferences, corrupted, walk),
    () => collectRetired(retiredFiles, retired, corrupted, walk),
  ];
  for (const collect of collectors) {
    opts.safeguard?.checkpoint();
    collect();
  }

  return { signals, preferences, retired, corrupted };
}
