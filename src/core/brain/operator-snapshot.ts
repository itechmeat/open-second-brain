/**
 * Unified operator status snapshot (Source pipeline integrity suite, O3,
 * t_9f9c5466).
 *
 * One read-only composition of the signal sources an operator otherwise
 * has to poll one command at a time - doctor, semantic health, hygiene,
 * stale scan, review candidates, active profile, and state-file health -
 * into a single readable snapshot. Every problem line carries the exact
 * next command to run, and that command is looked up from the O2
 * diagnostics-signal registry ({@link resolveSignal}), never hardcoded in
 * the renderer: a hint has exactly one home, the issue definition.
 *
 * Reads only. Each source is wrapped fail-soft so one broken surface
 * (an unreadable index, a malformed config) degrades that line rather
 * than sinking the whole snapshot.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { resolveSearchConfig } from "../search/index.ts";
import { isWriterLockHeld } from "../search/store/writer-lock.ts";
import { FREEZE_NEXT_COMMAND, readFreezeMarker, type FreezeMarker } from "./freeze-marker.ts";
import { runDoctor } from "./doctor.ts";
import { resolveSignal } from "./diagnostics.ts";
import {
  describeSelfHealUpgradeFailure,
  readSelfHealUpgradeFailure,
  type SelfHealUpgradeFailure,
} from "../maintenance/self-heal-upgrade-state.ts";
import { runHygieneScan } from "./hygiene/scan.ts";
import type { HygieneFinding } from "./hygiene/types.ts";
import { brainConfigPath, brainDirs } from "./paths.ts";
import { loadTemporalConfigSafe } from "./policy.ts";
import { listProfiles } from "./portability/profiles.ts";
import { buildReviewCandidates } from "./review-candidates.ts";
import { buildTimelineIndex } from "./temporal/build-index.ts";
import { findStaleEntries } from "./temporal/stale-watch.ts";

/** One problem line: an issue class, its summary, and the next command. */
export interface SnapshotProblem {
  /** Diagnostics-signal code driving the next-command lookup. */
  readonly code: string;
  /** Human label for the issue class (from the signal definition). */
  readonly label: string;
  /** One-line summary (counts / verdict) of the finding. */
  readonly detail: string;
  /** Exact next command to run (from the signal definition). */
  readonly nextCommand: string;
}

export interface SnapshotCounts {
  readonly preferences: number;
  readonly retired: number;
  readonly inbox: number;
}

/**
 * The three honest answers about the search writer lock. `unknown` is
 * "I could not find out" - a stat that failed, a config that would not
 * resolve - and is deliberately NOT a spelling of `free`: a caller that
 * treats the second as the first has been told something untrue (the same
 * rule `isWriterLockHeld` itself states).
 */
export const WRITER_LOCK_STATE = Object.freeze({
  /** A live writer holds the lock right now. */
  held: "held",
  /** No live holder at the instant of the read. */
  free: "free",
  /** The state could not be measured; `writerLockReason` says what stopped it. */
  unknown: "unknown",
} as const);

/** Closed union over {@link WRITER_LOCK_STATE}. */
export type WriterLockState = (typeof WRITER_LOCK_STATE)[keyof typeof WRITER_LOCK_STATE];

/**
 * What this surface states about the memory store (t_cfe2ce5d).
 *
 * Scoped v1 to the SEARCH writer lock - the one `isWriterLockHeld`
 * answers. The scattered brain-lane `.lock` files stay with the doctor's
 * stale-lock probe; this group must not be read as covering both lock
 * families.
 *
 * `writerLockOwner` is `null` ALWAYS in v1, and that is a measurement
 * rather than a gap: the lock is a bare `proper-lockfile` directory whose
 * only metadata is its mtime, refreshed by a heartbeat. It answers "is
 * someone alive holding this"; it cannot answer "who". Naming a holder is
 * a deferred acquire-side change (stamping identity inside the lock
 * directory), not a field this snapshot can honestly fill today.
 *
 * A held lock is a live writer, not a fault: it is reported, never folded
 * into `healthy` or `problems` - the `frozen` precedent. Crash residue is
 * the doctor's `stale-lock` uncertain finding, which owns the "is this
 * holder actually dead" question.
 */
export interface SnapshotStore {
  /** Three-state answer about the search writer lock, fail-soft. */
  readonly writerLock: WriterLockState;
  /** Set when `unknown`: what stopped the measurement, errno included. */
  readonly writerLockReason: string | null;
  /**
   * Age of the lock directory's mtime when `held`, in milliseconds, from
   * the snapshot clock; `null` when free, unknown, or unmeasurable. The
   * heartbeat refreshes the mtime, so this is a lower bound on how long
   * the holder has been alive, never an upper bound.
   */
  readonly writerLockAgeMs: number | null;
  /** `null` in v1 - the lock record carries no identity. See above. */
  readonly writerLockOwner: string | null;
  /**
   * The lock path (the resolved search index path) at LOCAL reach;
   * `null` elsewhere. The path is a resolved host path that may sit
   * outside the vault, so the MCP surface withholds it below local reach
   * exactly the way `stateFiles.searchIndex` answers presence without it.
   */
  readonly writerLockPath: string | null;
  /**
   * This snapshot never writes and never takes the lock. The consequence
   * is rendered beside the flag, SCOPED TO WHAT THE LOCK GATES: while
   * `writerLock` is `held`, an index write THIS caller attempted - `o2b
   * search index` / reindex - would refuse with `INDEX_LOCKED` after its
   * retries. This is the search writer lock, and it gates index writers
   * only: vault and memory writes serialize on the brain lane's own lock
   * files, not on this one, so the rendered line says they are not gated
   * rather than implying a refusal this lock cannot cause.
   */
  readonly thisCaller: typeof THIS_CALLER_READ_ONLY;
}

/** The one value `thisCaller` can honestly take: this surface writes nothing. */
export const THIS_CALLER_READ_ONLY = "read-only";

export interface OperatorSnapshot {
  readonly counts: SnapshotCounts;
  /** stale preferences + signals + log files. */
  readonly staleTotal: number;
  /** would_create + would_promote + would_retire from the dry-run dream. */
  readonly reviewQueue: number;
  /** Active profile name, or null when none is set. */
  readonly activeProfile: string | null;
  /** Presence of the two on-disk state files that back the vault. */
  readonly stateFiles: {
    readonly config: boolean;
    readonly searchIndex: boolean;
  };
  /** Semantic-health verdict (clean | watch | investigate). */
  readonly healthVerdict: string;
  /** Every problem line, each carrying its next command. */
  readonly problems: ReadonlyArray<SnapshotProblem>;
  /** True when there are no problem lines. */
  readonly healthy: boolean;
  /**
   * The fleet freeze, or `null` when the vault is open (who-wrote-what,
   * Task C).
   *
   * Reported here rather than only as a doctor finding because "why is
   * nothing writing" is the first question a freeze raises, and the
   * operator snapshot is the surface that answers first questions. It is
   * NOT folded into {@link healthy}: a freeze is a state an operator
   * asked for, and calling it a problem would report an instruction as a
   * fault. The doctor names it as a warning, which is where a standing
   * condition belongs.
   */
  readonly frozen: FreezeMarker | null;
  /**
   * The last failure of the automatic managed-file upgrade on this device,
   * or `null` when none is recorded. It is also a problem line: a failed
   * self-heal leaves a pending upgrade behind and nothing else says so.
   */
  readonly selfHealUpgradeFailure: SelfHealUpgradeFailure | null;
  /**
   * What this snapshot can honestly state about the memory store: the
   * search writer lock's three-state answer, its age, the absence of any
   * owner identity on the lock record, and this caller's own read-only
   * standing. See {@link SnapshotStore}.
   */
  readonly store: SnapshotStore;
}

export interface BuildOperatorSnapshotOptions {
  /** Config path for the search-index and profile lookups. */
  readonly configPath?: string;
  /** Wall clock for stale/review scans. Defaults to `new Date()`. */
  readonly now?: Date;
  /**
   * May the caller read the vault file at this vault-relative path? Handed
   * to the hygiene scan (see `HygieneDetectorContext.readable`); a local
   * caller passes nothing.
   */
  readonly readable?: (rel: string) => boolean;
  /**
   * Does the caller see this finding? The hygiene problem line counts only
   * the findings it keeps, so the count matches what `brain_hygiene`
   * would list for the same caller rather than the whole vault's: a count
   * over the unfiltered set would move with a page the caller may not
   * read. A local caller passes nothing.
   */
  readonly keepFinding?: (finding: HygieneFinding) => boolean;
  /**
   * Whether the search writer lock is held at this index path. Injected
   * only by tests - the product asks `isWriterLockHeld`, and a throw from
   * it reads `unknown` rather than `free`, exactly as that module's
   * contract requires. Named after `MigrationPlanInput.writerLockHeldAt`,
   * so the two seams read as one pattern.
   */
  readonly writerLockHeldAt?: (dbPath: string) => boolean;
}

/**
 * Compose the operator snapshot. Async because the review-candidates
 * source runs a dry-run dream (read-only). Never mutates the vault.
 */
export async function buildOperatorSnapshot(
  vault: string,
  opts: BuildOperatorSnapshotOptions = {},
): Promise<OperatorSnapshot> {
  const now = opts.now ?? new Date();
  const problems: SnapshotProblem[] = [];
  const problem = (code: string, detail: string): void => {
    const sig = resolveSignal(code);
    problems.push({ code, label: sig.issueClass, detail, nextCommand: sig.nextCommand });
  };

  // --- State-file health ---
  const configPresent = existsSync(brainConfigPath(vault));
  let searchDbPath: string | null = null;
  try {
    searchDbPath = resolveSearchConfig({ vault, configPath: opts.configPath ?? undefined }).dbPath;
  } catch {
    searchDbPath = null;
  }
  const searchIndexPresent = searchDbPath !== null && existsSync(searchDbPath);
  if (!configPresent) {
    problem("state-file", "Brain config `_brain.yaml` is missing");
  }

  // --- Store ownership (t_cfe2ce5d) ---
  const store = readStoreGroup(searchDbPath, now, opts.writerLockHeldAt);

  // --- Automatic upgrade ---
  const selfHealUpgradeFailure = readSelfHealUpgradeFailure(vault);
  if (selfHealUpgradeFailure !== null) {
    problem("self-heal-upgrade-failed", describeSelfHealUpgradeFailure(selfHealUpgradeFailure));
  }

  // --- Doctor + semantic health ---
  let healthVerdict = "clean";
  try {
    // Thread the resolved search DB path so DB-backed findings (e.g.
    // tier-drift) are included rather than silently skipped.
    const doctor = runDoctor(vault, {
      now,
      ...(searchDbPath !== null ? { dbPath: searchDbPath } : {}),
    });
    if (doctor.errors.length > 0) {
      problem("doctor-errors", `${doctor.errors.length} invariant error(s)`);
    }
    if (doctor.warnings.length > 0) {
      problem("doctor-warnings", `${doctor.warnings.length} warning(s)`);
    }
    const verdict = doctor.semantic_health?.verdict;
    if (verdict !== undefined) healthVerdict = verdict;
    if (verdict !== undefined && verdict !== "clean") {
      problem("semantic-health", `semantic-health verdict: ${verdict}`);
    }
  } catch {
    // A failed probe must degrade the snapshot, never read as all-clear.
    problem("doctor-errors", "doctor probe failed to run");
  }

  // --- Hygiene ---
  try {
    const hy = runHygieneScan(vault, {
      now,
      ...(opts.readable !== undefined ? { readable: opts.readable } : {}),
    });
    const keepFinding = opts.keepFinding;
    const findings =
      keepFinding === undefined ? hy.findings : hy.findings.filter((f) => keepFinding(f));
    if (findings.length > 0) {
      problem("hygiene-findings", `${findings.length} hygiene finding(s)`);
    }
  } catch {
    problem("hygiene-findings", "hygiene scan failed to run");
  }

  // --- Stale scan ---
  let staleTotal = 0;
  try {
    const cfg = loadTemporalConfigSafe(vault);
    const index = buildTimelineIndex(vault, {});
    const stale = findStaleEntries(index, vault, cfg, { now });
    staleTotal =
      stale.stalePreferences.length + stale.staleSignals.length + stale.staleLogFiles.length;
    if (staleTotal > 0) {
      problem("stale-notes", `${staleTotal} stale entr${staleTotal === 1 ? "y" : "ies"}`);
    }
  } catch {
    problem("stale-notes", "stale scan failed to run");
  }

  // --- Review candidates (dry-run dream) ---
  let reviewQueue = 0;
  try {
    const review = await buildReviewCandidates(vault, { now });
    reviewQueue =
      review.would_create.length + review.would_promote.length + review.would_retire.length;
    if (reviewQueue > 0) {
      problem("review-queue", `${reviewQueue} review candidate(s) pending`);
    }
  } catch {
    problem("review-queue", "review-candidate scan failed to run");
  }

  // --- Active profile (informational) ---
  let activeProfile: string | null = null;
  if (opts.configPath !== undefined) {
    try {
      activeProfile = listProfiles(opts.configPath).active;
    } catch {
      activeProfile = null;
    }
  }

  return Object.freeze({
    counts: Object.freeze({
      preferences: countMarkdown(brainDirs(vault).preferences),
      retired: countMarkdown(brainDirs(vault).retired),
      inbox: countMarkdown(brainDirs(vault).inbox),
    }),
    staleTotal,
    reviewQueue,
    activeProfile,
    stateFiles: Object.freeze({ config: configPresent, searchIndex: searchIndexPresent }),
    healthVerdict,
    problems: Object.freeze(problems),
    healthy: problems.length === 0,
    frozen: readFreezeMarker(vault),
    selfHealUpgradeFailure,
    store,
  });
}

/**
 * Ask the search writer lock its three-state answer, wrapped fail-soft
 * exactly like the migration preflight's `writerLockRefusal`: a probe
 * that throws reads `unknown` with the errno in the reason, because
 * "I could not find out" is not "the lock is free". An index path that
 * never resolved is the same honest state - the lock could not be probed
 * at all - so it reads `unknown` too, with the reason naming that.
 */
function readStoreGroup(
  dbPath: string | null,
  now: Date,
  probe: ((dbPath: string) => boolean) | undefined,
): SnapshotStore {
  if (dbPath === null) {
    return Object.freeze({
      writerLock: WRITER_LOCK_STATE.unknown,
      writerLockReason: "the search index path could not be resolved, so the lock was not probed",
      writerLockAgeMs: null,
      writerLockOwner: null,
      writerLockPath: null,
      thisCaller: THIS_CALLER_READ_ONLY,
    });
  }
  let held: boolean;
  try {
    held = (probe ?? isWriterLockHeld)(dbPath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    return Object.freeze({
      writerLock: WRITER_LOCK_STATE.unknown,
      writerLockReason: `the writer lock state could not be determined (${err.code ?? "unknown error"}): ${err.message}`,
      writerLockAgeMs: null,
      writerLockOwner: null,
      writerLockPath: dbPath,
      thisCaller: THIS_CALLER_READ_ONLY,
    });
  }
  return Object.freeze({
    writerLock: held ? WRITER_LOCK_STATE.held : WRITER_LOCK_STATE.free,
    writerLockReason: null,
    writerLockAgeMs: held ? lockAgeMs(dbPath, now) : null,
    writerLockOwner: null,
    writerLockPath: dbPath,
    thisCaller: THIS_CALLER_READ_ONLY,
  });
}

/**
 * The held lock's mtime age against the snapshot clock, or `null` when the
 * stat fails - a best-effort measurement beside a state that is already
 * known, never a second chance to claim a state that is not.
 */
function lockAgeMs(dbPath: string, now: Date): number | null {
  try {
    return Math.max(0, Math.round(now.getTime() - statSync(writerLockDir(dbPath)).mtimeMs));
  } catch {
    return null;
  }
}

/**
 * The lock directory `proper-lockfile` creates for an index path: a bare
 * `${dbPath}.lock` directory whose only metadata is its mtime (`getLockFile`
 * in `proper-lockfile/lib/lockfile.js`; `writer-lock.ts` takes it with
 * `mkdir`). Spelled here because the age reads that directory's mtime, and
 * the state probe (`isWriterLockHeld`) asks the same path behind the same
 * library.
 */
const WRITER_LOCK_SUFFIX = ".lock";

function writerLockDir(dbPath: string): string {
  return `${dbPath}${WRITER_LOCK_SUFFIX}`;
}

/**
 * Render the snapshot as compact operator-readable text. A healthy vault
 * prints a single all-clear line plus the summary; otherwise each problem
 * prints with its next command underneath.
 */
export function renderOperatorSnapshot(snap: OperatorSnapshot): string {
  const out: string[] = [];
  const header = snap.healthy
    ? "Vault status: all clear"
    : `Vault status: ${snap.problems.length} problem(s)`;
  out.push(header);
  out.push(
    `  preferences: ${snap.counts.preferences}   retired: ${snap.counts.retired}` +
      `   inbox: ${snap.counts.inbox}`,
  );
  out.push(`  stale: ${snap.staleTotal}   review queue: ${snap.reviewQueue}`);
  out.push(`  active profile: ${snap.activeProfile ?? "none"}`);
  out.push(
    `  state files: config ${snap.stateFiles.config ? "ok" : "MISSING"}, ` +
      `search index ${snap.stateFiles.searchIndex ? "present" : "absent"}`,
  );
  out.push(`  health: ${snap.healthVerdict}`);
  // Printed on BOTH branches, and that is the point: "no line" would be
  // indistinguishable from a renderer that forgot to ask, and the state
  // an operator most needs stated is the one where nothing is writing.
  out.push(
    snap.frozen === null
      ? "  frozen: no"
      : `  frozen: yes - set at ${snap.frozen.frozen_at} by ` +
          `${snap.frozen.by === "" ? "an unnamed agent" : snap.frozen.by} ` +
          `(${snap.frozen.reason === "" ? "no reason given" : snap.frozen.reason}); ` +
          `lift with \`${FREEZE_NEXT_COMMAND}\``,
  );
  // Printed on BOTH branches, like the frozen line: the state an operator
  // most needs stated is the one where nothing is writing, and "no line"
  // would be indistinguishable from a renderer that forgot to ask. A held
  // lock names the refusal an INDEX write would hit - scoped to what the
  // lock gates, since vault and memory writes serialize elsewhere - so
  // the agent reading this before writing does not learn it from the
  // write failing.
  out.push(`  ${renderStoreLine(snap.store)}`);

  if (!snap.healthy) {
    out.push("");
    out.push("Problems:");
    for (const p of snap.problems) {
      out.push(`  [${p.code}] ${p.detail}`);
      out.push(`    -> next: ${p.nextCommand}`);
    }
  }
  out.push("");
  return out.join("\n");
}

/** Count `.md` files directly under `dir` (non-recursive). Missing dir = 0. */
function countMarkdown(dir: string): number {
  if (!existsSync(dir)) return 0;
  try {
    let n = 0;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".md")) continue;
      try {
        if (statSync(join(dir, name)).isFile()) n += 1;
      } catch {
        /* race: skip */
      }
    }
    return n;
  } catch {
    return 0;
  }
}

/** Age suffix for the held-lock line; absent when the mtime was unreadable. */
function heldForSuffix(ageMs: number | null): string {
  return ageMs === null ? "" : ` for ${ageMs}ms`;
}

/**
 * The one store line, rendered for every state the group can hold. The
 * owner's absence is stated when the lock is held - the lock record
 * carries no identity, and silence would read as a renderer that forgot
 * to ask who - and the held line names the concrete refusal an index
 * writer hits (`INDEX_LOCKED`, the search lane's typed contention
 * error), scoped to what the search writer lock gates: vault and memory
 * writes serialize on the brain lane's own lock files and are not gated
 * by this lock, so the line says so rather than implying a refusal the
 * lock cannot cause.
 */
function renderStoreLine(store: SnapshotStore): string {
  const caller = `this caller ${store.thisCaller}`;
  switch (store.writerLock) {
    case WRITER_LOCK_STATE.free:
      return `store: writer lock free; ${caller}`;
    case WRITER_LOCK_STATE.held:
      return (
        `store: writer lock held${heldForSuffix(store.writerLockAgeMs)} ` +
        "(owner: unknown, the lock record carries no identity; " +
        "an index write (o2b search index / reindex) would refuse with INDEX_LOCKED; " +
        "vault and memory writes are not gated by this lock); " +
        caller
      );
    case WRITER_LOCK_STATE.unknown:
      return `store: writer lock state unknown (${store.writerLockReason ?? "reason unavailable"}); ${caller}`;
  }
}
