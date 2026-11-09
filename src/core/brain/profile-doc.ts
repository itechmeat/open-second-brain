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

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { buildMorningBrief } from "./morning-brief.ts";
import { fileAgeMs } from "./time.ts";
import {
  assertLaneWrite,
  lanePagesInStore,
  readLanePage,
  writeLaneText,
} from "../store/lane-pages.ts";
import { storeLogDays } from "./log-days.ts";
import { storeRecordPages } from "./memory-pages.ts";
import { brainDirs } from "./paths.ts";
import { isStoreOnly } from "../store/store-only.ts";
import { withOperationPrivacy } from "../store/operation-scope.ts";

/** Milliseconds in one second, for the `maxAgeSeconds` conversion. */
const MS_PER_SECOND = 1000;

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

/**
 * The profile's three counts: page files on an unswitched machine; on a
 * store-only one the preference pages, the inbox signals and the log days
 * the store's records render (the same folders, read from the store).
 */
function profileCounts(vault: string): {
  readonly confirmed: number;
  readonly signals: number;
  readonly logDays: number;
} {
  if (!isStoreOnly({ vault })) {
    const dirs = brainDirs(vault);
    return {
      confirmed: countMdFiles(dirs.preferences),
      signals: countMdFiles(dirs.inbox),
      logDays: countMdFiles(dirs.log),
    };
  }
  return {
    confirmed: storeRecordPages(vault, { kinds: new Set(["preference"]) }).length,
    signals: storeRecordPages(vault, {
      kinds: new Set(["signal"]),
      signalStates: new Set(["active"]),
    }).length,
    logDays: new Set((storeLogDays(vault) ?? []).map((day) => day.date)).size,
  };
}

/** Assemble the profile document. Read-only; deterministic given `now`. */
export function buildProfileDoc(vault: string, opts: ProfileDocOptions): ProfileDoc {
  const generatedAt = opts.now.toISOString();
  const brief = buildMorningBrief(vault, { now: opts.now, topK: opts.topK ?? 10 });

  const { confirmed, signals, logDays } = profileCounts(vault);

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
  /**
   * Where the profile is: the page on an unswitched machine; once
   * switched, its lane entry's name (`store:lanes/profile`), never a
   * vault path with no file behind it.
   */
  readonly path: string;
  /** The `.o2bfs` root marker, or `null` when none is written (store-only). */
  readonly markerPath: string | null;
  readonly generatedAt: string;
}

/** The name a store-only machine reports for its profile page. */
export const PROFILE_STORE_NAME = "store:lanes/profile";

/** Materialize `Brain/profile.md` and the `.o2bfs` root marker. */
export function writeProfileDoc(vault: string, opts: ProfileDocOptions): WriteProfileResult {
  // Vault-identity write guard (context-integrity-gates, Unit J) on an
  // unswitched machine; a store-only one writes a lane-entry record.
  assertLaneWrite(vault);
  const doc = buildProfileDoc(vault, opts);
  const path = join(vault, PROFILE_DOC_REL);
  const inStore = lanePagesInStore(vault);
  // The page lists the top principles, private ones included, as plain
  // lines no reference judge recognises: once switched its record is
  // private whenever any memory record it could draw on is (fail closed).
  withOperationPrivacy(
    () => inStore && storeRecordPages(vault, { signalStates: "all" }).some((p) => p.private),
    () => writeLaneText(vault, path, doc.text),
  );
  // The shell-root marker is a file at the vault root; a store-only
  // machine keeps no machine file in the vault (design D11), so only the
  // legacy layout writes it.
  if (inStore) {
    return Object.freeze({
      path: PROFILE_STORE_NAME,
      markerPath: null,
      generatedAt: doc.generatedAt,
    });
  }
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
  if (lanePagesInStore(vault)) {
    // The profile is a lane entry: its age is the time it was generated.
    const stamp = readLanePage(vault, path)?.frontmatter["generated_at"];
    const at = typeof stamp === "string" ? Date.parse(stamp) : Number.NaN;
    return Number.isNaN(at) || now.getTime() - at > maxAgeSeconds * MS_PER_SECOND;
  }
  // A missing root marker is stale too: shell-root detection depends
  // on it, so a deleted/failed marker must force regeneration.
  if (!existsSync(path) || !existsSync(join(vault, O2BFS_MARKER_FILE))) return true;
  const ageMs = fileAgeMs(path, now.getTime());
  // An unmeasurable age is stale, stated here rather than inherited from
  // a helper. This is the ONE gate on regeneration: a profile that exists
  // and cannot be aged is a profile nothing else will ever refresh, and
  // rewriting it costs a directory count. The opposite policy - the one
  // `idea-discovery` used to carry - would pin a broken profile as
  // permanently fresh.
  if (ageMs === null) return true;
  return ageMs > maxAgeSeconds * MS_PER_SECOND;
}
