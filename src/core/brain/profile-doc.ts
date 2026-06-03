/**
 * Shell-native Brain profile (Workspace Insight Suite, t_323a9a83).
 *
 * `Brain/profile.md` is a materialized compact digest of the current
 * Brain - static facts (artifact counts), the highest-confidence
 * preferences, and recent activity - so simple agents, scripts, and
 * humans can `cat` one file instead of learning MCP tools. The
 * companion `.o2bfs` marker at the vault root lets shell wrappers
 * detect a Brain root safely before applying any semantic behaviour.
 *
 * Built from the morning-brief kernel plus cheap directory counts;
 * never walks the whole vault. Regeneration is age-gated by
 * {@link isProfileStale} so repeated calls stay cheap.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { buildMorningBrief } from "./morning-brief.ts";

export const PROFILE_DOC_REL = join("Brain", "profile.md");
export const O2BFS_MARKER_FILE = ".o2bfs";

export interface ProfileDoc {
  readonly text: string;
  readonly generatedAt: string;
}

export interface ProfileDocOptions {
  readonly now: Date;
  /** Max preferences listed; default 10. */
  readonly topK?: number;
}

function countMdFiles(dir: string): number {
  try {
    return readdirSync(dir).filter((name) => name.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

/** Assemble the profile document. Read-only; deterministic given `now`. */
export function buildProfileDoc(vault: string, opts: ProfileDocOptions): ProfileDoc {
  const generatedAt = opts.now.toISOString();
  const brief = buildMorningBrief(vault, { now: opts.now, topK: opts.topK ?? 10 });

  const confirmed = countMdFiles(join(vault, "Brain", "preferences"));
  const signals = countMdFiles(join(vault, "Brain", "inbox"));
  const logDays = countMdFiles(join(vault, "Brain", "log"));

  const lines: string[] = [
    "---",
    `generated_at: ${generatedAt}`,
    "generator: open-second-brain profile",
    "---",
    "",
    "# Brain profile",
    "",
    "Auto-generated digest. Do not edit - regenerate with `o2b brain profile`.",
    "",
    "## Facts",
    "",
    `- confirmed preferences: ${confirmed}`,
    `- inbox signals: ${signals}`,
    `- log days on record: ${logDays}`,
    "",
  ];

  if (brief.preferences.length > 0) {
    lines.push("## Top preferences", "");
    for (const pref of brief.preferences) {
      lines.push(`- ${pref.id}: ${pref.principle}${pref.trimmed ? " …" : ""}`);
    }
    lines.push("");
  }
  if (brief.openQuestions.length > 0) {
    lines.push("## Open questions", "");
    for (const q of brief.openQuestions) lines.push(`- ${q.topic} (${q.domain})`);
    lines.push("");
  }
  if (brief.recentNotes.length > 0) {
    lines.push("## Recent activity", "");
    for (const note of brief.recentNotes) lines.push(`- ${note}`);
    lines.push("");
  }

  return Object.freeze({ text: lines.join("\n"), generatedAt });
}

export interface WriteProfileResult {
  readonly path: string;
  readonly markerPath: string;
  readonly generatedAt: string;
}

/** Materialize `Brain/profile.md` and the `.o2bfs` root marker. */
export function writeProfileDoc(vault: string, opts: ProfileDocOptions): WriteProfileResult {
  const doc = buildProfileDoc(vault, opts);
  const path = join(vault, PROFILE_DOC_REL);
  atomicWriteFileSync(path, doc.text);
  const markerPath = join(vault, O2BFS_MARKER_FILE);
  atomicWriteFileSync(
    markerPath,
    JSON.stringify({ vault, generated_at: doc.generatedAt }, null, 2) + "\n",
  );
  return Object.freeze({ path, markerPath, generatedAt: doc.generatedAt });
}

/**
 * True when the materialized profile is missing or older than
 * `maxAgeSeconds` relative to `now`.
 */
export function isProfileStale(vault: string, maxAgeSeconds: number, now: Date): boolean {
  const path = join(vault, PROFILE_DOC_REL);
  if (!existsSync(path)) return true;
  try {
    const mtimeMs = statSync(path).mtimeMs;
    return now.getTime() - mtimeMs > maxAgeSeconds * 1000;
  } catch {
    return true;
  }
}
