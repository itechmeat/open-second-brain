/**
 * The page names of the memory records a store-only machine holds (design
 * D14, task 2.10): for each preference and signal of the folds, the page
 * id it would have (`pref-<slug>`, `ret-<slug>`, the signal id) and the
 * vault-relative path that page would sit at. A leaf of the store read
 * side: it imports no brain module, so the reference resolver the privacy
 * judge uses can name store records without an import cycle. The page
 * views (`../../brain/memory-pages.ts`) build on it.
 */

import { posix } from "node:path";

import {
  BRAIN_ARCHIVED_SIGNALS_REL,
  BRAIN_INBOX_REL,
  BRAIN_PENDING_REL,
  BRAIN_PREFERENCES_REL,
  BRAIN_PROCESSED_REL,
  BRAIN_RETIRED_REL,
} from "../../brain/path-constants.ts";
import type { SignalLifecycle } from "../fold-signals.ts";
import { readSource, type ReadContext } from "./read-context.ts";
import { readEntitiesOf, type StoreEntities } from "./store-entities.ts";

const PAGE_EXT = ".md";
const PREFERENCE_PREFIX = "pref-";
const RETIRED_PREFIX = "ret-";
const RETIRED_STATUS = "retired";

/** The legacy folder each signal state's page lived in. */
export const SIGNAL_FOLDER: Readonly<Record<SignalLifecycle, string>> = Object.freeze({
  active: BRAIN_INBOX_REL,
  staged: BRAIN_PENDING_REL,
  consumed: BRAIN_PROCESSED_REL,
  archived: BRAIN_ARCHIVED_SIGNALS_REL,
  retired: BRAIN_RETIRED_REL,
  rejected: BRAIN_RETIRED_REL,
  expired: BRAIN_INBOX_REL,
});

function contextOf(vault: string | null, configPath: string | undefined): ReadContext {
  return { vault, ...(configPath !== undefined ? { configPath } : {}) };
}

/**
 * Whether a reader of `vault`'s memory records reads the store: true on a
 * store-only machine (switched, or with no legacy tree), false on an
 * unswitched one, where the reader keeps walking the legacy folders.
 */
export function memoryFromStore(vault: string | null, configPath?: string): boolean {
  return readSource(contextOf(vault, configPath)).kind === "store";
}

/**
 * Where `vault`'s memory records are read from: `legacy` (the folders),
 * `store` (a readable store), or `none` (a store-only machine with no
 * readable store, which reads as empty).
 */
export function memorySource(
  vault: string | null,
  configPath?: string,
): "legacy" | "store" | "none" {
  const source = readSource(contextOf(vault, configPath));
  if (source.kind === "legacy") return "legacy";
  return source.store === null ? "none" : "store";
}

/** The entities a store-only read of `context` sees, or `null` (legacy, or no store). */
export function memoryEntities(context: ReadContext): StoreEntities | null {
  const source = readSource(context);
  if (source.kind !== "store" || source.store === null) return null;
  return readEntitiesOf(source.store);
}

/** The page rel of a preference of the fold, by whether it is retired. */
export function preferencePageRel(slug: string, retired: boolean): string {
  const id = `${retired ? RETIRED_PREFIX : PREFERENCE_PREFIX}${slug}`;
  return posix.join(retired ? BRAIN_RETIRED_REL : BRAIN_PREFERENCES_REL, `${id}${PAGE_EXT}`);
}

/** The page rel of a signal in `state`. */
export function signalPageRel(id: string, state: SignalLifecycle): string {
  return posix.join(SIGNAL_FOLDER[state], `${id}${PAGE_EXT}`);
}

/**
 * The vault-relative path of the page the store record named by page id
 * `id` would have, or `null` when the folds hold no such record (or the
 * machine reads the legacy tree).
 */
export function storeMemoryRel(
  vault: string | null,
  id: string,
  configPath?: string,
): string | null {
  return memoryRelOf(memoryEntities(contextOf(vault, configPath)), id);
}

/**
 * {@link storeMemoryRel} over entities the caller already holds
 * ({@link memoryEntities}; `null` names nothing), for a caller that
 * resolves many ids in one operation.
 */
export function memoryRelOf(entities: StoreEntities | null, id: string): string | null {
  if (entities === null) return null;
  const signal = entities.signals.get(id);
  if (signal !== undefined) return signalPageRel(id, signal.state);
  const retiredAsked = id.startsWith(RETIRED_PREFIX);
  const slug = retiredAsked
    ? id.slice(RETIRED_PREFIX.length)
    : id.startsWith(PREFERENCE_PREFIX)
      ? id.slice(PREFERENCE_PREFIX.length)
      : null;
  if (slug === null) return null;
  const preference = entities.preferences.get(`${PREFERENCE_PREFIX}${slug}`);
  if (preference === undefined || !preference.state.exists) return null;
  const retired = preference.state.fields["status"] === RETIRED_STATUS;
  return retired === retiredAsked ? preferencePageRel(slug, retired) : null;
}
