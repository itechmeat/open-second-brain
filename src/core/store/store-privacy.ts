/**
 * The store-backed privacy judge (design D14 item 18, task 2.10): once a
 * machine is store-only (`store-only.ts`), a reference to a preference or
 * a signal is judged from the store's folds, not from legacy pages. The
 * legacy pages may still be on disk (the tree stays read-only until every
 * device has switched, D11a) or long gone; either way they no longer say
 * what the brain holds.
 *
 * Rules (fail closed, FORMAT.md "Partitions"):
 *
 *  - a preference (`pref-<slug>` or `ret-<slug>`, the same entity) or a
 *    signal (`sig-<date>-<slug>`) is private when any of its records sits
 *    in `private` or its fields reserve it as private;
 *  - a reference the folds cannot resolve is private: the entity may live
 *    in a partition this machine does not hold, or not have arrived yet;
 *  - no readable store resolves nothing, so every such reference is
 *    private.
 *
 * The reference parsing stays with the legacy judge
 * (`reference-privacy.ts`), which asks {@link judgesFromStore} first.
 */

import { posix } from "node:path";

import { parseWikilink, stripBrainIdPrefix } from "../brain/wikilink.ts";
import { readStoreEntities } from "./read/store-entities.ts";
import { isStoreOnly } from "./store-only.ts";

/** A signal id as the signal writer allocates it: `sig-<YYYY-MM-DD>-<slug>`. */
export const SIGNAL_ID_RE = /^sig-\d{4}-\d{2}-\d{2}-[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** The preference prefix of the store's preference ids. */
const PREFERENCE_ID_PREFIX = "pref-";

/** Whether references are judged from the store's folds for `vault` (`null`: no vault). */
export function judgesFromStore(vault: string | null, configPath?: string): boolean {
  return isStoreOnly({ vault, ...(configPath !== undefined ? { configPath } : {}) });
}

/**
 * The signal id a reference names (`sig-...`, `[[sig-...]]`, a path to a
 * signal page), or `undefined` when it names none.
 */
export function signalIdOf(ref: string): string | undefined {
  const trimmed = ref.trim();
  const target = (parseWikilink(trimmed) ?? trimmed).split("|")[0]!.split("#")[0]!.trim();
  const base = posix.basename(target.replaceAll("\\", "/")).replace(/\.md$/, "");
  return SIGNAL_ID_RE.test(base) ? base : undefined;
}

/** Whether the preference `id` names (`pref-<slug>` or `ret-<slug>`) is private by the store's fold. */
export function storePreferenceIdIsPrivate(id: string, configPath?: string): boolean {
  const slug = stripBrainIdPrefix(id);
  if (slug === "") return true;
  const entities = readStoreEntities(configPath);
  if (entities === null) return true;
  const found = entities.preferences.get(`${PREFERENCE_ID_PREFIX}${slug}`);
  return found === undefined || found.private;
}

/**
 * Whether the fold holds the preference `id` names AND it is private: for
 * a guessed reference (a reconcile topic), which is judged only when the
 * preference exists, as the legacy judge judges it only when its page does.
 */
export function storePreferenceIdIsKnownPrivate(id: string, configPath?: string): boolean {
  const slug = stripBrainIdPrefix(id);
  const entities = readStoreEntities(configPath);
  // No readable store at all: nothing can be judged, fail closed.
  if (entities === null) return true;
  const found = entities.preferences.get(`${PREFERENCE_ID_PREFIX}${slug}`);
  // Unknown while a shard is unreadable: it may hold the preference.
  return found?.private ?? entities.unreadable.length > 0;
}

/** Whether the signal `id` is private by the store's signal records. */
export function storeSignalIdIsPrivate(id: string, configPath?: string): boolean {
  const entities = readStoreEntities(configPath);
  if (entities === null) return true;
  const found = entities.signals.get(id);
  return found === undefined || found.private;
}
