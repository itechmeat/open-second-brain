/**
 * Per-repo digest note renderer (Project History Suite, t_c812752c).
 *
 * The digest is the FTS-discoverable anchor for a repo's ingested
 * history: one regenerated markdown note per repo, rendered ONLY from
 * store records (never hand-edited - the JSONL store is the source of
 * truth, the note is a projection). Deterministic by construction: no
 * timestamps, no environment - same records, same bytes, so an idle
 * re-ingest produces a zero diff.
 *
 * Repo file paths render as plain text, never wikilinks - they are not
 * vault notes. Only vault-resident promoted artifacts (ADR candidates)
 * are wikilinked, and those links are derived from records too.
 */

import type { GitCommitRecord, GitTagRecord } from "./store.ts";

const RECENT_COMMITS = 30;
const HOT_FILES = 15;

export interface GitDigestInput {
  readonly repoKey: string;
  readonly repoPath: string;
  readonly commits: ReadonlyArray<GitCommitRecord>;
  readonly tags: ReadonlyArray<GitTagRecord>;
  /** Vault-relative paths of promoted ADR candidate notes, per commit sha. */
  readonly promoted?: ReadonlyMap<string, string>;
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function day(iso: string): string {
  return iso.slice(0, 10);
}

/** Render the digest note body (frontmatter + sections). */
export function renderGitDigest(input: GitDigestInput): string {
  const { commits, tags } = input;
  const lines: string[] = [
    "---",
    "kind: git-digest",
    `repo_key: ${input.repoKey}`,
    `repo_path: ${input.repoPath}`,
    `commits: ${commits.length}`,
    `tags: ${tags.length}`,
    "---",
    "",
    `# Git history digest: ${input.repoKey}`,
    "",
    "Generated from the per-repo git record store. Do not edit - regenerated on every ingest.",
    "",
  ];

  // ── Releases ──
  lines.push("## Releases", "");
  if (tags.length === 0) {
    lines.push("No tags ingested.", "");
  } else {
    const countByRelease = new Map<string, number>();
    for (const commit of commits) {
      if (commit.release === null) continue;
      countByRelease.set(commit.release, (countByRelease.get(commit.release) ?? 0) + 1);
    }
    for (const tag of tags) {
      const date = tag.createdAt === null ? "unknown date" : day(tag.createdAt);
      const count = countByRelease.get(tag.name) ?? 0;
      lines.push(`- ${tag.name} (${date}, ${shortSha(tag.targetSha)}): ${count} commit(s)`);
    }
    lines.push("");
  }

  // ── Recent commits ──
  lines.push("## Recent commits", "");
  if (commits.length === 0) {
    lines.push("No commits ingested.", "");
  } else {
    for (const commit of commits.slice(-RECENT_COMMITS).toReversed()) {
      const release = commit.release === null ? "" : ` [${commit.release}]`;
      const promoted = input.promoted?.get(commit.sha);
      const link = promoted === undefined ? "" : ` -> [[${promoted}]]`;
      lines.push(
        `- ${day(commit.committedAt)} ${shortSha(commit.sha)} ${commit.subject}${release}${link}`,
      );
    }
    lines.push("");
  }

  // ── Hot files ──
  lines.push("## Hot files", "");
  const touches = new Map<string, { count: number; lastSubject: string }>();
  for (const commit of commits) {
    for (const file of commit.files) {
      const entry = touches.get(file);
      if (entry === undefined) touches.set(file, { count: 1, lastSubject: commit.subject });
      else {
        entry.count += 1;
        entry.lastSubject = commit.subject;
      }
    }
  }
  if (touches.size === 0) {
    lines.push("No file activity ingested.", "");
  } else {
    const hot = [...touches.entries()]
      .toSorted((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
      .slice(0, HOT_FILES);
    for (const [file, info] of hot) {
      lines.push(`- \`${file}\` - ${info.count} touch(es); last: ${info.lastSubject}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
