/**
 * The set merge of list settings (task 3.12, design D19 item 1).
 *
 * A list setting (the schema fields `brain.schema.<field>`, the only keys
 * that take entry records) used to be one register over the whole list: two
 * devices that each added an entry at once kept only the later list, and
 * the other addition was lost. A `setting-entry` record instead adds or
 * removes one entry, and a key that holds at least one such record folds
 * per entry:
 *
 *  - Each entry is one register, keyed by its *slot*: the entry in the
 *    normalised form the schema pack parser reads (NFC, quotes stripped,
 *    trimmed, lower case; each side of a `name=value` line on its own),
 *    or for a keyed list (`name=value` lines, where one name holds one
 *    value) the normalised name before the first `=` (a compound
 *    `type.field` name split at its first `.`, each half on its own).
 *    So two spellings of one token are one register. Registers resolve as
 *    every register does (design D4): authority first, then the later clock.
 *  - A whole-list `setting-set` (the migration's import, `o2b brain
 *    settings set`; a value that is no list of one-line scalars is rejected,
 *    {@link listValueRejection}) offers every slot the key
 *    has ever named: its own entries as present, every other slot as
 *    removed. A `setting-unset` offers every slot as removed. So a
 *    history of whole lists alone resolves as the whole-list register did.
 *  - The value is the present entries, ordered by the fold order of the
 *    record that decided each, then by its place in that record. When no
 *    entry is present the key is removed.
 *
 * A key with no `setting-entry` record folds as the plain register.
 * The fold is a pure function of the record set: every delivery order
 * gives the same list.
 */

import { normalizeSchemaToken, splitCompoundSchemaKey } from "../brain/schema-vocab.ts";
import type { StoreRecord } from "./envelope.ts";
import { recordAuthority, RegisterSet, TOMBSTONE, type RegisterState } from "./fold.ts";
import { SETTING_ENTRY_KIND, SETTING_UNSET_KIND } from "./constants.ts";

/**
 * List settings whose entries are `name=value` lines holding one value per
 * name: a change of the value replaces the entry instead of adding one.
 */
export const KEYED_LIST_SETTINGS: ReadonlySet<string> = new Set([
  "brain.schema.prefixes",
  "brain.schema.expert_routing",
  "brain.schema.attributes",
  "brain.schema.frontmatter_tiers",
]);

/**
 * The keys that take `setting-entry` records: the schema field lists
 * `brain.schema.<field>` (design D19 item 1). Every other key holds one
 * value and stays on the plain register; an entry record for it is
 * rejected, so it can never turn a human value into a removed list.
 */
const LIST_SETTING_KEY_RE = /^brain\.schema\.[a-z][a-z0-9_]*$/;

/** Whether `key` is a list setting that folds per entry. */
export function isListSettingKey(key: string): boolean {
  return LIST_SETTING_KEY_RE.test(key);
}

/**
 * Keyed lists whose name is a compound `type.field` key: the pack parser
 * splits it at its first `.` and reads each half as a token, so
 * `paper . year` and `paper.year` name one key.
 */
const COMPOUND_KEYED_LIST_SETTINGS: ReadonlySet<string> = new Set([
  "brain.schema.attributes",
  "brain.schema.frontmatter_tiers",
]);

/**
 * One part of an entry in the form the schema pack parser reads it
 * (`../brain/schema-pack.ts`): surrounding quotes stripped, then the
 * parser's own `normalizeSchemaToken` (NFC, trimmed, lower case).
 */
function canonicalPart(raw: string): string {
  let text = raw.normalize("NFC").trim();
  if (
    text.length >= 2 &&
    ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))
  ) {
    text = text.slice(1, -1);
  }
  return normalizeSchemaToken(text);
}

/** The name of a keyed entry: for a compound key each half normalised on its own, as the parser splits it. */
function keyedName(key: string, raw: string): string {
  const name = canonicalPart(raw);
  if (!COMPOUND_KEYED_LIST_SETTINGS.has(key)) return name;
  const halves = splitCompoundSchemaKey(name);
  return halves === null
    ? name
    : `${normalizeSchemaToken(halves[0])}.${normalizeSchemaToken(halves[1])}`;
}

/**
 * The register an entry of list setting `key` belongs to: the entry in
 * the normalised form the pack parser reads, so two spellings of one
 * token are one register. A `name=value` line is split at its first `=`
 * and each side normalised on its own (each side of a `->` pair too); for
 * a keyed list the slot is the normalised name alone. Quotes around the
 * whole line count as quotes around the line, not around its first and
 * last part, unless the quote character also stands inside it.
 */
export function settingEntrySlot(key: string, entry: string): string {
  const text = unquotedLine(entry.normalize("NFC").trim());
  const eq = text.indexOf("=");
  if (eq < 0) return canonicalPart(text);
  if (KEYED_LIST_SETTINGS.has(key)) return keyedName(key, text.slice(0, eq));
  const name = canonicalPart(text.slice(0, eq));
  const value = text
    .slice(eq + 1)
    .split("->")
    .map(canonicalPart)
    .join("->");
  return `${name}=${value}`;
}

/** `text` without the quotes around the whole of it, when they are its only ones. */
function unquotedLine(text: string): string {
  const quote = text[0];
  if (text.length < 2 || (quote !== '"' && quote !== "'") || !text.endsWith(quote)) return text;
  const inner = text.slice(1, -1);
  return inner.includes(quote) ? text : inner.trim();
}

/**
 * The body field of a conditional removal: the id of the record that
 * decided the entry's slot when the removal was judged. The removal
 * applies only while that record still decides the slot among the key's
 * unconditional records, so a replacement written meanwhile on another
 * device, delivered before or after the removal, is never removed by it.
 */
export const IF_DECIDED_BY_FIELD = "if_decided_by";

/** The condition of a `setting-entry` removal, or `undefined` for an unconditional record. */
function conditionOf(record: StoreRecord): string | undefined {
  const value = record.body[IF_DECIDED_BY_FIELD];
  return record.kind === SETTING_ENTRY_KIND && typeof value === "string" ? value : undefined;
}

/**
 * Why a `setting-entry` record is malformed, or `null`. Authority and key
 * are checked by the settings fold first.
 */
export function settingEntryRejection(record: StoreRecord): string | null {
  const entry = record.body["entry"];
  if (typeof entry !== "string" || entry.trim() === "" || /[\r\n]/.test(entry)) {
    return "entry must be one non-empty line";
  }
  if (typeof record.body["present"] !== "boolean") return "present must be true or false";
  const condition = record.body[IF_DECIDED_BY_FIELD];
  if (condition !== undefined) {
    if (typeof condition !== "string" || condition === "") {
      return `${IF_DECIDED_BY_FIELD} must be a record id`;
    }
    if (record.body["present"] !== false) return `${IF_DECIDED_BY_FIELD} is for a removal only`;
  }
  const key = String(record.body["key"]);
  if (!isListSettingKey(key)) return `${key} is not a list setting`;
  return null;
}

function isOneLineScalar(item: unknown): boolean {
  return ["string", "number", "boolean"].includes(typeof item) && !/[\r\n]/.test(String(item));
}

/**
 * Why the whole-list value of list setting `key` is malformed, or `null`:
 * it must be a list of one-line scalars, each an entry as a `setting-entry`
 * record would hold it. A scalar or an object in its place would hide the
 * stored list from every reader of the pack while deciding no entry of it,
 * and an element with a line break would read as several pack lines.
 */
export function listValueRejection(key: string, value: unknown): string | null {
  if (!Array.isArray(value)) return `${key} is a list setting: its value must be a list`;
  if (!value.every(isOneLineScalar))
    return `${key} must list one-line strings, numbers or booleans`;
  return null;
}

/** One list key folded per entry. */
export interface ListSettingFold {
  /** The key's register as the settings fold reports it; its value is the list. */
  readonly state: RegisterState<unknown>;
  /** Each slot's register: the entry text, or removed. */
  readonly slots: ReadonlyMap<string, RegisterState<string>>;
}

/**
 * Fold one list key from its valid `setting-set`, `setting-unset` and
 * `setting-entry` records, given in fold order; `null` when no record is
 * left once the conditional removals whose condition fails are dropped.
 * A conditional removal ({@link IF_DECIDED_BY_FIELD}) is judged against
 * the key's unconditional records alone, so the result does not depend on
 * the order removals arrive in.
 */
export function foldListSetting(
  key: string,
  records: ReadonlyArray<StoreRecord>,
): ListSettingFold | null {
  const plain = records.filter((record) => conditionOf(record) === undefined);
  if (plain.length === records.length) return foldSlots(key, records);
  const decided = plain.length === 0 ? null : foldSlots(key, plain);
  const kept = records.filter((record) => {
    const condition = conditionOf(record);
    if (condition === undefined) return true;
    const slot = settingEntrySlot(key, record.body["entry"] as string);
    return decided?.slots.get(slot)?.winner.record.id === condition;
  });
  return kept.length === 0 ? null : foldSlots(key, kept);
}

function foldSlots(key: string, records: ReadonlyArray<StoreRecord>): ListSettingFold {
  const universe = new Set<string>();
  for (const record of records) {
    for (const text of entriesOf(record)) universe.add(settingEntrySlot(key, text));
  }
  const registers = new RegisterSet<string>();
  /** `<record index>\u0000<slot>` -> place of the entry in that record. */
  const place = new Map<string, number>();
  const index = new Map<string, number>();
  records.forEach((record, i) => {
    index.set(record.id, i);
    const authority = recordAuthority(record)!;
    if (record.kind === SETTING_ENTRY_KIND) {
      const text = record.body["entry"] as string;
      const slot = settingEntrySlot(key, text);
      registers.offer(slot, {
        record,
        authority,
        value: record.body["present"] === true ? text : TOMBSTONE,
      });
      place.set(`${i}\u0000${slot}`, 0);
      return;
    }
    const listed = new Map<string, string>();
    entriesOf(record).forEach((text, at) => {
      const slot = settingEntrySlot(key, text);
      listed.set(slot, text);
      place.set(`${i}\u0000${slot}`, at);
    });
    for (const slot of universe) {
      registers.offer(slot, { record, authority, value: listed.get(slot) ?? TOMBSTONE });
    }
  });
  const slots = new Map<string, RegisterState<string>>();
  for (const slot of registers.keys()) slots.set(slot, registers.get(slot)!);
  const decided = (slot: string, state: RegisterState<string>): [number, number] => {
    const i = index.get(state.winner.record.id)!;
    return [i, place.get(`${i}\u0000${slot}`) ?? 0];
  };
  const present = [...slots.entries()]
    .filter(([, state]) => !state.removed)
    .map(([slot, state]) => ({ text: state.value!, at: decided(slot, state) }))
    .toSorted((a, b) => a.at[0] - b.at[0] || a.at[1] - b.at[1]);
  // The record that decided last stands for the whole key (its authority
  // and id are what a settings view reports). Records that name no entry
  // at all (empty whole lists, unsets) decide no slot: the key is then won
  // as the whole-list register would win it.
  let winner = slots.size === 0 ? wholeListWinner(records) : [...slots.values()][0]!.winner;
  for (const state of slots.values()) {
    if (index.get(state.winner.record.id)! > index.get(winner.record.id)!) winner = state.winner;
  }
  const history = records.map((record) => ({
    record,
    authority: recordAuthority(record)!,
    value: record.kind === SETTING_UNSET_KIND ? TOMBSTONE : rawValue(record),
  }));
  const removed = present.length === 0;
  return {
    state: {
      value: removed ? null : present.map((p) => p.text),
      removed,
      winner: { record: winner.record, authority: winner.authority, value: winner.value },
      history,
    },
    slots,
  };
}

/** The winner of `records` (in fold order) read as one register over the whole list. */
function wholeListWinner(records: ReadonlyArray<StoreRecord>): RegisterState<string>["winner"] {
  const register = new RegisterSet<string>();
  for (const record of records) {
    register.offer("", { record, authority: recordAuthority(record)!, value: TOMBSTONE });
  }
  return register.get("")!.winner;
}

/** The entries a record names: a whole list's elements, or its one entry. */
function entriesOf(record: StoreRecord): string[] {
  if (record.kind === SETTING_ENTRY_KIND) return [record.body["entry"] as string];
  if (record.kind === SETTING_UNSET_KIND) return [];
  const value = record.body["value"];
  return Array.isArray(value) ? value.map(String) : [];
}

function rawValue(record: StoreRecord): unknown {
  if (record.kind === SETTING_ENTRY_KIND) {
    return { entry: record.body["entry"], present: record.body["present"] };
  }
  return record.body["value"];
}
