/**
 * Architecture docs generator (Project History Suite, t_929da8a2).
 *
 * Renders scanProject facts into vault notes under
 * `Brain/projects/arch/<repo-key>/`: one overview plus one note per
 * detected module, all generated content inside sentinel regions.
 * Regeneration goes through mergeRegions, so operator prose outside
 * regions survives byte-for-byte, and an unchanged project regenerates
 * byte-identically (the scanner is deterministic and the renderer adds
 * no timestamps).
 *
 * Frontmatter is written ONCE at file creation and never rewritten -
 * it carries static identity (kind, repo key, path), while every fact
 * that can change between scans lives inside a region.
 *
 * Module REMOVAL keeps the old module note on disk (the operator may
 * have annotated it); the overview's module region reflects only the
 * current scan, so stale notes become unlinked rather than deleted.
 *
 * One run is one critical section: every note is planned, then written,
 * with the sync lock held across both. Planning before writing is what
 * makes a corrupted-sentinel abort - and an elapsed deadline - leave NO
 * half-refreshed prefix on disk, and the lock is what stops two runs on
 * the same repo from reading the same "before" state and erasing each
 * other's merge.
 *
 * Planning does NOT cover a failure of the writing itself. Planning
 * removes the error class that arises while DECIDING a note's bytes; an
 * ENOSPC, EACCES or EIO on the k-th of N notes arises while placing them,
 * and leaves k-1 refreshed beside the rest. No filesystem swaps N files
 * into place at once, so that state is reachable and cannot be rolled
 * back. What makes it survivable is that the loop is idempotent - every
 * note's bytes are a function of the scanned facts plus the prose already
 * outside its regions - so a re-run repairs any prefix. What makes it
 * actionable is {@link ArchWriteError}, which names the note that failed
 * and how far the run got.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "../../fs-atomic.ts";
import { repoKey as deriveRepoKey } from "../git/identity.ts";
import { OPERATION, progressCounter, progressReasonForError } from "../progress.ts";
import type { ProgressCounter, ProgressSink } from "../progress.ts";
import { buildRegionDocument, mergeRegions } from "../regions.ts";
import type { Region } from "../regions.ts";
import type { Safeguard } from "../safeguard.ts";
import { acquireLockSyncWithRetry, LOCK_WAIT_INTERACTIVE_MS } from "../sync-lockfile.ts";
import { ARCHITECT_STAGE, scanProject } from "./scan.ts";
import type { ModuleFact, ProjectFacts } from "./scan.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";

export interface GenerateArchDocsOptions {
  /** Where a caller watches the run. Absence means nobody asked. */
  readonly onProgress?: ProgressSink;
  /**
   * Cooperative deadline, checked per directory read while scanning and
   * per note while planning - never between two writes.
   */
  readonly safeguard?: Safeguard;
}

export interface GenerateArchDocsResult {
  readonly repoKey: string;
  readonly dir: string;
  readonly overviewPath: string;
  readonly modulePaths: ReadonlyArray<string>;
  /**
   * What this run did to the notes: how many it wrote for the first time,
   * how many it rewrote, and how many it found already correct. They sum
   * to `1 + modulePaths.length` and go out on the CLI's JSON envelope.
   *
   * Each one is the verdict of a READ - `planNote` compares what is on
   * disk against what the facts say - so the three are only true of the
   * disk if that read and the write that follows it are one critical
   * section. They are consequently what a concurrent run can falsify:
   * two runs whose reads both preceded either write both report having
   * created the same note. That is the property
   * `architect-concurrent-runs.test.ts` holds down.
   */
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  /**
   * The message of the first failure of the caller's progress sink, or
   * `null` when there was none (and when no sink was supplied).
   *
   * An observer must not be able to destroy what it observes - a closed
   * pipe cannot be allowed to abort a generation that is otherwise
   * succeeding - but it must not vanish either, so the fault is carried
   * out on the result the caller already reads and the sink is detached
   * for the rest of the run. Only the first is reported: after it there
   * is no attached sink left to fail again.
   */
  readonly progressFault: string | null;
}

/**
 * Codepoint order, not `localeCompare`: ICU collation varies with the
 * runtime locale, so a collator-based tie-break renders different bytes
 * for the same tree on two hosts - and byte-identical regeneration is
 * this module's whole contract. Every other ordering in the scanner
 * already uses plain `toSorted()`; this is the one that did not.
 */
function compareStable(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function languagesLine(languages: Readonly<Record<string, number>>): string {
  const entries = Object.entries(languages).toSorted(
    (a, b) => b[1] - a[1] || compareStable(a[0], b[0]),
  );
  if (entries.length === 0) return "none detected";
  return entries
    .slice(0, 8)
    .map(([ext, count]) => `${ext} (${count})`)
    .join(", ");
}

function overviewRegions(facts: ProjectFacts, key: string): ReadonlyArray<Region> {
  const summary = [
    `Project: ${facts.name}`,
    ...(facts.manifest?.version != null ? [`Version: ${facts.manifest.version}`] : []),
    ...(facts.manifest?.description != null ? [`Description: ${facts.manifest.description}`] : []),
    `Files: ${facts.totalFiles}`,
    `Languages: ${languagesLine(facts.languages)}`,
    ...(facts.testLayout !== null ? [`Test layout: ${facts.testLayout}/`] : []),
  ].join("\n");

  const modules = facts.modules
    .map(
      (module) =>
        `- [[Brain/projects/arch/${key}/modules/${module.name}|${module.name}]] ` +
        `(${module.path}, ${module.files} file(s))`,
    )
    .join("\n");

  const entryPoints =
    facts.entryPoints.length === 0
      ? "none detected"
      : facts.entryPoints.map((entry) => `- \`${entry}\``).join("\n");

  const dependencies =
    facts.manifest === null || facts.manifest.dependencies.length === 0
      ? "none declared"
      : facts.manifest.dependencies.map((dep) => `- ${dep}`).join("\n");

  return [
    { id: "summary", body: summary },
    { id: "modules", body: modules },
    { id: "entry-points", body: entryPoints },
    { id: "dependencies", body: dependencies },
  ];
}

function moduleRegions(module: ModuleFact): ReadonlyArray<Region> {
  const facts = [
    `Path: ${module.path}`,
    `Files: ${module.files}`,
    `Languages: ${languagesLine(module.languages)}`,
  ].join("\n");
  const files =
    module.topFiles.length === 0
      ? "empty module"
      : module.topFiles.map((file) => `- \`${file}\``).join("\n");
  return [
    { id: "facts", body: facts },
    { id: "files", body: files },
  ];
}

function frontmatter(kind: string, key: string, extra: ReadonlyArray<string>): string {
  return ["---", `kind: ${kind}`, `repo_key: ${key}`, ...extra, "---", ""].join("\n");
}

/** What one note's regeneration turned out to be. */
const NOTE_DISPOSITION = Object.freeze({
  created: "created",
  updated: "updated",
  unchanged: "unchanged",
} as const);

type NoteDisposition = (typeof NOTE_DISPOSITION)[keyof typeof NOTE_DISPOSITION];

/** One note's decided bytes, before any of them are on disk. */
interface PlannedNote {
  readonly path: string;
  /** The bytes to write, or `null` when the note is already correct. */
  readonly text: string | null;
  readonly disposition: NoteDisposition;
}

/**
 * Decide one region-bearing note's bytes WITHOUT writing them.
 *
 * Planning is separated from writing so that a `RegionError` - the
 * fail-closed verdict on corrupted sentinels - aborts the run before its
 * first byte instead of after the notes that happened to come earlier.
 * The prefix left on disk used to be a deterministic function of module
 * order, which made it predictable but no less wrong: an operator asked
 * to repair one note found the rest of the tree already half-refreshed.
 */
function planNote(path: string, head: string, regions: ReadonlyArray<Region>): PlannedNote {
  if (!existsSync(path)) {
    return {
      path,
      text: `${head}\n${buildRegionDocument(regions)}`,
      disposition: NOTE_DISPOSITION.created,
    };
  }
  const existing = readFileSync(path, "utf8");
  const merged = mergeRegions(existing, regions);
  if (merged === existing) return { path, text: null, disposition: NOTE_DISPOSITION.unchanged };
  return { path, text: merged, disposition: NOTE_DISPOSITION.updated };
}

/**
 * A note could not be written, part-way through the write loop.
 *
 * The notes before it are already renamed into place and the notes after
 * it still hold their previous bytes. `rename(2)` is atomic per file and
 * nothing swaps N files at once, so this partial state is reachable and
 * cannot be undone by the loop that produced it. It is repairable, not
 * recoverable in place: one run is a pure function of the scanned facts
 * plus the prose outside each note's regions, so re-running once the
 * cause is fixed rewrites every note, the untouched suffix included.
 *
 * The counts are the reason this type exists. The native errno names a
 * temp file the caller never asked for - `atomicWriteFileSync` writes a
 * sibling and renames it - and says nothing about how much of the tree
 * already moved, which is the one fact an operator needs to know a
 * re-run is not optional.
 */
export class ArchWriteError extends Error {
  /** The note whose write failed. */
  readonly path: string;
  /** Notes whose new bytes are already on disk. */
  readonly written: number;
  /** Notes still holding their previous bytes, this one included. */
  readonly pending: number;

  constructor(path: string, written: number, pending: number, cause: unknown) {
    super(
      `failed to write architecture note ${path} after refreshing ` +
        `${written} of ${written + pending} note(s): ${errorMessage(cause)} - ` +
        "the tree is partially refreshed; fix the cause and re-run, which " +
        "rewrites every note and preserves prose outside the regions",
      { cause },
    );
    this.name = "ArchWriteError";
    this.path = path;
    this.written = written;
    this.pending = pending;
  }
}

/** How many of `plans` ended in `disposition`. */
function countOf(plans: ReadonlyArray<PlannedNote>, disposition: NoteDisposition): number {
  return plans.filter((plan) => plan.disposition === disposition).length;
}

/** Where one module's note lives. One definition, two call sites. */
function modulePath(dir: string, module: ModuleFact): string {
  return join(dir, "modules", `${module.name}.md`);
}

/**
 * Plan every note, then write them - in that order, and never
 * interleaved.
 *
 * The deadline is checked while PLANNING only. A run that stops at a
 * checkpoint has therefore written nothing at all, and the write loop -
 * the cheap part, 7.9 ms of a 396 ms run on this repository - is allowed
 * to finish rather than being interrupted between two notes.
 *
 * A write that FAILS is the case a deadline policy cannot reach. The loop
 * cannot un-rename the notes already placed, so it reports how far it got
 * instead of implying it got nowhere: see {@link ArchWriteError}.
 */
function renderNotes(
  dir: string,
  key: string,
  facts: ProjectFacts,
  opts: GenerateArchDocsOptions,
  progress: ProgressCounter,
): ReadonlyArray<PlannedNote> {
  const plans: PlannedNote[] = [];
  opts.safeguard?.checkpoint();
  plans.push(
    planNote(
      join(dir, "overview.md"),
      frontmatter("arch-overview", key, [`repo_path: ${facts.root}`]),
      overviewRegions(facts, key),
    ),
  );
  for (const module of facts.modules) {
    opts.safeguard?.checkpoint();
    plans.push(
      planNote(
        modulePath(dir, module),
        frontmatter("arch-module", key, [`module: ${module.name}`]),
        moduleRegions(module),
      ),
    );
  }

  const toWrite = plans.filter((plan) => plan.text !== null).length;
  let written = 0;
  for (const plan of plans) {
    if (plan.text !== null) {
      try {
        atomicWriteFileSync(plan.path, plan.text);
      } catch (error) {
        throw new ArchWriteError(plan.path, written, toWrite - written, error);
      }
      written += 1;
    }
    // A note is complete when its bytes are on disk, or when they were
    // already the right bytes - so an unchanged note advances too.
    progress.advance(ARCHITECT_STAGE.render);
  }
  return plans;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Wrap a caller's sink so one broken stream cannot abort the run, and
 * report the first failure exactly once.
 *
 * `progressCounter` already refuses to let a throwing sink escape when it
 * is given a reporter - but a run spans TWO counters here, the scan's and
 * the renderer's, and a fault reported per counter would tell the caller
 * twice about one closed pipe. Detaching happens here, once, for the
 * whole run.
 */
function guardedSink(
  sink: ProgressSink | undefined,
  onFault: (message: string) => void,
): ProgressSink | undefined {
  if (sink === undefined) return undefined;
  let live = true;
  return (event) => {
    if (!live) return;
    try {
      sink(event);
    } catch (error) {
      live = false;
      onFault(errorMessage(error));
    }
  };
}

/** Generate or refresh architecture notes for one project tree. */
export function generateArchDocs(
  vault: string,
  projectRoot: string,
  opts: GenerateArchDocsOptions = {},
): GenerateArchDocsResult {
  const progressFaults: string[] = [];
  const sink = guardedSink(opts.onProgress, (message) => progressFaults.push(message));
  const progress = progressCounter(OPERATION.architect, sink);
  try {
    return generateRun(vault, projectRoot, opts, sink, progress, progressFaults);
  } catch (error) {
    // A stop the operator asked for, or a deadline that elapsed, is a
    // fact about the run - reported on the stream before the error
    // travels on. Anything else is a failure, and a failure is its own
    // report.
    const reason = progressReasonForError(error);
    if (reason !== null) progress.stop(reason);
    throw error;
  }
}

function generateRun(
  vault: string,
  projectRoot: string,
  opts: GenerateArchDocsOptions,
  sink: ProgressSink | undefined,
  progress: ProgressCounter,
  progressFaults: ReadonlyArray<string>,
): GenerateArchDocsResult {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  // The scan opens the `walk` stage on its own counter over the same
  // sink; this counter opens `render` and is the one that terminates.
  const facts = scanProject(projectRoot, {
    ...(sink === undefined ? {} : { onProgress: sink }),
    ...(opts.safeguard === undefined ? {} : { safeguard: opts.safeguard }),
  });
  const key = deriveRepoKey(facts.root);
  const dir = join(vault, "Brain", "projects", "arch", key);
  mkdirSync(join(dir, "modules"), { recursive: true });

  // Every note's path is a function of the FACTS, not of the order the
  // writes happen to complete in - `module_paths` is a documented part of
  // the CLI's JSON envelope, and it must not become a schedule report.
  const overviewPath = join(dir, "overview.md");
  const modulePaths = facts.modules.map((module) => modulePath(dir, module));

  // The note count is known only now, and it is known exactly: one
  // overview plus one note per detected module. Unlike the walk, this
  // stage has a denominator.
  progress.start(ARCHITECT_STAGE.render, 1 + facts.modules.length);

  // One critical section over every note, held across the reads AND the
  // writes. Atomicity is not exclusivity: a whole file is renamed into
  // place, so no reader sees torn bytes, yet two architect runs on the
  // same repo would still read the same "before" state and erase each
  // other's merge. Every other Brain read-modify-write takes this lock;
  // this one did not. It cannot stop an operator editing a note in the
  // same millisecond - nothing here can - but that race was never the
  // one the module could do something about.
  //
  // What the race costs is worth naming exactly, because the answer is
  // not torn bytes and a byte comparison will therefore never find it.
  // One run's output is a pure function of the facts plus the prose
  // outside each region, so two runs on one repo compute the same bytes
  // and whichever writes last leaves the same file either way. The loss
  // lands in the REPORT: each run planned from a state the other had
  // already replaced, so both tell the operator they created notes only
  // one of them created. `architect-concurrent-runs.test.ts` is the
  // discriminating test, and the tally is its instrument.
  //
  // The INTERACTIVE budget, not the default. Waiting on this lock is a
  // synchronous freeze of the whole process, and this process has a
  // progress stream and an operator's Ctrl-C behind it. The default is
  // sized for the ingest fan-out, where several processes contend by
  // design and the waiter is a short-lived worker with nothing else to
  // run; a second architect run over the same repo is not that workload.
  // One second absorbs a genuine brief overlap and refuses the rest by
  // name, rather than parking a watched terminal for five.
  const handle = acquireLockSyncWithRetry(dir, LOCK_WAIT_INTERACTIVE_MS);
  let plans: ReadonlyArray<PlannedNote>;
  try {
    plans = renderNotes(dir, key, facts, opts, progress);
  } finally {
    handle.release();
  }
  progress.finish();

  return Object.freeze({
    repoKey: key,
    dir,
    overviewPath,
    modulePaths: Object.freeze(modulePaths),
    created: countOf(plans, NOTE_DISPOSITION.created),
    updated: countOf(plans, NOTE_DISPOSITION.updated),
    unchanged: countOf(plans, NOTE_DISPOSITION.unchanged),
    progressFault: progressFaults[0] ?? null,
  });
}
