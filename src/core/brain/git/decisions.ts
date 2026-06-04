/**
 * Commit-decision miner (Project History Suite, t_93d299bb).
 *
 * Deterministic heuristics over INGESTED commit records (never live
 * git): conventional breaking markers, BREAKING CHANGE footers, a
 * word-boundary decision keyword set, and revert shape. Same store,
 * same candidates, same order - no LLM classification anywhere.
 *
 * Each decision-shaped commit becomes one draft ADR candidate note at
 * `Brain/decisions/candidates/adr-<shortsha>-<slug>.md` with the
 * matched signals as provenance. Candidate identity is the commit sha,
 * so re-runs are duplicate-free; an EXISTING candidate file is never
 * touched (skip-existing, variants.md orchestrator refinement 3) - once
 * an operator starts curating a draft, regeneration cannot clobber it.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "../../fs-atomic.ts";
import { listGitCommits } from "./store.ts";
import type { GitCommitRecord } from "./store.ts";

/** Phrases that mark a commit message as decision-shaped. */
const DECISION_KEYWORDS = [
  "decide",
  "decided",
  "decision",
  "adopt",
  "adopted",
  "switch to",
  "migrate to",
  "instead of",
  "adr",
  "rationale",
] as const;

const CONVENTIONAL_BREAKING_RE = /^[a-z]+(\([^)]*\))?!:/;
const REVERT_RE = /^revert\b/i;
const SLUG_MAX = 40;
// 12 hex chars: git's own "unambiguous in large repos" abbreviation
// length. Identity must not collide - a collision here would silently
// skip a real decision via the skip-existing rule.
const CANDIDATE_SHA_LEN = 12;

/**
 * Matched signal ids for one commit message, deterministic order.
 * Empty array = not decision-shaped.
 */
export function detectDecisionSignals(subject: string, body: string): ReadonlyArray<string> {
  const signals: string[] = [];
  if (CONVENTIONAL_BREAKING_RE.test(subject)) signals.push("conventional_breaking");
  if (/^BREAKING CHANGE\b/m.test(body)) signals.push("breaking_change_footer");
  const haystack = `${subject}\n${body}`.toLowerCase();
  for (const keyword of DECISION_KEYWORDS) {
    // Word-boundary match: 'adopt' must not fire inside 'adoption'.
    const re = new RegExp(`\\b${keyword.replace(/ /g, "\\s+")}\\b`);
    if (re.test(haystack)) signals.push(`decision_keyword:${keyword}`);
  }
  if (REVERT_RE.test(subject)) signals.push("revert");
  return Object.freeze(signals);
}

function slugFromSubject(subject: string): string {
  const slug = subject
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
  return slug === "" ? "decision" : slug;
}

function renderCandidate(
  repoKey: string,
  commit: GitCommitRecord,
  signals: ReadonlyArray<string>,
): string {
  const lines: string[] = [
    "---",
    "kind: adr-candidate",
    "status: candidate",
    `repo_key: ${repoKey}`,
    `sha: ${commit.sha}`,
    `committed_at: ${commit.committedAt}`,
    `signals: [${signals.join(", ")}]`,
    "---",
    "",
    `# ADR candidate: ${commit.subject}`,
    "",
    `Mined from commit ${commit.sha.slice(0, 7)} in [[Brain/projects/git/${repoKey}/digest|${repoKey}]].`,
    "",
    "## Source commit",
    "",
    `- sha: \`${commit.sha}\``,
    `- author: ${commit.authorName}`,
    `- date: ${commit.committedAt}`,
    ...(commit.release !== null ? [`- release: ${commit.release}`] : []),
    `- matched signals: ${signals.join(", ")}`,
    "",
    "> " + commit.subject,
    ...(commit.body === "" ? [] : [">", ...commit.body.split("\n").map((line) => `> ${line}`)]),
    "",
    "## Decision",
    "",
    "Draft pending operator review: capture context, options considered, and the final call here.",
    "",
  ];
  return lines.join("\n");
}

export interface MineCommitDecisionsResult {
  readonly repoKey: string;
  readonly scanned: number;
  readonly candidates: number;
  readonly created: number;
  readonly skippedExisting: number;
  /** Absolute paths of all candidate notes for this repo (new + prior). */
  readonly notes: ReadonlyArray<string>;
}

/** Mine one repo's ingested commits into ADR candidate notes. */
export function mineCommitDecisions(vault: string, repoKey: string): MineCommitDecisionsResult {
  const commits = listGitCommits(vault, repoKey);
  const dir = join(vault, "Brain", "decisions", "candidates");
  let created = 0;
  let skippedExisting = 0;
  const notes: string[] = [];
  for (const commit of commits) {
    const signals = detectDecisionSignals(commit.subject, commit.body);
    if (signals.length === 0) continue;
    const path = join(
      dir,
      `adr-${commit.sha.slice(0, CANDIDATE_SHA_LEN)}-${slugFromSubject(commit.subject)}.md`,
    );
    notes.push(path);
    if (existsSync(path)) {
      // Operator-curated drafts are sacrosanct: identity by sha means
      // this is the same decision, already on its review journey.
      skippedExisting += 1;
      continue;
    }
    mkdirSync(dir, { recursive: true });
    atomicWriteFileSync(path, renderCandidate(repoKey, commit, signals));
    created += 1;
  }
  return Object.freeze({
    repoKey,
    scanned: commits.length,
    candidates: notes.length,
    created,
    skippedExisting,
    notes: Object.freeze(notes),
  });
}
