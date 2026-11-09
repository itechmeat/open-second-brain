/**
 * The store side of the preference writers (design D4, D14 item 1, task
 * 2.10). On a store-only machine a preference is no page: it is the
 * preference fold (`../store/fold-preferences.ts`) of its `preference-set`
 * records, and every writer (`writePreference`, `moveToRetired`, the
 * writers that used to rewrite a page by hand) reads the preference it
 * changes from that fold and writes records only. This leaf module holds
 * what they share and imports nothing from the preference writer:
 *
 *  - {@link preferencesStoreOnly}, the switch every writer asks once;
 *  - {@link storePreferenceEntry}, the fold's view of one preference;
 *  - {@link typedPreferenceFields}, the value types the writer writes, for
 *    records built from a parsed page (the legacy parser reads every
 *    scalar as text, so `pinned: "false"` would otherwise reach the store);
 *  - {@link fieldsUnchanged}, the store twin of the writer's byte-identical
 *    no-op rule;
 *  - {@link preferenceLockTarget}, a device-local lock target once the page
 *    is gone (a lock file beside the page would write under `Brain/`).
 */

import { join } from "node:path";

import { processDirsEnv } from "../platform-dirs.ts";
import { canonicalJson } from "../integrity/digest.ts";
import { readStoreEntities, type StorePreference } from "../store/read/store-entities.ts";
import { isStoreOnly } from "../store/store-only.ts";
import { storesStateDir } from "../store/store-paths.ts";

/** Fields the preference writer writes as booleans. */
const BOOLEAN_FIELDS: ReadonlySet<string> = new Set(["pinned"]);
/** Fields the preference writer writes as numbers (the textual `"null"` reads as `null`). */
const NUMBER_FIELDS: ReadonlySet<string> = new Set(["confidence_value", "revision"]);

/** Whether preference writes for `vault` go to the store only. */
export function preferencesStoreOnly(vault: string | null, configPath?: string): boolean {
  return isStoreOnly({ vault, ...(configPath !== undefined ? { configPath } : {}) });
}

/** The preference `pref-<slug>` as the store's fold holds it, or `undefined`. */
export function storePreferenceEntry(
  slug: string,
  configPath?: string,
): StorePreference | undefined {
  const found = readStoreEntities(configPath)?.preferences.get(`pref-${slug}`);
  return found !== undefined && found.state.exists ? found : undefined;
}

/** Whether the fold's preference is retired. */
export function isRetiredEntry(entry: StorePreference): boolean {
  return entry.state.fields["status"] === "retired";
}

/**
 * `fields` with the few values the preference writer writes as booleans
 * and numbers typed again: a value read from a page as text (`"false"`,
 * `"0.5"`, `"3"`) becomes what the writer wrote. Every other value is
 * returned as it is.
 */
export function typedPreferenceFields(
  fields: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(fields)) out[name] = typedValue(name, value);
  return out;
}

function typedValue(name: string, value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (BOOLEAN_FIELDS.has(name) && (value === "true" || value === "false")) return value === "true";
  if (NUMBER_FIELDS.has(name)) {
    if (value === "null") return null;
    if (value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  }
  return value;
}

/**
 * Whether writing `next` would change nothing the fold holds for the
 * preference: every field it names already has that value. The store twin
 * of the writer's "a no-op rerun must not rewrite the page" rule.
 */
export function fieldsUnchanged(
  next: Readonly<Record<string, unknown>>,
  entry: StorePreference | undefined,
): boolean {
  if (entry === undefined) return false;
  const current = entry.state.fields;
  return Object.entries(next).every(
    ([name, value]) =>
      name in current &&
      canonicalJson(typedValue(name, value) ?? null) === canonicalJson(current[name] ?? null),
  );
}

/**
 * The lock target a preference write holds: beside the page on an
 * unswitched machine, in the device-local state once switched.
 */
export function preferenceLockTarget(pagePath: string, slug: string, storeOnly: boolean): string {
  if (!storeOnly) return pagePath;
  return join(storesStateDir(processDirsEnv()), "preference-locks", `pref-${slug}`);
}

/** Slugs of every preference the store's fold holds, active and retired, sorted. */
export function storePreferenceSlugs(configPath?: string): string[] {
  const entities = readStoreEntities(configPath);
  if (entities === null) return [];
  const out: string[] = [];
  for (const [id, entry] of entities.preferences) {
    if (entry.state.exists && id.startsWith("pref-")) out.push(id.slice("pref-".length));
  }
  return out.toSorted();
}

/**
 * The fold field that carries a preference page's body (FORMAT.md,
 * "Preferences"): the Markdown below the frontmatter, as the writer wrote
 * it, when it holds prose the fields do not render (an imported memory's
 * text, a human's notes under the page's headings, a writer's "How to
 * apply" guidance). The page view renders it as the body. It is no
 * frontmatter key: a page rebuilt from the fold carries it below the
 * frontmatter.
 */
export const PREFERENCE_TEXT_FIELD = "text";

/** A page body as the {@link PREFERENCE_TEXT_FIELD} value carries it. */
export function pageText(body: string): string {
  return body.replace(/\r\n?/g, "\n").replace(/^\n+/, "").trimEnd();
}

/** The page body a fold entry's fields carry, or `null` when no writer wrote one. */
export function textOfFields(fields: Readonly<Record<string, unknown>>): string | null {
  const text = fields[PREFERENCE_TEXT_FIELD];
  return typeof text === "string" ? text : null;
}
