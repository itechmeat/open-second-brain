/**
 * Conversation-chronology backfill (S1 / t_347e8224).
 *
 * Going forward, `importSession` stamps each session-imported signal with
 * an `authored_at` frontmatter field carrying the transcript turn instant
 * (see `sessions/import.ts`). Vaults imported before this feature have the
 * instant preserved only in the bi-temporal `valid_from` / `recorded_at`
 * slots. This module materialises the additive `authored_at` field for
 * those pre-existing signals so the search layer can expose it and break
 * exact hybrid-score ties toward more recent statements.
 *
 * Contract:
 *   - Dry-run by DEFAULT: `planAuthoredAtBackfill` never writes; the
 *     caller opts into mutation with `applyAuthoredAtBackfill`.
 *   - Idempotent: a signal that already carries `authored_at` is skipped,
 *     so a re-run over an already-backfilled vault is a no-op.
 *   - Additive only, NO re-embedding by construction: the operation writes
 *     one frontmatter field and never touches the search index or any
 *     embedding provider.
 *   - Documents without a turn instant are unchanged: a signal that never
 *     preserved `valid_from` / `recorded_at` is not a transcript turn and
 *     is left exactly as-is.
 *
 * Only session-sourced brain-signals under `Brain/inbox/` (which contains
 * `processed/`) are considered - the sole write target of the session
 * import path.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { BRAIN_INBOX_REL } from "./paths.ts";
import { BRAIN_SIGNAL_SOURCE_TYPE } from "./types.ts";
import { parseFrontmatter, writeFrontmatterAtomic } from "../vault.ts";

/** One signal that carries a preserved turn instant but no `authored_at`. */
export interface AuthoredAtBackfillCandidate {
  /** Absolute path to the signal file. */
  readonly path: string;
  /** The `authored_at` value that would be (or was) written. */
  readonly authoredAt: string;
}

export interface AuthoredAtBackfillResult {
  /** Whether the run mutated files (`false` for a dry run). */
  readonly applied: boolean;
  /** Signal files scanned (brain-signals under the inbox tree). */
  readonly scanned: number;
  /** Signals that qualify for a backfill (missing `authored_at`). */
  readonly candidates: ReadonlyArray<AuthoredAtBackfillCandidate>;
  /** Files actually rewritten (0 on a dry run). */
  readonly updated: number;
}

export interface AuthoredAtBackfillOptions {
  /**
   * When true, rewrite each candidate's frontmatter with the additive
   * `authored_at` field. Default false → a pure dry run that only reports.
   */
  readonly apply?: boolean;
}

/** Read a trimmed non-empty string frontmatter field, else null. */
function trimmedField(meta: Record<string, unknown>, key: string): string | null {
  const raw = meta[key];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Recursively collect `.md` file paths under a directory. */
function collectMarkdown(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      collectMarkdown(full, out);
      continue;
    }
    if (name.endsWith(".md")) out.push(full);
  }
}

/**
 * Scan the inbox tree for session-imported signals that preserved a turn
 * instant (`valid_from` / `recorded_at`) but predate the `authored_at`
 * field. When `apply` is set, materialise the field; otherwise report the
 * candidates without writing.
 */
export function planAuthoredAtBackfill(
  vault: string,
  opts: AuthoredAtBackfillOptions = {},
): AuthoredAtBackfillResult {
  const apply = opts.apply === true;
  const inbox = join(vault, BRAIN_INBOX_REL);
  const candidates: AuthoredAtBackfillCandidate[] = [];
  let scanned = 0;
  let updated = 0;

  if (!existsSync(inbox)) {
    return Object.freeze({ applied: apply, scanned, candidates: Object.freeze([]), updated });
  }

  const files: string[] = [];
  collectMarkdown(inbox, files);
  files.sort();

  for (const path of files) {
    let meta: Record<string, unknown>;
    let body: string;
    try {
      const [parsedMeta, parsedBody] = parseFrontmatter(path);
      meta = parsedMeta as Record<string, unknown>;
      body = parsedBody;
    } catch {
      // A file with unreadable/absent frontmatter is not a signal we own.
      continue;
    }
    if (meta["kind"] !== "brain-signal") continue;
    if (meta["source_type"] !== BRAIN_SIGNAL_SOURCE_TYPE.session) continue;
    scanned++;
    // Already backfilled → idempotent skip.
    if (trimmedField(meta, "authored_at") !== null) continue;
    // The transcript turn instant: what the import preserved when the turn
    // carried a usable timestamp. Absent → no turn instant → leave unchanged.
    const instant = trimmedField(meta, "valid_from") ?? trimmedField(meta, "recorded_at");
    if (instant === null) continue;
    candidates.push(Object.freeze({ path, authoredAt: instant }));
    if (apply) {
      writeFrontmatterAtomic(path, { ...meta, authored_at: instant }, body, { overwrite: true });
      updated++;
    }
  }

  return Object.freeze({
    applied: apply,
    scanned,
    candidates: Object.freeze(candidates),
    updated,
  });
}
