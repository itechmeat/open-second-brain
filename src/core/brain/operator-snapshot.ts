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

import { resolveSearchConfig } from "../search/index.ts";
import { runDoctor } from "./doctor.ts";
import { resolveSignal } from "./diagnostics.ts";
import { runHygieneScan } from "./hygiene/scan.ts";
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
}

export interface BuildOperatorSnapshotOptions {
  /** Config path for the search-index and profile lookups. */
  readonly configPath?: string;
  /** Wall clock for stale/review scans. Defaults to `new Date()`. */
  readonly now?: Date;
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
    const hy = runHygieneScan(vault, { now });
    if (hy.findings.length > 0) {
      problem("hygiene-findings", `${hy.findings.length} hygiene finding(s)`);
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
  });
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
        if (statSync(`${dir}/${name}`).isFile()) n += 1;
      } catch {
        /* race: skip */
      }
    }
    return n;
  } catch {
    return 0;
  }
}
