/**
 * The one write path for preference writers that edit a preference's page
 * themselves instead of calling `writePreference` (task 2.10): the memory
 * importers, the frontmatter remediation, the expiration setter, page id
 * stamping, page dedup, lint consolidation and write batches.
 *
 * Each hands its legacy page write and the frontmatter the page carries
 * after it to {@link routePreferencePage}:
 *
 *  - on a store-only machine the page write never runs and the
 *    preference's records go to the store only, so nothing under `Brain/`
 *    changes;
 *  - on an unswitched machine the page is written and the same records
 *    are dual-written behind the flag, as `writePreference` does.
 *
 * The records are those `writePreference` writes (`preferenceStoreRecords`):
 * the page's fields under the store's names, with the value types the
 * writer writes (the page parser reads every scalar as text), the page's
 * identity keys left out. One privacy verdict covers the write: the
 * fields as the page carries them and, once switched, the preference as
 * the fold holds it.
 */

import type { Authority } from "../store/constants.ts";
import { authorityFromOrigin } from "../store/dual-write.ts";
import { withOperationPrivacy } from "../store/operation-scope.ts";
import { routeWrite, storeWrite, type RoutedWrite } from "../store/store-write.ts";
import { canonicalJson } from "../integrity/digest.ts";
import { join, posix } from "node:path";
import { BRAIN_PREFERENCES_REL, BRAIN_RETIRED_REL } from "./path-constants.ts";
import type { FrontmatterMap } from "../types.ts";
import { formatFrontmatter, parseFrontmatterText } from "../vault.ts";
import { atomicWriteFileSync } from "../fs-atomic.ts";
import { preferencePath } from "./paths.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";
import {
  preferencePrivacy,
  preferenceStoreRecords,
  preferencePageBody,
  storeFieldsOf,
  storePreferenceMeta,
  withPreferenceProse,
} from "./preference.ts";
import {
  PREFERENCE_TEXT_FIELD,
  preferencesStoreOnly,
  storePreferenceEntry,
  storePreferenceSlugs,
  typedPreferenceFields,
} from "./preference-store.ts";

export interface PreferencePageWrite<T> {
  readonly vault: string;
  /** The preference's slug: `pref-<slug>` (a retired page `ret-<slug>` is the same preference). */
  readonly slug: string;
  /** The page's frontmatter after the write, as the page carries it. */
  readonly frontmatter: FrontmatterMap | (() => FrontmatterMap);
  /** The legacy page write; runs only on an unswitched machine. */
  readonly legacy: () => T;
  /**
   * The page's body after the write, for a writer that writes one: its
   * prose (what the fields do not render) goes to the store as `text`
   * (FORMAT.md, "Preferences"). Absent for a writer that changes only
   * frontmatter, which leaves `text` as it is.
   */
  readonly body?: string | (() => string);
  /** Who decided; absent derives it from the process's origin channel. */
  readonly authority?: Authority;
  readonly configPath?: string;
}

/** The page's fields as the store records carry them. */
function storeFields(meta: FrontmatterMap): Record<string, unknown> {
  const {
    id: _id,
    kind: _kind,
    aliases: _aliases,
    ...fields
  } = typedPreferenceFields(storeFieldsOf(meta as Record<string, unknown>));
  return fields;
}

/** Route one preference page write; see the module docblock. */
export function routePreferencePage<T>(spec: PreferencePageWrite<T>): RoutedWrite<T> {
  // Vault-identity write guard (context-integrity-gates, Unit J): every
  // caller guards its own entry too; this one covers the shared path.
  assertVaultIdentityForWrite(spec.vault);
  const storeOnly = preferencesStoreOnly(spec.vault, spec.configPath);
  let fields: Record<string, unknown> | null = null;
  const fieldsOf = (): Record<string, unknown> => {
    if (fields === null) {
      const meta = typeof spec.frontmatter === "function" ? spec.frontmatter() : spec.frontmatter;
      fields = storeFields(meta);
      if (spec.body !== undefined) {
        const body = typeof spec.body === "function" ? spec.body() : spec.body;
        fields = withPreferenceProse(fields, meta, body);
      }
    }
    return fields;
  };
  let pagePrivacy: (() => boolean) | null = null;
  const privacy = (): boolean => {
    if (storeOnly && (storePreferenceEntry(spec.slug, spec.configPath)?.private ?? false)) {
      return true;
    }
    pagePrivacy ??= preferencePrivacy(spec.vault, fieldsOf());
    return pagePrivacy();
  };
  return withOperationPrivacy(privacy, () =>
    routeWrite({
      legacy: spec.legacy,
      store: () =>
        preferenceStoreRecords(
          `pref-${spec.slug}`,
          fieldsOf(),
          spec.authority ?? authorityFromOrigin(),
          privacy(),
        ),
      context: {
        vault: spec.vault,
        ...(spec.configPath !== undefined ? { configPath: spec.configPath } : {}),
      },
    }),
  );
}

/**
 * Write the whole text of the active preference page `pref-<slug>`: the
 * file on an unswitched machine, its records once switched.
 */
export function writePreferencePageText(
  vault: string,
  slug: string,
  text: string,
  options: { readonly authority?: Authority; readonly configPath?: string } = {},
): RoutedWrite<void> {
  return routePreferencePage({
    vault,
    slug,
    frontmatter: () => parseFrontmatterText(text)[0],
    body: () => parseFrontmatterText(text)[1],
    legacy: () => {
      atomicWriteFileSync(preferencePath(vault, slug), text);
    },
    ...options,
  });
}

/**
 * The text of the active preference page `pref-<slug>` a writer merges
 * into: the file on an unswitched machine (read by `readPage`), the page
 * rebuilt from the store's fold once switched (no body), or `null` when
 * there is none.
 */
export function existingPreferencePageText(
  vault: string,
  slug: string,
  readPage: (path: string) => string | null,
  configPath?: string,
): string | null {
  if (!preferencesStoreOnly(vault, configPath)) return readPage(preferencePath(vault, slug));
  const page = storePreferenceMeta(slug, configPath);
  return page === null || page.retired
    ? null
    : formatFrontmatter(page.meta, preferencePageBody(page.meta, page.text, false));
}

/** One preference of the store's fold as a page would carry it. */
export interface StorePreferencePage {
  readonly slug: string;
  readonly retired: boolean;
  /** The page's vault-relative path, `/`-separated, as the legacy tree names it. */
  readonly rel: string;
  /** The page's absolute path in the vault (no file exists once switched). */
  readonly abs: string;
  readonly meta: FrontmatterMap;
  /** The page body: the fold's `text`, else the body its fields render. */
  readonly body: string;
}

/** Every preference the store's fold holds, page-shaped (the store side of a page walk). */
export function storePreferencePages(vault: string, configPath?: string): StorePreferencePage[] {
  const out: StorePreferencePage[] = [];
  for (const slug of storePreferenceSlugs(configPath)) {
    const page = storePreferenceMeta(slug, configPath);
    if (page === null) continue;
    const rel = page.retired
      ? posix.join(BRAIN_RETIRED_REL, `ret-${slug}.md`)
      : posix.join(BRAIN_PREFERENCES_REL, `pref-${slug}.md`);
    out.push({
      slug,
      retired: page.retired,
      rel,
      abs: join(vault, ...rel.split("/")),
      meta: page.meta,
      body: preferencePageBody(page.meta, page.text, page.retired),
    });
  }
  return out;
}

/**
 * Write the fields a page-level rewrite changed on a preference of the
 * store's fold: `next` is the page's frontmatter after the rewrite. Only
 * the fields whose value changed are written. Returns whether anything
 * was written.
 */
export function rewriteStorePreference(
  vault: string,
  page: StorePreferencePage,
  next: FrontmatterMap,
  configPath?: string,
  nextBody?: string,
): boolean {
  const before = withPreferenceProse(storeFields(page.meta), page.meta, page.body, page.retired);
  const after =
    nextBody === undefined
      ? storeFields(next)
      : withPreferenceProse(storeFields(next), next, nextBody, page.retired);
  if (nextBody === undefined) delete before[PREFERENCE_TEXT_FIELD];
  // A field the rewrite dropped (lint consolidation, remediation, dedup)
  // is cleared (`null`): a record only proposes the fields it names, and
  // the page an unswitched machine rewrites loses the key.
  const changed: Record<string, unknown> = {};
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const value = Object.hasOwn(after, name) ? after[name] : null;
    if (canonicalJson(value ?? null) !== canonicalJson(before[name] ?? null)) changed[name] = value;
  }
  if (Object.keys(changed).length === 0) return false;
  storeWritePreferenceFields(vault, page.slug, changed, configPath);
  return true;
}

/** Write `fields` of the preference `pref-<slug>` to the store only (a store-only machine). */
function storeWritePreferenceFields(
  vault: string,
  slug: string,
  fields: Record<string, unknown>,
  configPath?: string,
): void {
  const privacy = (): boolean =>
    (storePreferenceEntry(slug, configPath)?.private ?? true) || preferencePrivacy(vault, fields)();
  withOperationPrivacy(privacy, () =>
    storeWrite(
      () => preferenceStoreRecords(`pref-${slug}`, fields, authorityFromOrigin(), privacy()),
      { vault, ...(configPath !== undefined ? { configPath } : {}) },
    ),
  );
}
