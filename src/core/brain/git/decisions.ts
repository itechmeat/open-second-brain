/**
 * Commit-decision miner (Project History Suite, t_93d299bb).
 *
 * Deterministic heuristics over INGESTED commit records (never live
 * git): conventional breaking markers, BREAKING CHANGE footers, and
 * revert shape - all fixed commit-protocol tokens, language-agnostic.
 * Same store, same candidates, same order - no LLM classification
 * anywhere.
 *
 * Each decision-shaped commit becomes one draft ADR candidate note at
 * `Brain/decisions/candidates/adr-<shortsha>-<slug>.md` with the
 * matched signals as provenance. Candidate identity is the commit sha,
 * so re-runs are duplicate-free; an EXISTING candidate file is never
 * touched (skip-existing, variants.md orchestrator refinement 3) - once
 * an operator starts curating a draft, regeneration cannot clobber it.
 */

import { join } from "node:path";

import { listGitCommits } from "./store.ts";
import type { GitCommitRecord } from "./store.ts";
import {
  assertLaneWrite,
  lanePageExists,
  listLaneFiles,
  writeLaneText,
} from "../../store/lane-pages.ts";
import { hasTitleWords, titleKeySlug } from "../../vault.ts";

const CONVENTIONAL_BREAKING_RE = /^[a-z]+(\([^)]*\))?!:/;
const REVERT_RE = /^revert\b/i;
const SLUG_MAX = 40;
/** Cuts a slug between user-perceived characters, never inside one. */
const GRAPHEMES = new Intl.Segmenter("und", { granularity: "grapheme" });
// 12 hex chars: git's own "unambiguous in large repos" abbreviation
// length. Identity must not collide - a collision here would silently
// skip a real decision via the skip-existing rule.
const CANDIDATE_SHA_LEN = 12;

/**
 * Matched signal ids for one commit message, deterministic order.
 * Empty array = not decision-shaped.
 */
export function detectDecisionSignals(subject: string, body: string): ReadonlyArray<string> {
  // Language-agnostic by construction: only structural commit-protocol
  // markers count as decision signals. The old English keyword set
  // ("decide", "adopt", ...) never fired on a commit history written in
  // any other language; conventional-commit and git-native markers
  // (`type!:`, the `BREAKING CHANGE:` footer, the `Revert` prefix) are
  // fixed protocol tokens git/tooling emit, not free prose.
  const signals: string[] = [];
  if (CONVENTIONAL_BREAKING_RE.test(subject)) signals.push("conventional_breaking");
  if (/^BREAKING CHANGE\b/m.test(body)) signals.push("breaking_change_footer");
  if (REVERT_RE.test(subject)) signals.push("revert");
  return Object.freeze(signals);
}

/**
 * The subject's slug: letters of any script stay ({@link titleKeySlug}:
 * the name is `adr-<sha>-<slug>.md`, never a bare device name, so `CON`
 * stays `con`), cut to {@link SLUG_MAX} code units on a grapheme boundary,
 * so a base letter never loses its combining mark. A subject with no letter
 * or digit is `decision`, as it always was; that is decided by the subject
 * itself, so a literal subject such as `unnamed-deadbeef` keeps its words.
 * For an ASCII subject the slug is byte-identical to
 * {@link legacySlugFromSubject}.
 */
function slugFromSubject(subject: string): string {
  if (!hasTitleWords(subject)) return "decision";
  let cut = "";
  for (const { segment } of GRAPHEMES.segment(titleKeySlug(subject))) {
    if (cut.length + segment.length > SLUG_MAX) break;
    cut += segment;
  }
  return cut.replace(/-+$/u, "") || "decision";
}

/**
 * The Latin-only slug an older release named a candidate with. Where it
 * equals {@link slugFromSubject} (every ASCII subject) the candidate's file
 * name is unchanged, so no listing is needed to find an older one.
 */
function legacySlugFromSubject(subject: string): string {
  const slug = subject
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
  return slug === "" ? "decision" : slug;
}

/**
 * The candidate file names already in `dir`, by their `adr-<sha>-` prefix.
 * The sha is the candidate's identity and the slug after it is only a
 * label: an older release wrote it Latin-only ("feat!: Перейти на
 * Postgres" was `feat-postgres`), so a re-run matches by the prefix and
 * never writes a second candidate for the same commit under a new slug.
 */
function existingCandidatesBySha(vault: string, dir: string): Map<string, string> {
  const bySha = new Map<string, string>();
  for (const name of listLaneFiles(vault, dir, ".md")) {
    const match = /^adr-([0-9a-f]+)-/u.exec(name);
    if (match !== null && !bySha.has(match[1]!)) bySha.set(match[1]!, name);
  }
  return bySha;
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
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertLaneWrite(vault);
  const commits = listGitCommits(vault, repoKey);
  const dir = join(vault, "Brain", "decisions", "candidates");
  let created = 0;
  let skippedExisting = 0;
  const notes: string[] = [];
  let existing: Map<string, string> | null = null;
  for (const commit of commits) {
    const signals = detectDecisionSignals(commit.subject, commit.body);
    if (signals.length === 0) continue;
    const shortSha = commit.sha.slice(0, CANDIDATE_SHA_LEN);
    const slug = slugFromSubject(commit.subject);
    let name = `adr-${shortSha}-${slug}.md`;
    if (slug !== legacySlugFromSubject(commit.subject)) {
      // The name changed since an older release, so the candidate it may
      // have written is found by its sha. One listing per run, and only for
      // a subject whose slug changed: an ASCII subject's name is the old one.
      existing ??= existingCandidatesBySha(vault, dir);
      name = existing.get(shortSha) ?? name;
    }
    const path = join(dir, name);
    notes.push(path);
    if (lanePageExists(vault, path)) {
      // Operator-curated drafts are sacrosanct: identity by sha means
      // this is the same decision, already on its review journey.
      skippedExisting += 1;
      continue;
    }
    writeLaneText(vault, path, renderCandidate(repoKey, commit, signals));
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
