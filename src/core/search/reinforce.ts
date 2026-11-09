/**
 * Self-tuning reinforce ledger (Search & Recall Quality Suite).
 *
 * Reinforcement is an EXPLICIT signal: a caller (operator or downstream
 * agent) naming a memory that proved useful. It is never inferred from a
 * memory merely being surfaced - surfaced-only frequency carries no
 * positive signal, by design, so popularity can never snowball.
 *
 * Each reinforce event is one small JSON file under
 * `Brain/search/reinforce/` - the same conflict-free one-file-per-signal
 * pattern `Brain/inbox/` and the feedback ledger use, so multi-device
 * vaults never produce sync conflicts on a shared append-only file. The
 * per-path strength is a PURE FOLD over the event set (count of distinct
 * events naming the path, normalized and bounded), so it is replayable
 * and resettable: deleting the derived view loses nothing.
 *
 * The boost is bounded ({@link REINFORCE_BOOST_CAP}) and applied before
 * the top_k cut, so a reinforced memory is lifted into the window without
 * ever floating an irrelevant chunk.
 *
 * A store-only machine (design D14 item 1) appends each event as a
 * `search-reinforce` ledger row instead of a file; the store is
 * append-only, so a reset there is a row too, and the fold counts only
 * the events after the newest reset.
 */

import { legacyVaultOf } from "../brain/no-vault.ts";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { canonicalJson } from "../integrity/digest.ts";
import { ledgerRowRecord } from "../store/dual-write-records.ts";
import { readLedgerRows } from "../store/read/ledger-rows.ts";
import { rowNamesPrivatePage } from "../store/reference-privacy.ts";
import { isStoreOnly } from "../store/store-only.ts";
import { storeWrite } from "../store/store-write.ts";
import { dedupeIdentical, fnv1aHex } from "./feedback.ts";
import type { BrainSearchResult } from "./types.ts";

/** Maximum additive boost a fully-reinforced path receives. */
export const REINFORCE_BOOST_CAP = 0.05;
/** Event count at which a path reaches full reinforcement strength. */
export const REINFORCE_SATURATION = 5;

export interface ReinforceEvent {
  /** Unix-ms timestamp the reinforcement was recorded. */
  readonly ts: number;
  /** Vault-relative paths reinforced in this event. */
  readonly paths: ReadonlyArray<string>;
}

export interface RecordReinforceOptions {
  /** Injected clock for deterministic tests. Defaults to Date.now(). */
  readonly nowMs?: number;
}

export function reinforceDir(vault: string | null): string {
  return join(legacyVaultOf(vault, "reinforceDir"), "Brain", "search", "reinforce");
}

/**
 * Record one reinforce event as its own file. The filename derives from
 * the timestamp plus a content hash, so recording the identical event
 * (same timestamp and paths) twice is idempotent. Empty path lists are a
 * no-op.
 */
export function recordReinforce(
  vault: string | null,
  paths: ReadonlyArray<string>,
  opts: RecordReinforceOptions = {},
): string | null {
  const cleaned = [...new Set(paths.filter((p) => p.length > 0))].toSorted();
  if (cleaned.length === 0) return null;
  const event: ReinforceEvent = Object.freeze({ ts: opts.nowMs ?? Date.now(), paths: cleaned });
  // One `search-reinforce` ledger row on a store-only machine (design D14
  // item 1); an unswitched machine keeps its event file, with no dual write
  // (format version 1 has none for this ledger; the migration imports the
  // files).
  if (isStoreOnly({ vault })) {
    return storeWrite(() => reinforceRowRecord(vault, event), { vault })[0]?.path ?? "";
  }
  const dir = reinforceDir(vault);
  mkdirSync(dir, { recursive: true });
  const body = JSON.stringify(event, null, 2) + "\n";
  const file = join(dir, `${event.ts}-${fnv1aHex(body)}.json`);
  writeFileSync(file, body);
  return file;
}

/** The store ledger of reinforce events (FORMAT.md, the migration's ledgers). */
export const SEARCH_REINFORCE_LEDGER = "search-reinforce";

/**
 * A store row that resets the ledger: the store is append-only, so a
 * reset on a store-only machine is a row, and every event before the
 * newest reset row (in fold order) no longer counts.
 */
interface ReinforceResetRow {
  readonly ts: number;
  readonly reset: true;
}

function isResetRow(row: unknown): row is ReinforceResetRow {
  return (
    row !== null &&
    typeof row === "object" &&
    (row as { reset?: unknown }).reset === true &&
    typeof (row as { ts?: unknown }).ts === "number"
  );
}

/**
 * The store row of one event: `private` when a reinforced path names a
 * private page or one that cannot be judged, else `private` when this
 * machine holds it (what proved useful says what the user worked on).
 */
function reinforceRowRecord(vault: string | null, row: ReinforceEvent | ReinforceResetRow) {
  return ledgerRowRecord(
    SEARCH_REINFORCE_LEDGER,
    row,
    rowNamesPrivatePage(vault, row) ? "private" : "private-when-held",
  );
}

function isReinforceEvent(parsed: unknown): parsed is ReinforceEvent {
  if (parsed === null || typeof parsed !== "object") return false;
  const e = parsed as Partial<ReinforceEvent>;
  return (
    typeof e.ts === "number" &&
    Array.isArray(e.paths) &&
    e.paths.every((p) => typeof p === "string")
  );
}

/** The store rows after the newest reset row, in fold order. */
function storeRowsSinceReset(vault: string | null): unknown[] {
  const rows = readLedgerRows<unknown>(SEARCH_REINFORCE_LEDGER, () => [], { vault });
  const lastReset = rows.findLastIndex(isResetRow);
  return rows.slice(lastReset + 1);
}

/** Load all reinforce events, sorted by timestamp (stable). */
export function loadReinforceEvents(vault: string | null): ReinforceEvent[] {
  // A store-only machine reads the `search-reinforce` rows after the
  // newest reset; an identical row is counted once, as the event's file
  // name made it one file.
  if (isStoreOnly({ vault })) {
    return dedupeIdentical(storeRowsSinceReset(vault).filter(isReinforceEvent)).toSorted(
      (a, b) => a.ts - b.ts,
    );
  }
  let files: string[];
  try {
    files = readdirSync(reinforceDir(vault)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: ReinforceEvent[] = [];
  for (const f of files.toSorted()) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(reinforceDir(vault), f), "utf8"));
      if (isReinforceEvent(parsed)) out.push(parsed);
    } catch {
      // One malformed file never breaks the fold.
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

/**
 * Pure fold: per-path strength in [0, 1], the count of distinct events
 * naming the path normalized by {@link REINFORCE_SATURATION} and capped
 * at 1. Order-insensitive by construction.
 */
export function loadReinforceStrengths(vault: string | null): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of loadReinforceEvents(vault)) {
    for (const path of new Set(event.paths)) {
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }
  }
  const strengths = new Map<string, number>();
  for (const [path, count] of counts) {
    strengths.set(path, Math.min(1, count / REINFORCE_SATURATION));
  }
  return strengths;
}

/** Delete the reinforce ledger. The fold replays as empty afterwards. */
export function resetReinforce(vault: string | null, opts: RecordReinforceOptions = {}): void {
  // The store is append-only: a store-only machine records the reset as a
  // row (design D14 item 1) and removes nothing.
  if (isStoreOnly({ vault })) {
    // The reset names no page and carries no user text: it goes to
    // `shared`, so every device, one without the private partition
    // included, applies the same cutoff to the events before it.
    const reset: ReinforceResetRow = { ts: opts.nowMs ?? Date.now(), reset: true };
    storeWrite(() => ledgerRowRecord(SEARCH_REINFORCE_LEDGER, reset, "shared"), { vault });
    return;
  }
  rmSync(reinforceDir(vault), { recursive: true, force: true });
}

/**
 * Stable fingerprint of the ledger state for the query-cache key: "off"
 * when no ledger exists, else a hash of the sorted event filenames (the
 * filenames already encode ts + content hash, so they change iff the
 * ledger does).
 */
export function reinforceFingerprint(vault: string | null): string {
  if (isStoreOnly({ vault })) {
    const rows = storeRowsSinceReset(vault).filter(isReinforceEvent);
    return rows.length === 0 ? "off" : fnv1aHex(rows.map((row) => canonicalJson(row)).join("|"));
  }
  const dir = reinforceDir(vault);
  if (!existsSync(dir)) return "off";
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .toSorted();
    if (files.length === 0) return "off";
    return fnv1aHex(files.join("|"));
  } catch {
    return "off";
  }
}

function fmt(x: number): string {
  return x.toFixed(3);
}

/**
 * Apply the bounded reinforcement boost to a ranked pool and re-sort.
 * A result whose path carries ledger strength gets `CAP * strength` added
 * to its score (clamped to 1) and a `reinforce:` reason; everything else
 * is untouched. Pure: returns a new array, never mutates the input. The
 * tie-break matches the ranker family (score desc, keywordScore desc,
 * chunkId asc) so the ordering stays deterministic.
 */
export function applyReinforceBoost(
  results: ReadonlyArray<BrainSearchResult>,
  strengthByPath: ReadonlyMap<string, number>,
): BrainSearchResult[] {
  if (strengthByPath.size === 0) return results.slice();
  const boosted = results.map((r) => {
    const strength = strengthByPath.get(r.path);
    if (strength === undefined || strength <= 0) return r;
    const boost = REINFORCE_BOOST_CAP * Math.min(1, strength);
    return Object.freeze({
      ...r,
      score: Math.min(1, r.score + boost),
      reasons: Object.freeze([...r.reasons, `reinforce: +${fmt(boost)}`]),
    });
  });
  return boosted.toSorted((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.keywordScore !== a.keywordScore) return b.keywordScore - a.keywordScore;
    return a.chunkId - b.chunkId;
  });
}
