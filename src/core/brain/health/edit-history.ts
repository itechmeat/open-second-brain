/**
 * Per-preference edit-history sidecar (F4).
 *
 * Each content mutation of a preference appends one JSONL line to
 * `Brain/preferences/pref-<slug>.history.jsonl` recording the field that
 * changed and its before/after. The trail is append-only but
 * convergent under Syncthing: {@link appendEditHistory} skips any entry
 * whose `(revision, field, after)` triple already exists, so two peers
 * replaying the same write converge instead of duplicating. The sidecar
 * never enters the search index because the walker only yields `.md`
 * files.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { jsonlLedgerGrammar, readShardedLines } from "../ledger-shards.ts";
import { preferenceHistoryPath, preferenceHistoryStem } from "../paths.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";
import { processDirsEnv } from "../../platform-dirs.ts";
import { withLocalLock } from "../../store/local-lock.ts";
import { readLedgerRows } from "../../store/read/ledger-rows.ts";
import { isStoreOnly } from "../../store/store-only.ts";
import { storesStateDir } from "../../store/store-paths.ts";
import { dualWrite, type DualWriteRecord } from "../../store/dual-write.ts";
import { storeWrite } from "../../store/store-write.ts";
import { DUAL_WRITE_LEDGERS, ledgerRowRecord } from "../../store/dual-write-records.ts";
import { rowNamesPrivatePage } from "../../store/reference-privacy.ts";

export interface EditHistoryEntry {
  /** ISO timestamp of the mutation. */
  readonly ts: string;
  /** Agent identity that performed the write. */
  readonly agent: string;
  /** The preference `_revision` this entry produced. */
  readonly revision: number;
  /** The frontmatter field that changed (e.g. `principle`, `scope`). */
  readonly field: string;
  /** Prior value, or `null` when the field was absent before. */
  readonly before: string | null;
  /** New value, or `null` when the field was removed. */
  readonly after: string | null;
}

function dedupKey(e: EditHistoryEntry): string {
  return `${e.revision}\x00${e.field}\x00${e.after ?? "\x01"}`;
}

function isEntry(value: unknown): value is EditHistoryEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.ts === "string" &&
    typeof v.agent === "string" &&
    typeof v.revision === "number" &&
    typeof v.field === "string" &&
    (typeof v.before === "string" || v.before === null) &&
    (typeof v.after === "string" || v.after === null)
  );
}

/**
 * The sidecar shard family's layout for one slug. The base is the slug's
 * own `pref-<slug>.history` stem, escaped, so a slug containing a dot can
 * never be read as a device shard of a shorter slug.
 */
function historyGrammar(slug: string) {
  return jsonlLedgerGrammar(preferenceHistoryStem(slug));
}

/**
 * The preference's edit history: every device's shard on an unswitched
 * machine (malformed lines skipped, no shards -> `[]`), the
 * `edit-history` ledger rows of the store once switched (task 2.10).
 */
export function readEditHistory(vault: string | null, slug: string): EditHistoryEntry[] {
  return readLedgerRows<unknown>(
    DUAL_WRITE_LEDGERS.editHistory,
    (root) => readLegacyEditHistory(root, slug),
    { vault },
  ).flatMap((row) => {
    if (row === null || typeof row !== "object") return [];
    // A store row is `{ slug, entry }`; a legacy line is the entry itself.
    if ("entry" in row) {
      const { slug: rowSlug, entry } = row as { slug?: unknown; entry?: unknown };
      return rowSlug === slug && isEntry(entry) ? [entry] : [];
    }
    return isEntry(row) ? [row] : [];
  });
}

function readLegacyEditHistory(vault: string, slug: string): EditHistoryEntry[] {
  const dir = dirname(preferenceHistoryPath(vault, slug));
  const out: EditHistoryEntry[] = [];
  for (const line of readShardedLines(dir, historyGrammar(slug))) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (isEntry(parsed)) out.push(parsed);
    } catch {
      // malformed line - skip, do not throw
    }
  }
  return out;
}

/** Device-local lock of the store-only dedup read and append, per preference. */
const STORE_EDIT_HISTORY_LOCK_DIR = "edit-history-locks";

/**
 * Append `entries` to the sidecar, skipping any whose
 * `(revision, field, after)` already exists. Returns the number of
 * lines actually written. Creates the parent directory if missing.
 *
 * On a store-only machine (task 2.10, design D14 items 1 and 13) the
 * entries are `edit-history` ledger rows only, nothing under the vault
 * changes, and the store identity check of the store write replaces the
 * vault identity guard. The dedup read and the append are one critical
 * section under a device-local lock per preference, as for the other
 * store-only ledgers that dedup.
 */
export function appendEditHistory(
  vault: string | null,
  slug: string,
  entries: ReadonlyArray<EditHistoryEntry>,
): number {
  // No vault means store-only too (design D14).
  if (vault === null || isStoreOnly({ vault })) {
    if (entries.length === 0) return 0;
    return withLocalLock(
      join(storesStateDir(processDirsEnv()), STORE_EDIT_HISTORY_LOCK_DIR, `pref-${slug}`),
      () => {
        const appended = newEntries(readEditHistory(vault, slug), entries);
        if (appended.length > 0) storeWrite(() => historyRows(vault, slug, appended), { vault });
        return appended.length;
      },
    );
  }
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  if (entries.length === 0) return 0;
  const path = preferenceHistoryPath(vault, slug);
  const appended = newEntries(readEditHistory(vault, slug), entries);
  if (appended.length === 0) return 0;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, appended.map((e) => JSON.stringify(e)).join("\n") + "\n");
  // Brain store dual write (task 1.11): off by default, never fails this
  // append.
  dualWrite(() => historyRows(vault, slug, appended), { vault });
  return appended.length;
}

/** The entries of `entries` whose `(revision, field, after)` is not in `existing`, once each. */
function newEntries(
  existing: ReadonlyArray<EditHistoryEntry>,
  entries: ReadonlyArray<EditHistoryEntry>,
): EditHistoryEntry[] {
  const seen = new Set(existing.map(dedupKey));
  const out: EditHistoryEntry[] = [];
  for (const e of entries) {
    const key = dedupKey(e);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

/**
 * The store rows of `appended`. A private preference's history rows stay
 * out of the shared store partition, as do rows about a preference whose
 * page cannot be judged and rows whose values name a private or
 * unjudgeable page.
 */
function historyRows(
  vault: string | null,
  slug: string,
  appended: ReadonlyArray<EditHistoryEntry>,
): DualWriteRecord[] {
  // One verdict for the whole append (one operation, one partition): a
  // sibling row of a private edit would otherwise reveal it in shared.
  const partition =
    rowNamesPrivatePage(vault, `pref-${slug}`) ||
    appended.some((entry) => rowNamesPrivatePage(vault, entry))
      ? "private"
      : "shared";
  return appended.map((entry) =>
    ledgerRowRecord(DUAL_WRITE_LEDGERS.editHistory, { slug, entry }, partition),
  );
}

/**
 * Render a deterministic, human-readable timeline. Entries are sorted
 * by revision then field; values are quoted so empty/whitespace edits
 * stay visible.
 */
export function renderEditHistory(entries: ReadonlyArray<EditHistoryEntry>): string {
  if (entries.length === 0) return "(no recorded edits)";
  const sorted = entries
    .slice()
    .toSorted((a, b) => a.revision - b.revision || a.field.localeCompare(b.field));
  const lines = sorted.map((e) => {
    const before = e.before === null ? "(absent)" : `"${e.before}"`;
    const after = e.after === null ? "(removed)" : `"${e.after}"`;
    return `rev ${e.revision} (${e.ts}, ${e.agent}): ${e.field}: ${before} -> ${after}`;
  });
  return lines.join("\n");
}
