/**
 * The memory pages a reader walks, on either side of the switch (design
 * D4, D14 items 5, 7 and 18, task 2.10).
 *
 * The dream pass, the briefs, the digests, the MCP readers and the
 * operator surfaces (doctor, status, health, hygiene, trust, lint and
 * graph readers) grew their own walks over `Brain/inbox/`,
 * `inbox/processed/`, `inbox/archived/`, `Brain/pending/`,
 * `Brain/preferences/` and `Brain/retired/`, each parsing the page files it
 * lists. On a store-only machine those folders are not written any more: a
 * signal is its `signal` and `signal-state` records, a preference its
 * `preference-set` records. This one module gives every such reader the
 * pages it would have listed, rebuilt from the folds:
 *
 *  - by folder: {@link storeMemoryPages} (`null` on an unswitched machine,
 *    so a reader keeps its own legacy walk byte for byte),
 *    {@link memoryFolderPages}, {@link memoryPageNamed},
 *    {@link storeMemoryPageAt}, {@link memoryPageExists},
 *    {@link storePagesIn} and {@link memoryRecordReads};
 *  - by record: {@link storeRecordPages} and {@link storeMemoryPage} (the
 *    parsed records, by the page parsers, are `memory-page-records.ts`,
 *    kept apart because the parsers belong to the writers);
 *  - {@link legacyMemoryPage} wraps a page file in the same shape, read
 *    lazily, so one loop can serve both sides.
 *
 * A rebuilt page carries the frontmatter its page would carry, typed as
 * the legacy parser types it, and the path it would have in the legacy
 * tree, so path-keyed bookkeeping is unchanged:
 *
 *  - a preference: the fold's fields (`preference-page-meta.ts`) with the
 *    body its `text` carries, or else the body its fields render
 *    (`## Origin`; once retired, the active-state fields dropped, the old
 *    id as an alias and the `## Retired` section);
 *  - a signal: its current frontmatter and the `## Raw` section of the
 *    text its `signal` record carries; a retired one with the retired tag
 *    and its id as an alias.
 *
 * The folder of each signal state is `SIGNAL_FOLDER` (`memory-ids.ts`).
 * The operational log as days is `log-days.ts`.
 */

import { legacyVaultOf } from "./no-vault.ts";
import { existsSync, readdirSync } from "node:fs";
import { basename, isAbsolute, join, posix, relative, sep } from "node:path";

import { isRecordRelPath } from "../record-path.ts";
import { signalRawShape } from "../store/dual-write-records.ts";
import type { StoreRecord } from "../store/envelope.ts";
import {
  LIVE_SIGNAL_STATES,
  SIGNAL_STATE_KIND,
  type SignalLifecycle,
} from "../store/fold-signals.ts";
import { parseHlc } from "../store/hlc.ts";
import { memoryEntities, memorySource, SIGNAL_FOLDER } from "../store/read/memory-ids.ts";
import type { ReadContext } from "../store/read/read-context.ts";
import type { StorePreference, StoreSignal } from "../store/read/store-entities.ts";
import type { FrontmatterMap } from "../types.ts";
import { formatFrontmatter, parseFrontmatter, parseFrontmatterText } from "../vault.ts";
import {
  BRAIN_ARCHIVED_SIGNALS_REL,
  BRAIN_INBOX_REL,
  BRAIN_PENDING_REL,
  BRAIN_PREFERENCES_REL,
  BRAIN_PROCESSED_REL,
  BRAIN_RETIRED_REL,
} from "./path-constants.ts";
import { storeEntryMeta } from "./preference-page-meta.ts";
import { preferencePageBody } from "./preference-body.ts";
import { CODEC_VERSION, expand } from "./portability/codec.ts";
import { textOfFields } from "./preference-store.ts";

export { memoryFromStore, memorySource } from "../store/read/memory-ids.ts";

/** A memory folder of the legacy tree. */
export type MemoryFolder =
  | "inbox"
  | "processed"
  | "archived"
  | "pending"
  | "preferences"
  | "retired";

/** One memory page: a file of the legacy tree, or the page the store's fold rebuilt. */
export interface MemoryPage {
  /** Basename, with the `.md` extension. */
  readonly name: string;
  /** Absolute path the page has, or would have, in the legacy tree. */
  readonly path: string;
  /** Vault-relative path, `/`-separated. */
  readonly rel: string;
  /** Whether the page was rebuilt from store records. */
  readonly stored: boolean;
  /** Whether the store holds the page as private (always `false` for a file; its frontmatter says). */
  readonly private: boolean;
  /** The frontmatter and the body. A file is read on the first call; a read error throws. */
  read(): readonly [FrontmatterMap, string];
}

/** The record kinds a rebuilt page stands for. */
export type MemoryPageKind = "preference" | "retired" | "signal";

/** A page rebuilt from the store's folds: everything is known up front. */
export interface StoreMemoryPage extends MemoryPage {
  readonly stored: true;
  readonly kind: MemoryPageKind;
  /** The basename without `.md`: `pref-<slug>`, `ret-<slug>` or the signal's page name. */
  readonly id: string;
  /** The signal's lifecycle state; `active` or `retired` for a preference. */
  readonly state: SignalLifecycle;
  /** The frontmatter as the legacy parser reads the page. */
  readonly meta: FrontmatterMap;
  readonly body: string;
  /** The whole page text: frontmatter and body. */
  readonly text: string;
  /**
   * When the record was last written (ms since the epoch, from the hybrid
   * clock), the store's twin of the page's mtime: a preference's latest
   * record, a signal's last record that rewrote its page (a page renamed
   * between inbox folders kept its mtime; a retired one was written anew).
   */
  readonly updatedMs: number;
}

/** Where to read: the machine config of the store root and device id. */
export interface MemoryPagesContext {
  readonly configPath?: string;
}

/** Every memory folder. */
export const MEMORY_FOLDERS: ReadonlyArray<MemoryFolder> = Object.freeze([
  "inbox",
  "processed",
  "archived",
  "pending",
  "preferences",
  "retired",
]);

const FOLDER_REL: Readonly<Record<MemoryFolder, string>> = Object.freeze({
  inbox: BRAIN_INBOX_REL,
  processed: BRAIN_PROCESSED_REL,
  archived: BRAIN_ARCHIVED_SIGNALS_REL,
  pending: BRAIN_PENDING_REL,
  preferences: BRAIN_PREFERENCES_REL,
  retired: BRAIN_RETIRED_REL,
});

/**
 * The states of a signal whose page sat in one of the three inbox folders
 * (inbox, `processed/`, `archived/`), for readers that walked those.
 */
export const INBOX_FOLDER_STATES: ReadonlySet<SignalLifecycle> = new Set([
  "active",
  "consumed",
  "archived",
  "expired",
]);

/** The states of a signal with a page outside `Brain/pending/`: every state but staged. */
export const UNSTAGED_STATES: ReadonlySet<SignalLifecycle> = new Set([
  ...INBOX_FOLDER_STATES,
  "retired",
  "rejected",
]);

const PAGE_EXT = ".md";
const PREFERENCE_PREFIX = "pref-";
const RETIRED_PREFIX = "ret-";
const RAW_HEADING = "## Raw";

/** The vault-relative folder of `folder`, `/`-separated. */
export function memoryFolderRel(folder: MemoryFolder): string {
  return FOLDER_REL[folder];
}

/** A page file, read lazily, in the shape of a rebuilt page. */
export function legacyMemoryPage(vault: string, folder: MemoryFolder, name: string): MemoryPage {
  const rel = posix.join(FOLDER_REL[folder], name);
  const path = join(vault, ...rel.split("/"));
  let read: readonly [FrontmatterMap, string] | undefined;
  return {
    name,
    path,
    rel,
    stored: false,
    private: false,
    read: () => (read ??= parseFrontmatter(path)),
  };
}

// ----- Rebuilding pages from the folds ---------------------------------------

function pathOf(vault: string | null, rel: string): string {
  return vault === null ? rel : join(vault, ...rel.split("/"));
}

function physicalMs(records: ReadonlyArray<StoreRecord>): number {
  let latest = 0;
  for (const record of records) {
    const clock = parseHlc(record.hlc);
    if (clock !== null && clock.physical > latest) latest = clock.physical;
  }
  return latest;
}

/** `aliases` with `id` first, as a retire adds the old id to the page it moves. */
function withAlias(meta: Record<string, unknown>, id: string): Record<string, unknown> {
  const existing = Array.isArray(meta["aliases"]) ? (meta["aliases"] as unknown[]) : [];
  return existing.includes(id) ? meta : { ...meta, aliases: [id, ...existing] };
}

/**
 * A retired preference as its page carries it: the retire mover drops the
 * active-state fields and names the old id as an alias (page identity,
 * which no record holds).
 */
function retiredPageMeta(meta: FrontmatterMap, id: string): FrontmatterMap {
  const {
    unconfirmed_until: _until,
    confirmed_at: _confirmed,
    _confirmed_at: _confirmedDerived,
    ...rest
  } = meta as Record<string, unknown>;
  return withAlias(rest, id) as FrontmatterMap;
}

/** A retired signal as its page carries it: the retired tag and the old id as an alias. */
function retiredSignalMeta(meta: Record<string, unknown>, id: string): FrontmatterMap {
  const tags = Array.isArray(meta["tags"])
    ? (meta["tags"] as unknown[]).map((t) => (t === "brain/signal" ? "brain/retired" : t))
    : meta["tags"];
  return withAlias({ ...meta, ...(tags !== undefined ? { tags } : {}) }, id) as FrontmatterMap;
}

function rebuilt(
  vault: string | null,
  rel: string,
  fields: Omit<StoreMemoryPage, "name" | "path" | "rel" | "stored" | "read" | "text" | "meta">,
  rawMeta: FrontmatterMap,
): StoreMemoryPage {
  // Through the page writer and parser once, so values carry the types the
  // legacy parser gives a page.
  const text = formatFrontmatter(rawMeta, fields.body);
  const page = parseFrontmatterText(text);
  return {
    ...fields,
    name: posix.basename(rel),
    path: pathOf(vault, rel),
    rel,
    stored: true,
    meta: page[0],
    text,
    read: () => page,
  };
}

function preferencePage(vault: string | null, id: string, entry: StorePreference): StoreMemoryPage {
  const slug = id.slice(PREFERENCE_PREFIX.length);
  const { meta: folded, retired } = storeEntryMeta(entry, slug);
  const meta = retired ? retiredPageMeta(folded, id) : folded;
  const pageId = `${retired ? RETIRED_PREFIX : PREFERENCE_PREFIX}${slug}`;
  const folder: MemoryFolder = retired ? "retired" : "preferences";
  return rebuilt(
    vault,
    posix.join(FOLDER_REL[folder], `${pageId}${PAGE_EXT}`),
    {
      kind: retired ? "retired" : "preference",
      id: pageId,
      state: retired ? "retired" : "active",
      body: preferencePageBody(meta, textOfFields(entry.state.fields), retired),
      private: entry.private,
      updatedMs: physicalMs(entry.state.history),
    },
    meta,
  );
}

/**
 * The bare raw text of a signal record. A record `writeSignal` wrote
 * carries the bare text; one the migration imported carries the legacy
 * page body: the `## Raw` heading included, still compressed when the page
 * had a `_raw_codec` (review finding F428). Both read as the bare,
 * expanded text, so the rebuilt page holds one heading over readable text.
 */
function signalRawText(
  raw: unknown,
  codec: unknown,
  shape: ReturnType<typeof signalRawShape>,
): string | null {
  if (typeof raw !== "string" || raw === "") return null;
  if (shape === "bare") return raw;
  const heading = /^\s*## Raw[ \t]*\n/.exec(raw);
  if (heading === null) return raw;
  const text = raw.slice(heading[0].length).trim();
  if (text === "") return null;
  return codec === CODEC_VERSION ? expand(text) : text;
}

function signalPage(vault: string | null, id: string, signal: StoreSignal): StoreMemoryPage {
  const { _raw_codec: codec, ...folded } = signal.frontmatter;
  const meta = signal.state === "retired" ? retiredSignalMeta(folded, id) : folded;
  const raw = signalRawText(signal.record.body["raw"], codec, signalRawShape(signal.record.body));
  const recorded = signal.record.body["path"];
  // The recorded path names the page only when it is a record path: a
  // synced peer can write any (FORMAT.md, Trust), and a Windows-style one
  // would keep its backslashes through the POSIX basename.
  const name =
    isRecordRelPath(recorded) && recorded.endsWith(PAGE_EXT)
      ? basename(recorded)
      : `${id}${PAGE_EXT}`;
  return rebuilt(
    vault,
    posix.join(SIGNAL_FOLDER[signal.state], name),
    {
      kind: "signal",
      id: name.slice(0, -PAGE_EXT.length),
      state: signal.state,
      body: raw !== null ? `${RAW_HEADING}\n\n${raw}\n` : "",
      private: signal.private,
      updatedMs: physicalMs(signal.history.filter(rewritesSignalPage)),
    },
    meta as FrontmatterMap,
  );
}

/** Signal states whose legacy move is a rename: the page keeps its mtime. */
const RENAMED_STATES: ReadonlySet<unknown> = new Set(["consumed", "archived"]);

/**
 * Whether a record of a signal rewrote its legacy page (so moved its
 * mtime): the capture, a field patch, and a move that writes the page anew
 * (a retire, a reject, an approval). A consume or an archive is a rename
 * and keeps the page's mtime.
 */
function rewritesSignalPage(record: StoreRecord): boolean {
  if (record.kind !== SIGNAL_STATE_KIND) return true;
  return record.body["fields"] !== undefined || !RENAMED_STATES.has(record.body["state"]);
}

/** Options of {@link storeRecordPages}. */
export interface StoreRecordPagesOptions extends ReadContext {
  /** Kinds to return (default: all three). */
  readonly kinds?: ReadonlySet<MemoryPageKind>;
  /** Signal states to return (default: active and staged; `"all"` for every state). */
  readonly signalStates?: ReadonlySet<SignalLifecycle> | "all";
}

function byRel(a: MemoryPage, b: MemoryPage): number {
  return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0;
}

/**
 * Every memory record of one fold as its page, sorted by path, rebuilt
 * once per fold: the fold cache (`readEntitiesOf`) hands back the same
 * entities object while the store is unchanged, so the rebuilt pages are
 * kept beside it and dropped with it. Rebuilding a page (the writer and
 * the parser once each) is the cost every folder walk, single lookup and
 * existence check used to pay for every record.
 */
const REBUILT_PAGES = new WeakMap<object, Map<string, ReadonlyArray<StoreMemoryPage>>>();

function rebuiltPages(
  vault: string | null,
  entities: NonNullable<ReturnType<typeof memoryEntities>>,
): ReadonlyArray<StoreMemoryPage> {
  let byVault = REBUILT_PAGES.get(entities);
  if (byVault === undefined) {
    byVault = new Map();
    REBUILT_PAGES.set(entities, byVault);
  }
  const key = vault ?? "\u0000no-vault";
  const known = byVault.get(key);
  if (known !== undefined) return known;
  const pages: StoreMemoryPage[] = [];
  for (const [id, entry] of entities.preferences) {
    if (!entry.state.exists || !id.startsWith(PREFERENCE_PREFIX)) continue;
    pages.push(preferencePage(vault, id, entry));
  }
  for (const [id, entry] of entities.signals) pages.push(signalPage(vault, id, entry));
  const sorted = Object.freeze(pages.toSorted(byRel));
  byVault.set(key, sorted);
  return sorted;
}

/**
 * A caller's own copy of a kept page: its frontmatter is cloned, so a
 * caller that edits the map it was handed cannot change the kept page.
 */
function ownCopy(page: StoreMemoryPage): StoreMemoryPage {
  const meta = structuredClone(page.meta);
  return {
    ...page,
    meta,
    read: () => {
      const [parsedMeta, parsedBody] = page.read();
      return [structuredClone(parsedMeta), parsedBody] as const;
    },
  };
}

/**
 * The memory records of the store as pages, sorted by path. Empty when
 * the machine reads the legacy tree or holds no readable store.
 */
export function storeRecordPages(
  vault: string | null,
  options: StoreRecordPagesOptions = {},
): StoreMemoryPage[] {
  return keptPages(vault, options).map(ownCopy);
}

/** The kept pages {@link storeRecordPages} selects, not yet copied, narrowed by `where`. */
function keptPages(
  vault: string | null,
  options: StoreRecordPagesOptions,
  where: (page: StoreMemoryPage) => boolean = () => true,
): StoreMemoryPage[] {
  const entities = memoryEntities({ ...options, vault });
  if (entities === null) return [];
  const states = options.signalStates ?? LIVE_SIGNAL_STATES;
  return rebuiltPages(vault, entities).filter(
    (page) =>
      (options.kinds === undefined || options.kinds.has(page.kind)) &&
      (page.kind !== "signal" || states === "all" || states.has(page.state)) &&
      where(page),
  );
}

/**
 * The store's record named by page id `id` (`pref-<slug>`, `ret-<slug>` or
 * a signal id, any state) as its page, or `undefined` when the folds hold
 * none or the machine reads the legacy tree.
 */
export function storeMemoryPage(
  vault: string | null,
  id: string,
  context: ReadContext = {},
): StoreMemoryPage | undefined {
  const [page] = keptPages(vault, { ...context, signalStates: "all" }, (p) => p.id === id);
  return page === undefined ? undefined : ownCopy(page);
}

// ----- By folder --------------------------------------------------------------

function contextOf(vault: string | null, context: MemoryPagesContext): ReadContext {
  return { vault, ...(context.configPath !== undefined ? { configPath: context.configPath } : {}) };
}

/**
 * The pages of `folder` rebuilt from the store on a store-only machine,
 * sorted by name; `null` on an unswitched machine, where the caller reads
 * the folder. A store-only machine with no readable store has no pages.
 */
export function storeMemoryPages(
  vault: string | null,
  folder: MemoryFolder,
  context: MemoryPagesContext = {},
): StoreMemoryPage[] | null {
  const source = memorySource(vault, context.configPath);
  if (source === "legacy") return null;
  if (source === "none") return [];
  const rel = FOLDER_REL[folder];
  return keptPages(
    vault,
    { ...contextOf(vault, context), signalStates: "all" },
    (page) => posix.dirname(page.rel) === rel,
  )
    .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(ownCopy);
}

/** Listing rules of {@link memoryFolderPages}'s legacy side. */
export interface MemoryFolderOptions extends MemoryPagesContext {
  /** Keep only regular files (`Dirent.isFile()`). */
  readonly regularFilesOnly?: boolean;
  /** Sort the legacy listing by name, as the store side always is. */
  readonly sorted?: boolean;
}

/**
 * Every entry of one memory folder as a page: on an unswitched machine
 * the folder's entries in `readdirSync` order (no extension filter; a
 * caller filters names as it did), nothing when the folder is absent; on
 * a store-only machine the rebuilt pages.
 */
export function memoryFolderPages(
  vault: string | null,
  folder: MemoryFolder,
  options: MemoryFolderOptions = {},
): MemoryPage[] {
  const stored = storeMemoryPages(vault, folder, options);
  if (stored !== null) return stored;
  const root = legacyVaultOf(vault, "memoryFolderPages");
  const dir = join(root, ...FOLDER_REL[folder].split("/"));
  if (!existsSync(dir)) return [];
  const pages = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => options.regularFilesOnly !== true || entry.isFile())
    .map((entry) => legacyMemoryPage(root, folder, entry.name));
  return options.sorted === true
    ? pages.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    : pages;
}

/**
 * The page `name` of one memory folder: the file when it exists on an
 * unswitched machine, the rebuilt page on a store-only one, else `null`.
 */
export function memoryPageNamed(
  vault: string | null,
  folder: MemoryFolder,
  name: string,
  context: MemoryPagesContext = {},
): MemoryPage | null {
  const stored = storeFolderPage(vault, folder, name, context);
  if (stored !== undefined) return stored;
  const page = legacyMemoryPage(legacyVaultOf(vault, "memoryPageNamed"), folder, name);
  return existsSync(page.path) ? page : null;
}

function memoryFolderOf(rel: string): MemoryFolder | undefined {
  const dir = posix.dirname(rel.replaceAll("\\", "/"));
  return MEMORY_FOLDERS.find((f) => FOLDER_REL[f] === dir);
}

/**
 * The page at vault-relative `rel` rebuilt from the store, when this is a
 * store-only machine and the store holds one there; `null` otherwise.
 * For path-keyed readers (the reach and owner filters) that are handed a
 * page path rather than a walk.
 */
export function storeMemoryPageAt(
  vault: string | null,
  rel: string,
  context: MemoryPagesContext = {},
): StoreMemoryPage | null {
  const folder = memoryFolderOf(rel);
  if (folder === undefined) return null;
  const name = posix.basename(rel.replaceAll("\\", "/"));
  return storeFolderPage(vault, folder, name, context) ?? null;
}

/**
 * The store's page `name` of `folder`: `undefined` on an unswitched
 * machine (the caller reads the file), `null` when the store holds none.
 * Only the page found is copied, so a lookup in a loop does not clone the
 * whole folder each time.
 */
function storeFolderPage(
  vault: string | null,
  folder: MemoryFolder,
  name: string,
  context: MemoryPagesContext,
): StoreMemoryPage | null | undefined {
  const source = memorySource(vault, context.configPath);
  if (source === "legacy") return undefined;
  if (source === "none") return null;
  const rel = FOLDER_REL[folder];
  const [page] = keptPages(
    vault,
    { ...contextOf(vault, context), signalStates: "all" },
    (p) => p.name === name && posix.dirname(p.rel) === rel,
  );
  return page === undefined ? null : ownCopy(page);
}

/**
 * The store's page that would sit at `Brain/preferences/<id>.md` or, else,
 * `Brain/retired/<id>.md`: the two folders a page lookup by id reads on an
 * unswitched machine (retired and rejected signals live in `retired/`
 * too). `null` when neither holds one, or on an unswitched machine.
 */
export function storePageInPreferenceFolders(
  vault: string | null,
  id: string,
  context: MemoryPagesContext = {},
): StoreMemoryPage | null {
  return (
    storeMemoryPageAt(vault, `${FOLDER_REL.preferences}/${id}${PAGE_EXT}`, context) ??
    storeMemoryPageAt(vault, `${FOLDER_REL.retired}/${id}${PAGE_EXT}`, context)
  );
}

/**
 * Whether the memory page at vault-relative `rel` exists: the file on an
 * unswitched machine, a page the store's folds rebuild on a store-only
 * one. A path outside the memory folders is asked of the filesystem.
 */
export function memoryPageExists(
  vault: string | null,
  rel: string,
  context: MemoryPagesContext = {},
): boolean {
  const switched =
    memoryFolderOf(rel) !== undefined && memorySource(vault, context.configPath) !== "legacy";
  if (switched) return storeMemoryPageAt(vault, rel, context) !== null;
  // No vault: only memory pages exist, and they live in the store.
  if (vault === null) return false;
  return existsSync(join(vault, rel));
}

function folderRelOf(vault: string | null, dir: string): string | null {
  const absolute = isAbsolute(dir);
  if (absolute && vault === null) return null;
  const rel = absolute ? relative(vault!, dir) : dir;
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/").replace(/\/+$/, "");
}

/**
 * The store's pages that would sit directly in the legacy folder `dir`
 * (absolute, under `vault`, or vault-relative): the twin of listing that
 * folder, for a reader that walked it. Signals of every state count, by
 * the folder their state's page lived in; a folder no memory page lived
 * in lists nothing. Sorted by path.
 */
export function storePagesIn(
  vault: string | null,
  dir: string,
  context: ReadContext = {},
): StoreMemoryPage[] {
  const rel = folderRelOf(vault, dir);
  if (rel === null) return [];
  return keptPages(
    vault,
    { ...context, signalStates: "all" },
    (page) => posix.dirname(page.rel) === rel,
  ).map(ownCopy);
}

/**
 * The `<prefix>*.md` records of the legacy folder `dir`, each with a read:
 * the regular files of `dir` on an unswitched machine (`fromStore` false;
 * a listing failure throws), the store's records whose page sat in `dir`
 * on a store-only one. A reader that walked a folder and parsed each file
 * swaps its loop to this and keeps its own per-record handling.
 */
export function memoryRecordReads<T>(
  vault: string | null,
  fromStore: boolean,
  dir: string,
  prefix: string,
  parseFile: (path: string) => T,
  parsePage: (page: StoreMemoryPage) => T,
): ReadonlyArray<{ readonly path: string; readonly read: () => T }> {
  if (fromStore) {
    return storePagesIn(vault, dir)
      .filter((page) => page.id.startsWith(prefix))
      .map((page) => ({ path: page.path, read: () => parsePage(page) }));
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(PAGE_EXT) && e.name.startsWith(prefix))
    .map((e) => {
      const path = join(dir, e.name);
      return { path, read: () => parseFile(path) };
    });
}

/** The raw text a signal page carries under its `## Raw` heading, or `null`. */
export function signalPageRaw(page: { readonly body: string }): string | null {
  const start = page.body.indexOf(`${RAW_HEADING}\n`);
  if (start === -1) return null;
  const text = page.body.slice(start + RAW_HEADING.length).trim();
  return text === "" ? null : text;
}
