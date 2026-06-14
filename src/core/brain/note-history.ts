/**
 * Episodic note-history decomposition (Session Knowledge Synthesis,
 * t_6a201155).
 *
 * Turns a note's git commit chain into recallable episodic phases. The
 * split rule is deterministic and structural - a new phase starts when
 * the gap between consecutive commits exceeds a threshold - so it is
 * language-agnostic (commit-message wording never affects the split)
 * and reproducible. Each phase carries the real commit subjects the
 * author wrote, which is its summary; nothing is generated and the
 * kernel never calls an LLM.
 *
 * Fail-soft and honest about absence: a missing repo or a git failure
 * reports `available: false` (the underlying reader returns null); a
 * real repo where no commit touches the path reports `available: true`
 * with zero phases (empty != broken). No fabricated phase is ever
 * returned for a path with no history.
 */

import { readCommits } from "./git/reader.ts";
import type { GitCommit } from "./git/reader.ts";

export interface NoteHistoryPhase {
  /** 0-based phase index, oldest first. */
  readonly index: number;
  readonly firstSha: string;
  readonly lastSha: string;
  /** Author date of the earliest / latest commit in the phase (ISO-8601). */
  readonly firstDate: string;
  readonly lastDate: string;
  readonly commitCount: number;
  /** Distinct author names in the phase, first-seen order. */
  readonly authors: ReadonlyArray<string>;
  /** Commit subjects in the phase, oldest first - the phase's summary. */
  readonly subjects: ReadonlyArray<string>;
}

export interface NoteHistoryResult {
  readonly notePath: string;
  /** False only when there is no git history to read (no repo / git failed). */
  readonly available: boolean;
  /** Human-readable reason when there are no phases. */
  readonly reason?: string;
  readonly commitCount: number;
  readonly phases: ReadonlyArray<NoteHistoryPhase>;
}

export interface DecomposeNoteHistoryOptions {
  /** A gap larger than this between consecutive commits starts a new phase. Default 72h. */
  readonly gapHours?: number;
  /** Repository root to read from. Default: the vault directory. */
  readonly repoPath?: string;
  /** Bound the walk to the newest N commits touching the path. */
  readonly maxCount?: number;
}

const DEFAULT_GAP_HOURS = 72;
const HOUR_MS = 60 * 60 * 1000;

export function decomposeNoteHistory(
  vault: string,
  notePath: string,
  opts: DecomposeNoteHistoryOptions = {},
): NoteHistoryResult {
  const path = notePath.trim();
  if (path.length === 0) {
    return Object.freeze({
      notePath,
      available: false,
      reason: "no note path given",
      commitCount: 0,
      phases: Object.freeze([]),
    });
  }

  const repoPath = opts.repoPath ?? vault;
  const commits = readCommits(repoPath, {
    path,
    ...(opts.maxCount !== undefined ? { maxCount: opts.maxCount } : {}),
  });

  if (commits === null) {
    return Object.freeze({
      notePath: path,
      available: false,
      reason: "no history available (not a git repository or git unavailable)",
      commitCount: 0,
      phases: Object.freeze([]),
    });
  }
  if (commits.length === 0) {
    return Object.freeze({
      notePath: path,
      available: true,
      reason: "no commits touch this path",
      commitCount: 0,
      phases: Object.freeze([]),
    });
  }

  const gapMs = Math.max(0, opts.gapHours ?? DEFAULT_GAP_HOURS) * HOUR_MS;
  const phases = splitIntoPhases(commits, gapMs);
  return Object.freeze({
    notePath: path,
    available: true,
    commitCount: commits.length,
    phases: Object.freeze(phases),
  });
}

function splitIntoPhases(commits: ReadonlyArray<GitCommit>, gapMs: number): NoteHistoryPhase[] {
  const groups: GitCommit[][] = [];
  let current: GitCommit[] = [];
  let prevMs: number | null = null;
  for (const commit of commits) {
    const ms = parseMs(commit.committedAt);
    const gap = prevMs !== null && ms !== null ? ms - prevMs : 0;
    if (current.length > 0 && gap > gapMs) {
      groups.push(current);
      current = [];
    }
    current.push(commit);
    if (ms !== null) prevMs = ms;
  }
  if (current.length > 0) groups.push(current);
  return groups.map((group, index) => toPhase(group, index));
}

function toPhase(group: ReadonlyArray<GitCommit>, index: number): NoteHistoryPhase {
  const first = group[0]!;
  const last = group[group.length - 1]!;
  const authors: string[] = [];
  for (const commit of group) {
    if (commit.authorName.length > 0 && !authors.includes(commit.authorName)) {
      authors.push(commit.authorName);
    }
  }
  return Object.freeze({
    index,
    firstSha: first.sha,
    lastSha: last.sha,
    firstDate: first.committedAt,
    lastDate: last.committedAt,
    commitCount: group.length,
    authors: Object.freeze(authors),
    subjects: Object.freeze(group.map((commit) => commit.subject)),
  });
}

function parseMs(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}
