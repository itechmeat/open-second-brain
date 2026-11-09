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
 * On a store-only machine (task 2.10) the signals are the store's signal
 * fold and the backfill is one `signal-state` record of the field per
 * signal; no page is rewritten.
 *
 * Only session-sourced brain-signals under `Brain/inbox/` (which contains
 * `processed/`) are considered - the sole write target of the session
 * import path.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { BRAIN_INBOX_REL } from "./paths.ts";
import { BRAIN_SIGNAL_SOURCE_TYPE } from "./types.ts";
import { parseFrontmatter, writeFrontmatterAtomic } from "../vault.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";
import { readStoreEntities } from "../store/read/store-entities.ts";
import { SIGNAL_FOLDER, signalPageRel } from "../store/read/memory-ids.ts";
import { routeSignalState, signalsStoreOnly } from "./signal-state.ts";

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

/** One signal of the inbox tree, with its frontmatter. */
interface InboxSignal {
  readonly id: string;
  readonly path: string;
  readonly meta: Record<string, unknown>;
  readonly body: string;
}

/**
 * The signals of the inbox tree (the inbox, `processed/` and `archived/`),
 * sorted by path: the files on an unswitched machine, the store's signal
 * fold once switched (active, consumed and archived signals).
 */
function inboxSignals(vault: string): InboxSignal[] {
  if (signalsStoreOnly(vault)) {
    const out: InboxSignal[] = [];
    for (const [id, signal] of readStoreEntities()?.signals ?? []) {
      if (!INBOX_TREE_STATES.has(signal.state)) continue;
      // The page the signal's state places it at, not the capture path
      // its first record named (a consumed signal no longer sits there).
      const rel = signalPageRel(id, signal.state);
      out.push({
        id,
        path: join(vault, ...rel.split("/")),
        meta: { ...signal.frontmatter },
        body: "",
      });
    }
    return out.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
  const inbox = join(vault, BRAIN_INBOX_REL);
  if (!existsSync(inbox)) return [];
  const files: string[] = [];
  collectMarkdown(inbox, files);
  files.sort();
  const out: InboxSignal[] = [];
  for (const path of files) {
    try {
      const [meta, body] = parseFrontmatter(path);
      const id = typeof meta["id"] === "string" ? meta["id"] : basename(path, ".md");
      out.push({ id, path, meta: meta as Record<string, unknown>, body });
    } catch {
      // A file with unreadable/absent frontmatter is not a signal we own.
    }
  }
  return out;
}

/** The fold states whose signals live in the inbox tree (as `SIGNAL_FOLDER` places them). */
const INBOX_TREE_STATES: ReadonlySet<string> = new Set(
  Object.entries(SIGNAL_FOLDER)
    .filter(([, folder]) => folder === BRAIN_INBOX_REL || folder.startsWith(`${BRAIN_INBOX_REL}/`))
    .map(([state]) => state),
);

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
  // Vault-identity write guard (context-integrity-gates, Unit J).
  // Planning without `apply` writes nothing, so it stays ungated.
  if (apply) assertVaultIdentityForWrite(vault);
  const candidates: AuthoredAtBackfillCandidate[] = [];
  let scanned = 0;
  let updated = 0;

  for (const signal of inboxSignals(vault)) {
    const meta = signal.meta;
    if (meta["kind"] !== "brain-signal") continue;
    if (meta["source_type"] !== BRAIN_SIGNAL_SOURCE_TYPE.session) continue;
    scanned++;
    // Already backfilled → idempotent skip.
    if (trimmedField(meta, "authored_at") !== null) continue;
    // The transcript turn instant: what the import preserved when the turn
    // carried a usable timestamp. Absent → no turn instant → leave unchanged.
    const instant = trimmedField(meta, "valid_from") ?? trimmedField(meta, "recorded_at");
    if (instant === null) continue;
    candidates.push(Object.freeze({ path: signal.path, authoredAt: instant }));
    if (apply) {
      // The page on an unswitched machine (plus the dual write), one
      // `signal-state` record of the field once switched (task 2.10).
      routeSignalState({
        vault,
        id: signal.id,
        fields: { authored_at: instant },
        legacyFrontmatter: meta,
        legacy: () =>
          writeFrontmatterAtomic(signal.path, { ...meta, authored_at: instant }, signal.body, {
            overwrite: true,
          }),
      });
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
