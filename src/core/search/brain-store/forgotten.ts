/**
 * The brain store records the search index must not hold: every record an
 * entity reader leaves out of what it shows (design D5, FORMAT.md
 * "Removal"), and every record of a signal still waiting for write
 * approval. The ingest (`catch-up.ts`) and the query
 * (`entity-filter.ts`) both ask {@link forgottenRecordIds}, so they agree.
 *
 * A record counts as forgotten in two ways, and the index agrees with the
 * readers on both:
 *
 *  - A tombstone voided it (`signal-removed`, `preference-remove`,
 *    `lane-entry-remove`): {@link voidedRecordIds}.
 *  - Its entity carries the lifecycle mark `_status: tombstoned` (or the
 *    normalised `status: tombstoned`) in its current frontmatter or fields:
 *    a signal whose captured frontmatter, with every field change applied,
 *    is tombstoned (a signal the legacy `o2b brain lifecycle tombstone`
 *    marked before the migration carries the mark in its capture), a
 *    preference whose winning fields are tombstoned, a lane entry whose
 *    current fields are. Recall, the briefs, the active preferences and
 *    the dream pass leave such an entity out (`isTombstoned`), so every
 *    record of its history leaves the index.
 *
 * A staged signal (captured while write approval is on, state `staged`)
 * is kept out too, as the legacy index kept `Brain/pending/` out
 * (`admitToIndex`): no operator has admitted it yet. Once approved it is
 * an inbox signal and becomes searchable.
 *
 * A signal moved to another lifecycle state (consumed, archived, retired,
 * rejected) is not forgotten: its page stayed searchable in the legacy
 * tree, and its records stay searchable in the store.
 *
 * The NAME of a forgotten record leaves search too
 * ({@link forgottenEntityNames}, {@link namesForgottenEntity}): the
 * operational log's events are store records of their own (a signal's
 * `feedback` event, its `tombstone` event, a preference's `promote`),
 * and their bodies name the entity by id, so a search for the id or the
 * topic would otherwise still find what the user asked to forget. The
 * legacy index never held the log (its day shards are JSONL, which the
 * walk does not read), so leaving those events out of the answers keeps
 * the two layouts alike. The log itself keeps every event: it is the
 * append-only, hash-chained audit trail of what happened, and
 * `o2b brain log` still lists them. Only the search answers leave them
 * out, at query time (`entity-filter.ts`), so an event comes back the
 * moment its entity does (a tombstone undone, a staged signal approved).
 * Names are taken from the forgetting that is the user's decision: a
 * signal forgotten (`signal-removed`), tombstoned or staged, a
 * preference or lane entry tombstoned. A removal that is bookkeeping (a
 * moved lane entry's old place, a merged preference) hides no name.
 */

import { isTombstoned, normalizeChainLink } from "../../brain/lifecycle/tombstone-read.ts";
import {
  PREFERENCE_EVIDENCE_KIND,
  PREFERENCE_REMOVE_KIND,
  PREFERENCE_SET_KIND,
  SIGNAL_KIND,
} from "../../store/constants.ts";
import type { StoreRecord } from "../../store/envelope.ts";
import { foldPreferences } from "../../store/fold-preferences.ts";
import { foldSignals, SIGNAL_REMOVED_KIND, SIGNAL_STATE_KIND } from "../../store/fold-signals.ts";
import {
  foldLaneEntries,
  LANE_ENTRY_KIND,
  LANE_ENTRY_REMOVE_KIND,
} from "../../store/lane-records.ts";
import { brainRelOfEntry } from "../../store/lane-paths.ts";
import { BRAIN_ROOT_REL } from "../../brain/path-constants.ts";
import { isVoidingFoldInput, voidedRecordIds } from "../../store/removal-backlog.ts";

export { isVoidingFoldInput as isForgettingFoldInput };

const FOLD_KINDS: ReadonlySet<string> = new Set([
  SIGNAL_KIND,
  SIGNAL_STATE_KIND,
  SIGNAL_REMOVED_KIND,
  LANE_ENTRY_KIND,
  LANE_ENTRY_REMOVE_KIND,
  PREFERENCE_SET_KIND,
  PREFERENCE_REMOVE_KIND,
  PREFERENCE_EVIDENCE_KIND,
]);

/** Whether records of `kind` are read by the forgetting folds (`isVoidingFoldInput` by kind). */
export function isForgettingFoldKind(kind: string): boolean {
  return FOLD_KINDS.has(kind);
}

const SIGNAL_KINDS: ReadonlySet<string> = new Set([
  SIGNAL_KIND,
  SIGNAL_STATE_KIND,
  SIGNAL_REMOVED_KIND,
]);
const LANE_KINDS: ReadonlySet<string> = new Set([LANE_ENTRY_KIND, LANE_ENTRY_REMOVE_KIND]);

/** The on-disk frontmatter key of the lifecycle status (`tombstone-read.ts`). */
const LIFECYCLE_STATUS_KEY = "_status";

/** The normalised key a preference's fields carry it under. */
const NORMALISED_STATUS_KEY = "status";

/** The lifecycle status that forgets an entity. */
const TOMBSTONED = "tombstoned";

/** The `signal-state` moves that put a signal into, or take it out of, write approval. */
const APPROVAL_STATES: ReadonlySet<unknown> = new Set(["staged", "approved", "rejected"]);

/** The two body fields an entity's frontmatter travels in: a capture's and a change's. */
const FRONTMATTER_FIELDS = ["frontmatter", "fields"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether `record` sets or clears a lifecycle status of its entity: its
 * captured frontmatter or its changed fields name `_status` (any value,
 * a `null` clearing it included), or carry `status: tombstoned`. A pass
 * that reads one must fold the entity again, as a pass that reads a
 * tombstone does: it may forget the entity, or bring a forgotten one back.
 * A preference's ordinary `status` changes (confirmed, retired) are not
 * marks, or every preference write would fold the store again. A staged
 * capture and a move into or out of write approval are marks too.
 */
export function carriesLifecycleMark(record: StoreRecord): boolean {
  if (!isVoidingFoldInput(record)) return false;
  if (record.kind === SIGNAL_KIND && record.body["staged"] === true) return true;
  if (record.kind === SIGNAL_STATE_KIND && APPROVAL_STATES.has(record.body["state"])) return true;
  for (const field of FRONTMATTER_FIELDS) {
    const value = record.body[field];
    if (!isPlainObject(value)) continue;
    if (LIFECYCLE_STATUS_KEY in value || value[NORMALISED_STATUS_KEY] === TOMBSTONED) return true;
  }
  return false;
}

/**
 * How the log events name the records the index forgets: an event is
 * left out only when it references a forgotten record itself, never when
 * it merely shares a word with one.
 *
 *  - `ids`: signal and preference ids (`sig-...`, `pref-...`, `ret-...`).
 *    Such an id is the record's own name and nothing else's, so a word of
 *    the event that is the id, or a wikilink or path that ends in it,
 *    references the record.
 *  - `paths`: a forgotten lane entry's `Brain/`-relative page path without
 *    `.md` (`lists/groceries`). A lane entry's basename is a free file
 *    name (`groceries`), so it references the entry only as its path
 *    (`Brain/lists/groceries.md`, `[[lists/groceries]]`) or ...
 *  - `links`: ... as a wikilink to its basename (`[[groceries]]`), which is
 *    a link to that page. The bare word `groceries` references nothing.
 */
export interface ForgottenRefs {
  readonly ids: ReadonlySet<string>;
  readonly paths: ReadonlySet<string>;
  readonly links: ReadonlySet<string>;
}

/** What the index must not show of the store's fold records (see the module docblock). */
export interface Forgetting {
  /** Ids of the records the index must not hold. */
  readonly ids: ReadonlySet<string>;
  /** How the log events reference the forgotten records ({@link ForgottenRefs}). */
  readonly refs: ForgottenRefs;
}

/** The preference id prefix, and the page id a retired preference answers to. */
const PREFERENCE_PREFIX = "pref-";
const RETIRED_PREFIX = "ret-";

const BRAIN_PREFIX = `${BRAIN_ROOT_REL}/`;
const PAGE_EXT = ".md";

function addId(ids: Set<string>, raw: unknown): void {
  if (typeof raw !== "string" || raw.trim() === "") return;
  const name = normalizeChainLink(raw).normalize("NFC");
  if (name !== "") ids.add(name);
}

/** A path as a lane reference compares it: NFC, `/`, no `Brain/` root, no `.md`. */
function pathKey(raw: string): string {
  let value = raw.normalize("NFC").replaceAll("\\", "/").replace(/^\/+/, "");
  if (value.startsWith(BRAIN_PREFIX)) value = value.slice(BRAIN_PREFIX.length);
  if (value.toLowerCase().endsWith(PAGE_EXT)) value = value.slice(0, -PAGE_EXT.length);
  return value;
}

/**
 * The records among `records` the index must not hold, and how a log event
 * references the entities they belong to. Any order, duplicates allowed.
 */
export function forgetting(records: ReadonlyArray<StoreRecord>): Forgetting {
  const ids = new Set<string>(voidedRecordIds(records));
  const refIds = new Set<string>();
  const paths = new Set<string>();
  const links = new Set<string>();
  const signals = foldSignals(records.filter((r) => SIGNAL_KINDS.has(r.kind)));
  for (const entry of signals.signals.values()) {
    if (entry.state !== "staged" && !isTombstoned(entry.frontmatter)) continue;
    for (const r of entry.history) ids.add(r.id);
    addId(refIds, entry.id);
    // The signal's own page path, which a page moved by hand keeps even
    // when its name differs from the id.
    const path = entry.signal.body["path"];
    if (typeof path === "string" && path.trim() !== "") paths.add(pathKey(path));
  }
  // A forgotten signal no capture brought back.
  for (const id of signals.removed.keys()) if (!signals.signals.has(id)) addId(refIds, id);
  for (const state of foldPreferences(records).preferences.values()) {
    if (!state.exists || !isTombstoned(state.fields)) continue;
    for (const r of state.history) ids.add(r.id);
    addId(refIds, state.id);
    if (state.id.startsWith(PREFERENCE_PREFIX)) {
      addId(refIds, `${RETIRED_PREFIX}${state.id.slice(PREFERENCE_PREFIX.length)}`);
    }
  }
  const lanes = foldLaneEntries(records.filter((r) => LANE_KINDS.has(r.kind)));
  for (const state of lanes.entries.values()) {
    if (state.value === null || !isPlainObject(state.value.fields)) continue;
    if (!isTombstoned(state.value.fields)) continue;
    for (const h of state.history) ids.add(h.record.id);
    const rel = brainRelOfEntry(state.value.lane, state.value.entry);
    paths.add(pathKey(rel));
    const base = normalizeChainLink(rel).normalize("NFC");
    if (base !== "") links.add(base);
  }
  return { ids, refs: { ids: refIds, paths, links } };
}

/**
 * Ids of the records among `records` the index must not hold: the voided
 * ones, every record of an entity marked tombstoned and every record of a
 * staged signal (see the module docblock). Any order, duplicates allowed.
 */
export function forgottenRecordIds(records: ReadonlyArray<StoreRecord>): ReadonlySet<string> {
  return forgetting(records).ids;
}

/** A character that may sit right before a path in indexed text. */
const PATH_BEFORE_RE = /[\s"'([:=]/u;
/** A character that may sit right after a path (or its `.md`) in indexed text. */
const PATH_AFTER_RE = /[\s"')\],.;|#]/u;

/**
 * Whether `source` holds the lane path key `path` as a whole path: optionally
 * after the `Brain/` root, optionally followed by `.md`, with a separator
 * (or the text's edge) on both sides.
 */
function containsBounded(source: string, path: string): boolean {
  let from = 0;
  for (;;) {
    const at = source.indexOf(path, from);
    if (at < 0) return false;
    from = at + 1;
    let start = at;
    if (source.slice(Math.max(0, at - BRAIN_PREFIX.length), at) === BRAIN_PREFIX) {
      start = at - BRAIN_PREFIX.length;
    }
    let end = at + path.length;
    if (source.slice(end, end + PAGE_EXT.length).toLowerCase() === PAGE_EXT) end += PAGE_EXT.length;
    const before = start === 0 ? "" : source[start - 1]!;
    const after = end >= source.length ? "" : source[end]!;
    if (
      (before === "" || PATH_BEFORE_RE.test(before)) &&
      (after === "" || PATH_AFTER_RE.test(after))
    ) {
      return true;
    }
  }
}

/** Whether `refs` names no forgotten record at all. */
export function noForgottenRefs(refs: ForgottenRefs): boolean {
  return refs.ids.size === 0 && refs.paths.size === 0 && refs.links.size === 0;
}

/** A word of an indexed text that can name an entity: an id, a wikilink target, a path. */
const NAME_TOKEN_RE = /[\p{L}\p{N}_][\p{L}\p{N}_.\\/-]*/gu;

/** A wikilink's target (before any `|alias` or `#heading`). */
const WIKILINK_RE = /\[\[([^\]|#]+)/g;

/**
 * Whether `text` (an indexed log event's text) references a forgotten
 * record ({@link ForgottenRefs}): a word that is, after the chain-link
 * normalisation (`normalizeChainLink`: fence, alias, folders and `.md`
 * dropped), a forgotten id; a path word that is a forgotten lane entry's
 * page path; or a wikilink to a forgotten lane entry by its path or its
 * basename. A longer id that merely starts with one (`sig-x-2` beside
 * `sig-x`) is another record, and a bare word is no reference.
 */
export function namesForgottenEntity(text: string, refs: ForgottenRefs): boolean {
  if (noForgottenRefs(refs)) return false;
  const source = text.normalize("NFC");
  for (const match of source.matchAll(WIKILINK_RE)) {
    const target = match[1]!.trim();
    if (refs.paths.has(pathKey(target))) return true;
    const base = normalizeChainLink(target);
    if (refs.ids.has(base)) return true;
    // A basename link names the page of that name; a qualified link
    // (`[[projects/groceries]]`) names its own folder's page, matched by
    // its path above only.
    const qualified = target.includes("/") || target.includes("\\");
    if (!qualified && refs.links.has(base)) return true;
  }
  // A forgotten page path with a space is one unit in plain text
  // (`path: Brain/lists/weekly groceries.md`), which the word scan below
  // splits; it is matched whole, bounded on both sides.
  for (const path of refs.paths) {
    if (/\s/.test(path) && containsBounded(source, path)) return true;
  }
  for (const match of source.matchAll(NAME_TOKEN_RE)) {
    const word = match[0].replace(/[./\\-]+$/, "");
    if (word === "") continue;
    if (refs.ids.has(normalizeChainLink(word))) return true;
    if ((word.includes("/") || word.includes("\\")) && refs.paths.has(pathKey(word))) return true;
  }
  return false;
}
