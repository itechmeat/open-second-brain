/**
 * Human edits of view pages as store records (spec `human-view` "Human
 * edits flow back"; task 2.8).
 *
 * An edit is the difference between the merge base (the last rendered
 * text, with the key of every line) and what the user left on disk. Each
 * changed line becomes one human record:
 *
 *  - a rule line of `about-me.md` reworded: a `preference-set` of that
 *    preference's `principle`; deleted (or emptied): a `preference-set`
 *    that retires it. The page is the user's own account of their rules,
 *    so the change lands on the rule itself;
 *  - any other generated line reworded: a `view-correction` of that line's
 *    key with the user's text; deleted: a `view-correction` that hides it;
 *  - a line the user added: a `view-addition` placed after the nearest
 *    generated line above it.
 *
 * The id comment line and blank layout lines are never mapped. The next
 * render folds the corrections back in (see {@link applyCorrections}), so
 * summary pages (the history, the profile) keep the user's corrections.
 * Corrections fold like every register: authority, then the later clock.
 */

import { AUTHORITY_FIELD, PREFERENCE_SET_KIND } from "../store/constants.ts";
import type { RecordBody, StoreRecord } from "../store/envelope.ts";
import { prepareRecords, recordAuthority, RegisterSet, TOMBSTONE } from "../store/fold.ts";
import { VIEW_ABOUT_ME_PAGE, VIEW_ADDITION_KIND, VIEW_CORRECTION_KIND } from "./constants.ts";
import { alignable, diffLines } from "./line-diff.ts";
import { ID_LINE_KEY, type PageLine, type PageModel } from "./pages.ts";

/** A record an edit produces, before the caller picks its partition. */
export interface EditRecord {
  readonly stream: "events";
  readonly kind: string;
  readonly body: RecordBody;
}

/** Retired status a deleted rule line sets. */
const RETIRED = "retired";

const PREF_KEY_PREFIX = "pref:";
const ADDITION_KEY_PREFIX = "add:";
const LIST_MARKER_RE = /^\s*(?:[-*+]|\d+[.)])\s+/;
/** A list marker with nothing after it is an emptied line too. */
const BARE_LIST_MARKER_RE = /^\s*(?:[-*+]|\d+[.)])(?:\s+|$)/;
/** How the id comment line starts, kept as written or retyped. */
const ID_LINE_START = "<!-- open-second-brain-view";

/**
 * Deleted keyed lines from which one ingest is refused, as a share of the
 * page's keyed lines (and at least this many): a page a sync tool or an
 * app truncated would otherwise retire every rule with human authority.
 * The minimum is deliberate: on a page with one or two keyed lines,
 * deleting them all is an edit a user makes on purpose (removing their
 * last rule), and refusing it would leave no way to make it from the
 * page; a truncation there retires at most two rules, which the page's
 * history and the store keep.
 */
const MASS_DELETION_MIN = 3;
const MASS_DELETION_SHARE = 0.5;

interface Addition {
  readonly id: string;
  readonly after: string | null;
  readonly text: string;
}

/** The corrections of one page. */
export interface PageCorrections {
  /** Line key to the user's text, or `null` when the user hid the line. */
  readonly overrides: ReadonlyMap<string, string | null>;
  /** Added lines, in fold order. */
  readonly additions: ReadonlyArray<Addition>;
}

const EMPTY: PageCorrections = { overrides: new Map(), additions: [] };

/** Fold correction and addition records into corrections per page. */
export function foldCorrections(
  input: Iterable<StoreRecord>,
): ReadonlyMap<string, PageCorrections> {
  const { records } = prepareRecords(input);
  const registers = new RegisterSet<string>();
  const additions = new Map<string, Addition[]>();
  for (const record of records) {
    const authority = recordAuthority(record);
    const page = record.body["page"];
    if (authority === null || typeof page !== "string") continue;
    if (record.kind === VIEW_CORRECTION_KIND) {
      const key = record.body["key"];
      const text = record.body["text"];
      const hidden = record.body["hidden"] === true;
      if (typeof key !== "string" || (!hidden && typeof text !== "string")) continue;
      registers.offer(`${page}\u0000${key}`, {
        record,
        authority,
        value: hidden ? TOMBSTONE : (text as string),
      });
    } else if (record.kind === VIEW_ADDITION_KIND) {
      // A line the user added: an addition of any other authority is not one.
      if (authority !== "human") continue;
      const after = record.body["after"];
      const text = record.body["text"];
      if (typeof text !== "string" || (after !== null && typeof after !== "string")) continue;
      const list = additions.get(page) ?? [];
      // The same line added after the same anchor twice (a conflict copy
      // and the page both carry it, or an ingest that ran again after a
      // crash) is one addition.
      if (list.some((a) => a.after === after && a.text === text)) continue;
      additions.set(page, [...list, { id: record.id, after, text }]);
    }
  }
  const out = new Map<string, { overrides: Map<string, string | null>; additions: Addition[] }>();
  const entry = (page: string) => {
    let e = out.get(page);
    if (e === undefined) {
      e = { overrides: new Map(), additions: [] };
      out.set(page, e);
    }
    return e;
  };
  for (const composite of registers.keys()) {
    const [page, key] = composite.split("\u0000") as [string, string];
    const state = registers.get(composite)!;
    entry(page).overrides.set(key, state.removed ? null : state.value);
  }
  for (const [page, list] of additions) entry(page).additions.push(...list);
  return out;
}

/** The page with the user's corrections and additions applied. */
export function applyCorrections(
  model: PageModel,
  all: ReadonlyMap<string, PageCorrections>,
): PageModel {
  const corrections = all.get(model.page) ?? EMPTY;
  const byAnchor = new Map<string | null, Addition[]>();
  const keys = new Set(model.lines.flatMap((l) => (l.key === null ? [] : [l.key])));
  for (const add of corrections.additions) keys.add(`${ADDITION_KEY_PREFIX}${add.id}`);
  for (const add of corrections.additions) {
    const anchor = add.after !== null && keys.has(add.after) ? add.after : null;
    byAnchor.set(anchor, [...(byAnchor.get(anchor) ?? []), add]);
  }
  const lines: PageLine[] = [];
  const emit = (line: PageLine): void => {
    const override = line.key !== null ? corrections.overrides.get(line.key) : undefined;
    if (override === null) {
      // hidden, but what was added after it still shows
    } else {
      lines.push(override === undefined ? line : { key: line.key, text: override });
    }
    if (line.key === null) return;
    for (const add of byAnchor.get(line.key) ?? []) {
      emit({ key: `${ADDITION_KEY_PREFIX}${add.id}`, text: add.text });
    }
  };
  for (const line of model.lines) emit(line);
  for (const add of byAnchor.get(null) ?? []) {
    emit({ key: `${ADDITION_KEY_PREFIX}${add.id}`, text: add.text });
  }
  return { page: model.page, lines };
}

function correction(page: string, key: string, text: string | null): EditRecord {
  if (page === VIEW_ABOUT_ME_PAGE && key.startsWith(PREF_KEY_PREFIX)) {
    const preference = key.slice(PREF_KEY_PREFIX.length);
    const fields =
      text === null ? { status: RETIRED } : { principle: text.replace(LIST_MARKER_RE, "").trim() };
    return {
      stream: "events",
      kind: PREFERENCE_SET_KIND,
      body: { [AUTHORITY_FIELD]: "human", preference, fields },
    };
  }
  return {
    stream: "events",
    kind: VIEW_CORRECTION_KIND,
    body:
      text === null
        ? { [AUTHORITY_FIELD]: "human", page, key, hidden: true }
        : { [AUTHORITY_FIELD]: "human", page, key, text },
  };
}

function addition(page: string, after: string | null, text: string): EditRecord {
  return {
    stream: "events",
    kind: VIEW_ADDITION_KIND,
    body: { [AUTHORITY_FIELD]: "human", page, after, text },
  };
}

/** The key of the nearest keyed line at or above `index`, the id line excluded. */
function anchorAt(keys: ReadonlyArray<string | null>, index: number): string | null {
  for (let i = index; i >= 0; i--) {
    const key = keys[i];
    if (key !== null && key !== undefined && key !== ID_LINE_KEY) return key;
  }
  return null;
}

/**
 * The human records that turn `base` (with its line keys) into `edited`.
 * Line endings and a byte order mark are normalised first, so a phone app
 * that rewrites the whole file in its own style yields only the lines it
 * really changed.
 */
export function editRecords(
  page: string,
  base: ReadonlyArray<string>,
  baseKeys: ReadonlyArray<string | null>,
  edited: ReadonlyArray<string>,
): EditRecord[] {
  const out: EditRecord[] = [];
  for (const hunk of diffLines(base, edited)) {
    let anchor = anchorAt(baseKeys, hunk.baseStart - 1);
    const baseLen = hunk.baseEnd - hunk.baseStart;
    const otherLen = hunk.otherEnd - hunk.otherStart;
    const paired = Math.min(baseLen, otherLen);
    for (let p = 0; p < paired; p++) {
      const key = baseKeys[hunk.baseStart + p] ?? null;
      const text = edited[hunk.otherStart + p]!.trimEnd();
      if (key === ID_LINE_KEY) {
        // Text typed over the id comment (an editor that hides comments)
        // is the user's, kept as an addition at the top.
        if (text.trim() !== "" && !text.trimStart().startsWith(ID_LINE_START)) {
          out.push(addition(page, null, text));
        }
        continue;
      }
      if (key === null) {
        if (text.trim() !== "") out.push(addition(page, anchor, text));
        continue;
      }
      // A line cleared down to its list marker is emptied too.
      const emptied = text.replace(BARE_LIST_MARKER_RE, "").trim() === "";
      out.push(correction(page, key, emptied ? null : text));
      anchor = key;
    }
    for (let p = paired; p < baseLen; p++) {
      const key = baseKeys[hunk.baseStart + p] ?? null;
      if (key !== null && key !== ID_LINE_KEY) out.push(correction(page, key, null));
    }
    for (let p = paired; p < otherLen; p++) {
      const text = edited[hunk.otherStart + p]!.trimEnd();
      if (text.trim() !== "") out.push(addition(page, anchor, text));
    }
  }
  return out;
}

/** Why an edit was stored as bytes only, not turned into records. */
export type EditRefusal = "unalignable" | "mass-deletion";

/**
 * {@link editRecords}, refused (no record, `refusal` set) when the edit
 * cannot be trusted line by line: the pages differ too much to align
 * (lines would pair by position and land on the wrong keys), or the edit
 * deletes most of the page's keyed lines (a truncated file).
 */
export function reviewedEdits(
  page: string,
  base: ReadonlyArray<string>,
  baseKeys: ReadonlyArray<string | null>,
  edited: ReadonlyArray<string>,
): { readonly records: EditRecord[]; readonly refusal: EditRefusal | null } {
  if (!alignable(base, edited)) return { records: [], refusal: "unalignable" };
  const records = editRecords(page, base, baseKeys, edited);
  const keyed = baseKeys.filter((k) => k !== null && k !== ID_LINE_KEY).length;
  const deleted = records.filter(isDeletion).length;
  if (deleted >= MASS_DELETION_MIN && deleted > keyed * MASS_DELETION_SHARE) {
    return { records: [], refusal: "mass-deletion" };
  }
  return { records, refusal: null };
}

function isDeletion(record: EditRecord): boolean {
  if (record.kind === VIEW_CORRECTION_KIND) return record.body["hidden"] === true;
  const fields = record.body["fields"] as Record<string, unknown> | undefined;
  return record.kind === PREFERENCE_SET_KIND && fields?.["status"] === RETIRED;
}

/** Split page text into lines: BOM dropped, CRLF and CR read as LF, one trailing newline ignored. */
export function pageLines(text: string): string[] {
  const normal = text.replace(/^\uFEFF/, "").replaceAll(/\r\n?/g, "\n");
  const trimmed = normal.endsWith("\n") ? normal.slice(0, -1) : normal;
  return trimmed === "" ? [] : trimmed.split("\n");
}
