/**
 * Read facade for preferences and retired preferences (design D4, D14,
 * task 2.10). The ~63 hand-rolled preference readers move to these two
 * calls in later packages; each answers from the preference fold on a
 * store-only machine and from `Brain/preferences/` and `Brain/retired/`
 * on an unswitched one, in one shape:
 *
 *  - `id` is the store's preference id, `pref-<slug>`, for an active and a
 *    retired preference alike (a retire is a field change of the same id,
 *    FORMAT.md "Kinds written by the dual writes");
 *  - `fields` are the preference's fields under the names the fold uses
 *    (derived keys without their on-disk `_` prefix, `"null"` as `null`),
 *    without the identity keys of a page (`id`, `kind`, `aliases`) and
 *    without the counters;
 *  - `counters` are derived from evidence in the fold, and read from the
 *    page on the legacy side, where the dream pass writes them;
 *  - `private` is the page rule (`../private-page.ts`) on the legacy side,
 *    and on the store side a record in `private` or fields that reserve it.
 *
 * The legacy frontmatter parser reads every scalar as text, so both sides
 * type the few fields the preference writer writes as non-strings
 * (booleans and numbers); every other field is returned as written. The
 * writers now record those values typed (a retire included, task 2.10);
 * the typing here stays for records written before that, and for pages.
 *
 * The fold keeps every field a record ever set, so a retired preference
 * read from the store still carries fields its retired page no longer
 * shows (for example `unconfirmed_until`); the page shows a subset.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

import { BRAIN_PREFERENCES_REL, BRAIN_RETIRED_REL } from "../../brain/path-constants.ts";
import { preferencePageProse, storeFieldsOf } from "../../brain/preference.ts";
import { parseFrontmatter } from "../../vault.ts";
import { PREFERENCE_COUNTER_FIELDS } from "../constants.ts";
import { preferenceFields } from "../dual-write-records.ts";
import type { PreferenceCounters } from "../fold-preferences.ts";
import { isPrivatePageFile } from "../private-page.ts";
import type { StoreInspection } from "../store-open.ts";
import { readSource, type ReadContext } from "./read-context.ts";
import { readEntitiesOf } from "./store-entities.ts";

/** One preference as the facades return it. */
export interface PreferenceEntry {
  /** `pref-<slug>`. */
  readonly id: string;
  readonly slug: string;
  readonly retired: boolean;
  readonly private: boolean;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly counters: PreferenceCounters;
}

const PREFERENCE_PREFIX = "pref-";
const RETIRED_PREFIX = "ret-";
const PAGE_EXT = ".md";
const RETIRED_STATUS = "retired";

/** Page keys that name the page, not a field of the preference. */
const IDENTITY_KEYS: ReadonlySet<string> = new Set(["id", "kind", "aliases"]);

/** Fields the preference writer writes as booleans and numbers. */
const BOOLEAN_FIELDS: ReadonlySet<string> = new Set(["pinned"]);
const NUMBER_FIELDS: ReadonlySet<string> = new Set(["confidence_value", "revision"]);

/**
 * The fields of a preference under the fold's names, without the page's
 * identity keys and the counters, with text-typed booleans and numbers
 * typed. Both sides go through it: a record a legacy writer built from a
 * parsed page carries the same text the page does.
 */
function viewFields(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(preferenceFields(fields))) {
    if (IDENTITY_KEYS.has(name)) continue;
    // A `text` of `null` is a write that cleared the body's prose: no prose.
    if (name === "text" && value === null) continue;
    out[name] = typedText(name, value);
  }
  return out;
}

function typedText(name: string, value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (value === "null") return null;
  if (BOOLEAN_FIELDS.has(name) && (value === "true" || value === "false")) return value === "true";
  if (NUMBER_FIELDS.has(name) && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return value;
}

function countOf(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

function legacyEntry(path: string, slug: string, retired: boolean): PreferenceEntry {
  const [meta, body] = parseFrontmatter(path);
  const named = storeFieldsOf(meta as Record<string, unknown>);
  // The page body's prose is the store's `text` field (FORMAT.md,
  // "Preferences"); a body the fields alone render carries none.
  const prose = preferencePageProse(meta, body, retired);
  const fields = viewFields(prose === null ? named : { ...named, text: prose });
  const counters = Object.fromEntries(
    PREFERENCE_COUNTER_FIELDS.map((name) => [name, countOf(named[name])]),
  ) as unknown as PreferenceCounters;
  return {
    id: `${PREFERENCE_PREFIX}${slug}`,
    slug,
    retired,
    private: isPrivatePageFile(path),
    fields,
    counters,
  };
}

function legacyEntries(
  vault: string,
  rel: string,
  prefix: string,
  retired: boolean,
): PreferenceEntry[] {
  const dir = join(vault, ...rel.split("/"));
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.startsWith(prefix) && e.name.endsWith(PAGE_EXT))
      .map((e) => e.name);
  } catch {
    return [];
  }
  return names.map((name) =>
    legacyEntry(join(dir, name), name.slice(prefix.length, -PAGE_EXT.length), retired),
  );
}

function storeEntries(store: StoreInspection, retired: boolean): PreferenceEntry[] {
  const out: PreferenceEntry[] = [];
  for (const [id, { state, private: isPrivate }] of readEntitiesOf(store).preferences) {
    if (!state.exists || !id.startsWith(PREFERENCE_PREFIX)) continue;
    if ((state.fields["status"] === RETIRED_STATUS) !== retired) continue;
    out.push({
      id,
      slug: id.slice(PREFERENCE_PREFIX.length),
      retired,
      private: isPrivate,
      fields: viewFields(state.fields),
      counters: state.counters,
    });
  }
  return out;
}

function byId(a: PreferenceEntry, b: PreferenceEntry): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function read(context: ReadContext, retired: boolean): PreferenceEntry[] {
  const source = readSource(context);
  if (source.kind === "store") {
    return source.store === null ? [] : storeEntries(source.store, retired).toSorted(byId);
  }
  const entries = retired
    ? legacyEntries(source.vault, BRAIN_RETIRED_REL, RETIRED_PREFIX, true)
    : legacyEntries(source.vault, BRAIN_PREFERENCES_REL, PREFERENCE_PREFIX, false);
  return entries.toSorted(byId);
}

/** Every active (not retired) preference, sorted by id. */
export function readPreferences(context: ReadContext = {}): PreferenceEntry[] {
  return read(context, false);
}

/** Every retired preference, sorted by id. */
export function readRetired(context: ReadContext = {}): PreferenceEntry[] {
  return read(context, true);
}
