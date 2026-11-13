/**
 * Legacy exporters for the rollback (task 2.6, design D11 "Rollback"):
 * each writes one store record kind back into the legacy layout, so a
 * machine rolled back to the old release finds what was written while it
 * used the store.
 *
 *  - `signal` / `signal-state`: the signal page, rewritten from the signal
 *    fold (frontmatter with every field change applied) in the folder its
 *    lifecycle state puts it in (`inbox/processed/` when consumed, and so
 *    on), and removed from every other signal folder.
 *  - `log-event`: one JSONL row in this device's legacy day shard, chained
 *    to the shard's last row as the legacy appender chains
 *    (`logChainHash`). A row a killed run appended but did not journal is
 *    recognised as the shard's last row and not appended again.
 *  - `preference-set` / `preference-remove` / `preference-evidence`: the
 *    preference page, rewritten from the fold of every record of that
 *    preference (counters included), its body kept.
 *  - `pinned-set` / `pinned-clear`: `Brain/pinned.md` from the pinned fold.
 *  - `lane-entry` / `lane-entry-remove`: the entry's page (or JSON file) at
 *    the path it was imported from, else `Brain/<lane>/<entry>.md`.
 *
 * Every other kind has no legacy form and is only counted. Exporters
 * write the legacy tree directly: this module is a legacy exporter.
 *
 * The records come from every device of every held partition, and a synced
 * peer can write any body (FORMAT.md, Trust). So every path a record
 * names goes through `containedRecordPath` under `Brain/` (or `Brain/log/`)
 * before anything is written or removed, a log timestamp must be a date
 * and a preference id a slug. A record that fails is refused: it is
 * reported with the reason, nothing is written for it, and the export goes
 * on with the others.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { canonicalJson } from "../integrity/digest.ts";
import { containedRecordPath } from "../record-path.ts";

import { LOG_CHAIN_FIELDS, logChainHash } from "../brain/log.ts";
import {
  BRAIN_ARCHIVED_SIGNALS_REL,
  BRAIN_INBOX_REL,
  BRAIN_LOG_REL,
  BRAIN_PENDING_REL,
  BRAIN_PINNED_FILE,
  BRAIN_PROCESSED_REL,
  BRAIN_RETIRED_REL,
  BRAIN_ROOT_REL,
} from "../brain/path-constants.ts";
import { preferencePath, retiredPath, validateSlug } from "../brain/paths.ts";
import { preferencePageBody } from "../brain/preference.ts";
import { PREFERENCE_TEXT_FIELD } from "../brain/preference-store.ts";
import { brainRelOfEntry } from "../store/lane-paths.ts";
import { rawParsesBack, renderLaneText } from "../store/lane-raw.ts";
import { signalPagePath } from "../store/read/signals.ts";
import {
  LANE_ENTRY_KIND,
  LANE_ENTRY_REMOVE_KIND,
  LANE_NAME_RE,
  foldLaneEntries,
  isLaneEntryId,
  laneEntryKey,
  type LaneFold,
} from "../store/lane-records.ts";
import {
  LOG_EVENT_KIND,
  PINNED_CLEAR_KIND,
  PINNED_SET_KIND,
  PREFERENCE_EVIDENCE_KIND,
  PREFERENCE_REMOVE_KIND,
  PREFERENCE_SET_KIND,
  SIGNAL_KIND,
  VAULT_ID_FIELD,
} from "../store/constants.ts";
import type { StoreRecord } from "../store/envelope.ts";
import { foldPinned } from "../store/fold-pinned.ts";
import {
  foldSignals,
  SIGNAL_REMOVED_KIND,
  SIGNAL_STATE_KIND,
  type SignalsFold,
} from "../store/fold-signals.ts";
import { foldPreferences } from "../store/fold-preferences.ts";
import type { FrontmatterMap } from "../types.ts";
import { formatFrontmatter, parseFrontmatterWithNotices } from "../vault.ts";
import { migratedMark } from "./migration-records.ts";

/** Kinds an exporter writes back. */
export const EXPORTED_KINDS: ReadonlySet<string> = new Set([
  SIGNAL_KIND,
  SIGNAL_STATE_KIND,
  SIGNAL_REMOVED_KIND,
  LOG_EVENT_KIND,
  PREFERENCE_SET_KIND,
  PREFERENCE_REMOVE_KIND,
  PREFERENCE_EVIDENCE_KIND,
  PINNED_SET_KIND,
  PINNED_CLEAR_KIND,
  LANE_ENTRY_KIND,
  LANE_ENTRY_REMOVE_KIND,
]);

const PREFERENCE_KINDS = new Set([
  PREFERENCE_SET_KIND,
  PREFERENCE_REMOVE_KIND,
  PREFERENCE_EVIDENCE_KIND,
]);
const PINNED_KINDS = new Set([PINNED_SET_KIND, PINNED_CLEAR_KIND]);
const LANE_KINDS = new Set([LANE_ENTRY_KIND, LANE_ENTRY_REMOVE_KIND]);

/** A record the exporters would not write back, and why. */
export interface RefusedRecord {
  readonly id: string;
  readonly kind: string;
  readonly reason: string;
}

const BRAIN_PREFIX = `${BRAIN_ROOT_REL}/`;

/**
 * The absolute path of the vault-relative `rel` (`Brain/...`), or null when
 * it is no record path or does not stay inside `<vault>/Brain/`.
 */
function brainPath(vault: string, rel: unknown): string | null {
  if (typeof rel !== "string" || !rel.startsWith(BRAIN_PREFIX)) return null;
  return containedRecordPath(join(vault, BRAIN_ROOT_REL), rel.slice(BRAIN_PREFIX.length));
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** A legacy day-shard date: the `YYYY-MM-DD` a log timestamp starts with. */
const LOG_DAY_RE = /^\d{4}-\d{2}-\d{2}(?:$|T)/;

function asFrontmatter(value: unknown): FrontmatterMap {
  return (value !== null && typeof value === "object" ? value : {}) as FrontmatterMap;
}

/**
 * Remove the page of a forgotten signal from the restored tree, wherever
 * its state moved it. A path that leaves `Brain/` removes nothing.
 */
function forgetSignalPage(vault: string, record: StoreRecord): void {
  const rel = record.body["path"];
  const page = brainPath(vault, rel);
  if (page === null) return;
  const name = (rel as string).split("/").at(-1)!;
  const id = signalIdOf(record);
  for (const dir of SIGNAL_PAGE_DIRS) {
    const moved = brainPath(vault, `${dir}/${name}`);
    if (moved !== null && moved !== page) removeSignalPageOf(moved, id);
  }
  rmSync(page, { force: true });
}

/**
 * Remove the page at `path` when it is the page of signal `id`: another
 * signal's page may share the file name in another lifecycle folder, and
 * is never removed for this one. A page that cannot be read stays.
 */
function removeSignalPageOf(path: string, id: unknown): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  if (parseFrontmatterWithNotices(text)[0]["id"] === id) rmSync(path, { force: true });
}

/** Every folder a signal page can sit in, by its lifecycle. */
const SIGNAL_PAGE_DIRS = [
  BRAIN_INBOX_REL,
  BRAIN_PROCESSED_REL,
  BRAIN_ARCHIVED_SIGNALS_REL,
  BRAIN_RETIRED_REL,
  BRAIN_PENDING_REL,
];

const SIGNAL_FAMILY: ReadonlySet<string> = new Set([
  SIGNAL_KIND,
  SIGNAL_STATE_KIND,
  SIGNAL_REMOVED_KIND,
]);

/** The signal id a signal-family record belongs to. */
function signalIdOf(record: StoreRecord): unknown {
  return record.kind === SIGNAL_KIND ? record.body["id"] : record.body["signal"];
}

/** Where one signal's page is written back, or the reason it is not. */
type SignalTarget = { readonly path: string; readonly name: string } | { readonly reason: string };

/**
 * The page of a folded signal: its capture path until a lifecycle move,
 * then the move's folder under the same file name; null for a signal the
 * fold does not hold (forgotten, or a move whose capture never arrived).
 */
function signalTarget(vault: string, fold: SignalsFold, id: unknown): SignalTarget | null {
  const entry = typeof id === "string" ? fold.signals.get(id) : undefined;
  if (entry === undefined) return null;
  const rel = entry.signal.body["path"];
  if (typeof rel !== "string" || rel === "") return null;
  if (brainPath(vault, rel) === null) return { reason: "signal path leaves the brain tree" };
  const name = rel.split("/").at(-1)!;
  // The read facade's rule, so a rolled-back page sits where a store
  // reader said it was.
  const path = brainPath(
    vault,
    entry.stateRecord === null ? rel : signalPagePath(rel, entry.state),
  );
  return path === null ? { reason: "signal path leaves the brain tree" } : { path, name };
}

/** Write each signal page back from the fold, out of every other signal folder. */
function exportSignals(
  vault: string,
  fold: SignalsFold,
  targets: ReadonlyMap<string, { readonly path: string; readonly name: string }>,
): void {
  for (const [id, target] of targets) {
    const entry = fold.signals.get(id)!;
    const raw =
      typeof entry.signal.body["raw"] === "string" ? (entry.signal.body["raw"] as string) : "";
    for (const dir of SIGNAL_PAGE_DIRS) {
      const other = brainPath(vault, `${dir}/${target.name}`);
      if (other !== null && other !== target.path) removeSignalPageOf(other, id);
    }
    const capture = brainPath(vault, entry.signal.body["path"]);
    if (capture !== null && capture !== target.path) rmSync(capture, { force: true });
    write(target.path, formatFrontmatter(asFrontmatter(entry.frontmatter), raw));
  }
}

/** The last chained row of a JSONL shard, as the export last left it. */
interface ShardTail {
  readonly h: string | null;
  readonly row: Readonly<Record<string, unknown>> | null;
}

/** The last chained row of the shard at `path`, read once per export run. */
function shardTail(tails: Map<string, ShardTail>, path: string): ShardTail {
  const known = tails.get(path);
  if (known !== undefined) return known;
  let tail: ShardTail = { h: null, row: null };
  if (existsSync(path)) {
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "");
    for (const line of lines.toReversed()) {
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        const h = row[LOG_CHAIN_FIELDS.h];
        if (typeof h === "string") {
          tail = { h, row };
          break;
        }
      } catch {
        // a torn row: keep looking back
      }
    }
  }
  tails.set(path, tail);
  return tail;
}

/** Whether `row` is the log row `ts`/`kind`/`payload` would be. */
function sameLogRow(
  row: Readonly<Record<string, unknown>> | null,
  ts: string,
  kind: string,
  payload: unknown,
): boolean {
  return (
    row !== null &&
    row["ts"] === ts &&
    row["kind"] === kind &&
    canonicalJson(row["payload"]) === canonicalJson(payload)
  );
}

/**
 * One log row, appended to THIS device's day shard whoever wrote the
 * record: a device writes only its own legacy shards, so a rollback never
 * appends to a shard another machine still writes. The reason when the
 * timestamp is no date (it names the shard file).
 *
 * `started`: an earlier run began this record and was killed before it
 * journaled it, with the shard's tail hash it saw then. The export is
 * sequential, so its row, if appended, is the last row of its shard and
 * chains onto that tail; then nothing is appended again. An equal row
 * that chains onto anything else is an earlier record's, and the row is
 * appended. A start journaled without its tail (an older journal) falls
 * back to comparing the row's content.
 */
function exportLogEvent(
  vault: string,
  record: StoreRecord,
  device: string,
  tails: Map<string, ShardTail>,
  started: StartMark | undefined,
  onStart: (tail: string | null) => void,
): string | null {
  const ts = record.body["timestamp"];
  const kind = record.body["event_type"];
  if (typeof ts !== "string" || typeof kind !== "string") return null;
  if (!LOG_DAY_RE.test(ts)) return "log timestamp is no date";
  const inner = { ...((record.body["body"] ?? {}) as Record<string, unknown>) };
  for (const field of Object.values(LOG_CHAIN_FIELDS)) delete inner[field];
  delete inner[VAULT_ID_FIELD];
  const payload = inner as Record<string, string | ReadonlyArray<string>>;
  const day = ts.slice(0, 10);
  const path = brainPath(vault, `${BRAIN_LOG_REL}/${day}.${device}.jsonl`);
  if (path === null) return "log shard path leaves the brain tree";
  const tail = shardTail(tails, path);
  if (started !== undefined && sameLogRow(tail.row, ts, kind, payload)) {
    const chainsOnStart =
      started.tail === undefined || tail.row?.[LOG_CHAIN_FIELDS.prev] === started.tail;
    if (chainsOnStart) return null;
  }
  onStart(tail.h);
  const prev = tail.h;
  const h = logChainHash(prev, ts, kind, payload);
  const row = { ts, kind, payload, [LOG_CHAIN_FIELDS.prev]: prev, [LOG_CHAIN_FIELDS.h]: h };
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(row)}\n`);
  tails.set(path, { h, row });
  return null;
}

/**
 * The page body a preference is written back with: its prose when the fold
 * holds one, else the body of the page on disk, else the body its fields
 * render.
 */
function preferenceBody(
  frontmatter: FrontmatterMap,
  text: unknown,
  isRetired: boolean,
  keepBody: string | undefined,
): string {
  if (typeof text === "string") return preferencePageBody(frontmatter, text, isRetired);
  if (keepBody !== undefined) return parseFrontmatterWithNotices(keepBody)[1];
  return preferencePageBody(frontmatter, null, isRetired);
}

/** Rewrite every preference `ids` names from the fold of `all`. */
function exportPreferences(
  vault: string,
  ids: ReadonlySet<string>,
  all: ReadonlyArray<StoreRecord>,
): void {
  const fold = foldPreferences(all);
  for (const id of ids) {
    const state = fold.preferences.get(id);
    if (state === undefined) continue;
    const slug = id.replace(/^pref-/, "");
    const active = preferencePath(vault, slug);
    const retired = retiredPath(vault, slug);
    if (!state.exists) {
      for (const path of [active, retired]) rmSync(path, { force: true });
      continue;
    }
    const isRetired = state.fields["status"] === "retired";
    const target = isRetired ? retired : active;
    const other = isRetired ? active : retired;
    // The prose is the page body, never a frontmatter key (FORMAT.md,
    // Preferences); with none, the body of the page on disk is kept, or
    // the body the fields render when there is no page.
    const { [PREFERENCE_TEXT_FIELD]: text, ...fields } = state.fields;
    const frontmatter = { ...fields, ...state.counters } as FrontmatterMap;
    const keepBody = [target, other].find((p) => existsSync(p));
    const body = preferenceBody(frontmatter, text, isRetired, keepBody);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, formatFrontmatter(frontmatter, body));
    if (existsSync(other)) rmSync(other, { force: true });
  }
}

/** `Brain/pinned.md` from the pinned fold of the most private partition replayed. */
function exportPinned(vault: string, records: ReadonlyArray<StoreRecord>): void {
  const fold = foldPinned(records);
  write(
    join(vault, BRAIN_ROOT_REL, BRAIN_PINNED_FILE),
    fold.content === null ? "" : `${fold.content}\n`,
  );
}

/**
 * Where a lane entry is written back: the path it was imported from, else
 * its own page; null when that path leaves `Brain/`.
 */
function laneEntryPath(vault: string, key: string, fold: LaneFold): string | null {
  const state = fold.entries.get(key);
  const imported = state?.history.map((h) => migratedMark(h.record)).find((m) => m !== null);
  const [lane, ...rest] = key.split("/");
  return brainPath(
    vault,
    imported?.key ?? `${BRAIN_PREFIX}${brainRelOfEntry(lane!, rest.join("/"))}`,
  );
}

/** A lane entry's file text: its `raw` when it parses back, else by its extension. */
function laneEntryText(
  path: string,
  value: {
    readonly fields: Readonly<Record<string, unknown>>;
    readonly text: string;
    readonly raw?: string;
  },
): string {
  if (value.raw !== undefined && rawParsesBack(path, value.raw, value.fields, value.text)) {
    return value.raw;
  }
  if (path.endsWith(".md")) return formatFrontmatter(asFrontmatter(value.fields), value.text);
  return renderLaneText(path, value.fields, value.text);
}

/** Every touched lane entry, written back from the lane fold at its path. */
function exportLaneEntries(targets: ReadonlyMap<string, string>, fold: LaneFold): void {
  for (const [key, path] of targets) {
    const state = fold.entries.get(key);
    if (state === undefined) continue;
    if (state.removed || state.value === null) {
      rmSync(path, { force: true });
      continue;
    }
    write(path, laneEntryText(path, state.value));
  }
}

export interface ExportPlan {
  /** Records to write back, in fold order. */
  readonly records: ReadonlyArray<StoreRecord>;
  /** Every record this machine holds, for the folds. */
  readonly all: ReadonlyArray<StoreRecord>;
}

/**
 * What a run journaled when it began a record: the tail hash of the shard
 * it was about to append to (null for an empty shard), or undefined when
 * an older journal line did not carry it.
 */
export interface StartMark {
  readonly tail?: string | null;
}

/** The resume journal of an export run. */
export interface ExportJournal {
  /** Records an earlier run wrote back (a resumed rollback). */
  readonly done: ReadonlySet<string>;
  /** Records an earlier run began and did not record as written, with what it saw. */
  readonly started: ReadonlyMap<string, StartMark>;
  /** Called before a record is written, with its shard's tail hash (null: an empty shard). */
  readonly onStart: (record: StoreRecord, tail: string | null) => void;
  /** Called after a record is written. */
  readonly onRecord: (record: StoreRecord) => void;
}

/**
 * Write `plan.records` back into the legacy layout, in fold order, calling
 * `journal.onStart` before and `journal.onRecord` after each one. A record
 * in `journal.done` (a resumed run) is not written again. Fold-based kinds
 * (signals, preferences, pinned context, lane entries) are rewritten once
 * per entity from the fold of every record, after the per-record kinds, so
 * a resumed run writes them whole. Returns the records refused (see the
 * module header), in fold order; a refused record is never passed to
 * `onRecord`.
 */
export function exportRecords(
  vault: string,
  device: string,
  plan: ExportPlan,
  journal: ExportJournal,
): RefusedRecord[] {
  const { done } = journal;
  const refused: RefusedRecord[] = [];
  const refuse = (record: StoreRecord, reason: string): void => {
    refused.push({ id: record.id, kind: record.kind, reason });
  };
  const prefs = new Set<string>();
  const pinned: StoreRecord[] = [];
  // A forgotten signal (`signal-removed`) is not written back, and its page
  // the restored tree may still hold is removed: the rollback must not
  // bring back what a user asked to forget.
  const signals = foldSignals(plan.all.filter((r) => SIGNAL_FAMILY.has(r.kind)));
  for (const record of plan.all) {
    if (record.kind === SIGNAL_KIND && signals.voided.has(record.id)) {
      forgetSignalPage(vault, record);
    }
  }
  const signalTargets = new Map<string, { readonly path: string; readonly name: string }>();
  const lanes = foldLaneEntries(plan.all);
  const laneTargets = new Map<string, string>();
  const tails = new Map<string, ShardTail>();
  for (const record of plan.records) {
    let reason: string | null = null;
    if (SIGNAL_FAMILY.has(record.kind) && record.kind !== SIGNAL_REMOVED_KIND) {
      const id = signalIdOf(record);
      const target = signalTarget(vault, signals, id);
      if (target !== null && "reason" in target) reason = target.reason;
      else if (target !== null) signalTargets.set(id as string, target);
    } else if (PREFERENCE_KINDS.has(record.kind)) {
      const id = String(record.body["preference"]);
      if (isPreferenceSlug(id)) prefs.add(id);
      else reason = "preference id is no slug";
    } else if (PINNED_KINDS.has(record.kind)) pinned.push(record);
    else if (LANE_KINDS.has(record.kind)) {
      const { lane, entry } = record.body;
      const key =
        typeof lane === "string" && LANE_NAME_RE.test(lane) && isLaneEntryId(entry)
          ? laneEntryKey(lane, entry)
          : null;
      const path = key === null ? null : laneEntryPath(vault, key, lanes);
      if (path === null) reason = "lane entry path leaves the brain tree";
      else laneTargets.set(key!, path);
    }
    if (reason === null && !done.has(record.id) && record.kind === LOG_EVENT_KIND) {
      reason = exportLogEvent(
        vault,
        record,
        device,
        tails,
        journal.started.get(record.id),
        (tail) => journal.onStart(record, tail),
      );
    }
    if (reason !== null) refuse(record, reason);
    else if (!done.has(record.id)) journal.onRecord(record);
  }
  if (signalTargets.size > 0) exportSignals(vault, signals, signalTargets);
  if (prefs.size > 0) exportPreferences(vault, prefs, plan.all);
  if (pinned.length > 0) {
    exportPinned(
      vault,
      plan.all.filter((r) => PINNED_KINDS.has(r.kind)),
    );
  }
  if (laneTargets.size > 0) exportLaneEntries(laneTargets, lanes);
  return refused;
}

/** Whether a preference id names a page: `pref-<slug>` with a valid slug. */
function isPreferenceSlug(id: string): boolean {
  try {
    validateSlug(id.replace(/^pref-/, ""));
    return true;
  } catch {
    return false;
  }
}
