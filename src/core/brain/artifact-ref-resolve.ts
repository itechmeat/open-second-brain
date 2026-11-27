/**
 * Resolve a reference a report row or a log event carries to the
 * vault-relative path of the page it names, or `null` when it names none
 * on disk and, on a machine whose lane pages live in the store, no lane
 * entry the store holds.
 *
 * Extracted from `./artifact-ref-view.ts` so a writer below the search
 * layer can resolve references the same way: the brain store's partition
 * rule for log events (`store/reference-privacy.ts`) is reached from the
 * log appender, and the view module imports a search type the log must
 * not depend on. This module imports nothing above `brain/paths.ts`.
 */

import { isAbsolute, join } from "node:path";
import { existsSync, statSync } from "node:fs";

import { pathIsInside, posixRel, vaultRelative } from "../path-safety.ts";
import type { FrontmatterMap } from "../types.ts";
import {
  laneFoldIncomplete,
  type LaneFolded,
  wholeLaneStoreFold,
} from "../store/lane-fold-cache.ts";
import { brainRelOfEntry, lanePlaceOf } from "../store/lane-paths.ts";
import { LANE_ENTRY_ID_MAX, laneEntryKey } from "../store/lane-records.ts";
import { memoryEntities, memoryFromStore, memoryRelOf } from "../store/read/memory-ids.ts";
import type { StoreEntities } from "../store/read/store-entities.ts";
import { storeOnlyMode } from "../store/store-only.ts";
import { BRAIN_ROOT_REL } from "./path-constants.ts";
import { BRAIN_DECISIONS_REL, BRAIN_SOURCES_REL, type BrainDirs, brainDirs } from "./paths.ts";
import { ANCHORED_WIKILINK_RE, stripWikilinkDecoration } from "./wikilink.ts";

/**
 * What resolving a bare id needs to know about the vault: whether its
 * memory records are read from the store (`memoryFromStore`), its Brain
 * folders (`brainDirs`) and, on a store-only machine, the store's memory
 * entities. Each reads the disk (the machine's switch state, a realpath
 * per folder, the store's shard fingerprints), so a caller that resolves many
 * references in one operation shares one scope, whose answers are worked
 * out on first use and then kept: paying them for every string of every
 * row made a batch append cost milliseconds per record.
 */
export interface ArtifactRefScope {
  readonly fromStore: () => boolean;
  readonly dirs: () => BrainDirs;
  /** The store's memory entities (`memoryEntities`), read on a store-only machine only. */
  readonly entities: () => StoreEntities | null;
  /** The store's lane entries, on a machine whose lane pages live in the store; else `null`. */
  readonly lanes: () => StoreLanes | null;
  /**
   * Whether the question that answers {@link lanes} failed (whether the
   * lane pages live in the store could not be told): {@link lanes} then
   * answers `null`, as for a machine whose lane pages are files, and
   * {@link laneRefMatch} answers `unknown` for a lane-shaped reference.
   */
  readonly lanesUnknown: () => boolean;
}

/**
 * What the store holds of the lane entries, read from the fold of every
 * partition whatever the caller's reach: a reference must be found to be
 * judged, and a miss reads as "names nothing", which is visible (design D6).
 */
export interface StoreLanes {
  /** Whether the fold holds a lane entry at the vault-relative POSIX path `rel`. */
  readonly holds: (rel: string) => boolean;
  /**
   * The vault-relative POSIX path of the lane entry whose id is `id`, in
   * any lane the fold holds ({@link laneIdIndex}).
   */
  readonly byId: (id: string) => string | null;
  /** The one resolution of a vault-relative reference ({@link laneRefMatch}). */
  readonly match: (bare: string) => LaneRefMatch;
}

/**
 * What a reference names among the store-held lane entries, by the one
 * resolution both reference views and both write-side judges use
 * ({@link laneRefMatch}): an entry (its page path, its fields and whether
 * it is private: held in `private`, or any entry while the fold of every
 * partition may miss a record), `unknown` when the store cannot say
 * (that fold may miss a record and the reference could name a lane entry
 * it does not show, or the question failed), or `none`.
 */
export type LaneRefMatch =
  | {
      readonly kind: "entry";
      readonly rel: string;
      readonly meta: FrontmatterMap;
      readonly private: boolean;
    }
  | { readonly kind: "unknown" }
  | { readonly kind: "none" };

const NO_LANE_REF: LaneRefMatch = Object.freeze({ kind: "none" });
const UNKNOWN_LANE_REF: LaneRefMatch = Object.freeze({ kind: "unknown" });

/** The longest lane folder name (a lane name, `LEDGER_NAME_RE`). */
const LANE_FOLDER_MAX = 64;

/**
 * Whether the vault-relative reference `bare` could name a lane entry,
 * judged before any fold read (design R15): one non-blank line that is a
 * bare id no longer than any lane id (an inner space included, design R3)
 * or a `Brain/` path no longer than any lane entry's page path.
 */
function laneShaped(bare: string): boolean {
  if (bare.trim() === "" || /[\r\n]/.test(bare)) return false;
  if (!bare.includes("/")) return !bare.includes("\\") && bare.length <= LANE_ENTRY_ID_MAX;
  return (
    bare.startsWith(BRAIN_PREFIX) &&
    bare.length <=
      BRAIN_PREFIX.length + LANE_FOLDER_MAX + 1 + LANE_ENTRY_ID_MAX + MARKDOWN_EXT.length
  );
}

/**
 * `bare` brought to the one spelling of an in-vault lane path: a
 * `Brain/` path with redundant separators (`Brain//decisions/<id>.md`)
 * or a trailing slash names the entry its canonical spelling does, so
 * the lookup and both privacy checks judge the same reference. A path
 * that is not a lane path, or that climbs (`.` or `..`), is returned
 * with its separators collapsed for the checks to refuse.
 */
function canonicalLaneSpelling(bare: string): string {
  if (!bare.startsWith(BRAIN_PREFIX)) return bare;
  return bare.replace(/\/+/g, "/").replace(/\/$/, "");
}

/**
 * Resolve the vault-relative reference `bare` in `fold`: a bare id in any
 * lane ({@link laneIdIndex}); a `Brain/` path as written (whatever its
 * extension), then its `.md` twin. See {@link LaneRefMatch}.
 */
function matchInFold(fold: LaneFolded, bare: string): LaneRefMatch {
  const incomplete = laneFoldIncomplete(fold);
  const entryAt = (rel: string): LaneRefMatch | null => {
    const place = lanePlaceOf(rel.slice(BRAIN_PREFIX.length));
    if (place === null) return null;
    const key = laneEntryKey(place.lane, place.entry);
    const value = fold.entries.get(key);
    if (value === undefined) return incomplete ? UNKNOWN_LANE_REF : NO_LANE_REF;
    return {
      kind: "entry",
      rel,
      meta: value.fields as FrontmatterMap,
      private: incomplete || fold.privateKeys.has(key),
    };
  };
  if (!bare.includes("/")) {
    const rel = laneIdIndex(fold).get(bare);
    if (rel !== undefined) return entryAt(rel) ?? NO_LANE_REF;
    return incomplete && laneShaped(bare) ? UNKNOWN_LANE_REF : NO_LANE_REF;
  }
  const segments = bare.split("/");
  if (!bare.startsWith(BRAIN_PREFIX) || segments.some((s) => s === "" || s === "." || s === "..")) {
    return NO_LANE_REF;
  }
  const exact = entryAt(bare);
  if (exact?.kind === "entry" || bare.endsWith(MARKDOWN_EXT)) return exact ?? NO_LANE_REF;
  const twin = entryAt(bare + MARKDOWN_EXT);
  if (twin?.kind === "entry") return twin;
  return exact?.kind === "unknown" || twin?.kind === "unknown" ? UNKNOWN_LANE_REF : NO_LANE_REF;
}

/**
 * The one resolution of a reference to a store-held lane entry, for both
 * reference views and both write-side judges, with a vault or without
 * one (`vault` is then the lane root a store-only machine uses): the
 * reference is unbracketed, its alias and anchor dropped, an absolute
 * path made vault-relative, then resolved by {@link matchInFold} against
 * the fold of every partition of the store `scope` was made for. `none`
 * for a string that cannot name a lane entry (judged before any fold
 * read, design R15) and on a machine whose lane pages are files;
 * `unknown` when the question fails, the question whether the lane pages
 * live in the store included (design R3). A caller treats `unknown` as
 * private (fail closed).
 */
export function laneRefMatch(
  vault: string,
  ref: string,
  scope: ArtifactRefScope = artifactRefScope(vault),
): LaneRefMatch {
  try {
    const spelled = posixRel(unbracket(ref));
    if (spelled.length === 0) return NO_LANE_REF;
    const bare = isAbsolute(spelled) ? vaultRelative(spelled, vault) : spelled;
    if (bare.length === 0 || isAbsolute(bare)) return NO_LANE_REF;
    const canonical = canonicalLaneSpelling(bare);
    if (!laneShaped(canonical)) return NO_LANE_REF;
    const lanes = scope.lanes();
    if (lanes === null) return scope.lanesUnknown() ? UNKNOWN_LANE_REF : NO_LANE_REF;
    return lanes.match(canonical);
  } catch {
    return UNKNOWN_LANE_REF;
  }
}

/**
 * The fold of every partition each configuration names, read once for
 * the reference being judged ({@link withReferenceFold}); `null` outside
 * such a judgement.
 */
let referenceFolds: Map<string | undefined, LaneFolded> | null = null;

/**
 * Run `judge`, the judgement of one reference, reading the fold of every
 * partition at most once (design R15): the lane match, the bare-id
 * resolution and a lane entry's own record all read the fold this
 * judgement read first. A later judgement reads the fold again, so a
 * write between two references is seen.
 */
export function withReferenceFold<T>(judge: () => T): T {
  if (referenceFolds !== null) return judge();
  referenceFolds = new Map();
  try {
    return judge();
  } finally {
    referenceFolds = null;
  }
}

/** The fold of every partition, the one the reference being judged read when there is one. */
function laneFoldOf(configPath?: string): LaneFolded {
  if (referenceFolds === null) return wholeLaneStoreFold(configPath);
  let fold = referenceFolds.get(configPath);
  if (fold === undefined) {
    fold = wholeLaneStoreFold(configPath);
    referenceFolds.set(configPath, fold);
  }
  return fold;
}

/** The extensions a lane entry's page name drops to give its id. */
const ID_EXTENSIONS: ReadonlyArray<string> = [".md", ".json"];

/** Rank of the lanes a bare id was resolved in before every lane was. */
const LANE_RANK: Readonly<Record<string, number>> = { sources: 0, decisions: 1, entities: 2 };

/** The id index of each fold object (a fold is rebuilt when the store changes). */
const idIndexes = new WeakMap<LaneFolded, ReadonlyMap<string, string>>();

/**
 * Every lane entry of `fold` by its bare id (design D12 item 3): the last
 * segment of its page path (`brainRelOfEntry`, the lane map) with `.md` or
 * `.json` dropped, in every lane the fold holds. Of several entries with
 * one id the one in `private` is kept (fail closed), then the sources,
 * decisions and entities lanes, then the first path.
 */
function laneIdIndex(fold: LaneFolded): ReadonlyMap<string, string> {
  const known = idIndexes.get(fold);
  if (known !== undefined) return known;
  const ranked = new Map<string, { readonly rel: string; readonly rank: readonly number[] }>();
  for (const [key, value] of fold.entries) {
    const rel = brainRelOfEntry(value.lane, value.entry);
    const name = rel.slice(rel.lastIndexOf("/") + 1);
    const ext = ID_EXTENSIONS.find((e) => name.endsWith(e) && name.length > e.length);
    if (ext === undefined) continue;
    const id = name.slice(0, -ext.length);
    const rank = [fold.privateKeys.has(key) ? 0 : 1, LANE_RANK[value.lane] ?? 3];
    const held = ranked.get(id);
    // Both sides of the last tie-break are canonical `Brain/` paths, so
    // the pick does not depend on the order the fold lists its entries.
    const canonical = `${BRAIN_ROOT_REL}/${rel}`;
    const better =
      held === undefined ||
      rank[0]! < held.rank[0]! ||
      (rank[0] === held.rank[0] &&
        (rank[1]! < held.rank[1]! || (rank[1] === held.rank[1] && canonical < held.rel)));
    if (better) ranked.set(id, { rel: canonical, rank });
  }
  const index = new Map([...ranked].map(([id, held]) => [id, held.rel]));
  idIndexes.set(fold, index);
  return index;
}

/** The {@link StoreLanes} of `vault`, or `null` when its lane pages are files or that cannot be told. */
function storeLanesOf(vault: string, configPath?: string): StoreLanes | null {
  try {
    return storeLanesAsked(vault, configPath);
  } catch {
    return null;
  }
}

/**
 * The {@link StoreLanes} of `vault`, or `null` when its lane pages are
 * files; throws when the question whether they live in the store fails.
 */
function storeLanesAsked(vault: string, configPath?: string): StoreLanes | null {
  if (!storeOnlyMode({ vault, ...(configPath !== undefined ? { configPath } : {}) }).storeOnly) {
    return null;
  }
  const prefix = `${BRAIN_ROOT_REL}/`;
  // A fold that may miss a record is cached nowhere else (it is rebuilt
  // from every shard on each read), so the scope keeps the first one it
  // reads: every verdict over it fails closed, so a later change cannot
  // make one of them less private. A complete fold is asked again each
  // time, so a lane write the scope outlives is seen.
  let degraded: LaneFolded | undefined;
  const whole = (): LaneFolded => {
    if (degraded !== undefined) return degraded;
    const fold = laneFoldOf(configPath);
    if (laneFoldIncomplete(fold)) degraded = fold;
    return fold;
  };
  return {
    holds: (rel) => {
      const place = rel.startsWith(prefix) ? lanePlaceOf(rel.slice(prefix.length)) : null;
      if (place === null) return false;
      return whole().entries.has(laneEntryKey(place.lane, place.entry));
    },
    // A bare id (no separator) resolves by the match of the id index, so
    // the view's later `laneRefMatch` of the same string reads its memo.
    byId: (id) => {
      const match = matchOf(whole(), id);
      return match.kind === "entry" ? match.rel : null;
    },
    match: (bare) => matchOf(whole(), bare),
  };
}

/** The matches of each fold object, so a second lookup of one reference reads no index. */
const matches = new WeakMap<LaneFolded, Map<string, LaneRefMatch>>();

/** {@link matchInFold}, remembered per fold object (a fold is rebuilt when the store changes). */
function matchOf(fold: LaneFolded, bare: string): LaneRefMatch {
  let known = matches.get(fold);
  if (known === undefined) {
    known = new Map();
    matches.set(fold, known);
  }
  let match = known.get(bare);
  if (match === undefined) {
    match = matchInFold(fold, bare);
    // Bounded: a long-lived fold of an unchanged store meets many strings.
    if (known.size >= MATCH_MEMO_MAX) known.clear();
    known.set(bare, match);
  }
  return match;
}

/** The most references one fold remembers matches for. */
const MATCH_MEMO_MAX = 4096;

const BRAIN_PREFIX = `${BRAIN_ROOT_REL}/`;

/**
 * The page path of the store-held lane entry a reference names: a bare id
 * in any lane the store holds ({@link laneIdIndex}), an
 * extensionless `Brain/` path by its `.md` twin, or a `Brain/` page path
 * as written; `null` when the fold of every partition holds no such entry
 * or the lane pages of `vault` are files. The store half of
 * {@link resolveArtifactRef}, for a machine with no vault to probe.
 */
export function resolveStoreLaneRef(
  vault: string,
  ref: string,
  scope: ArtifactRefScope = artifactRefScope(vault),
): string | null {
  const match = laneRefMatch(vault, ref, scope);
  return match.kind === "entry" ? match.rel : null;
}

/**
 * The page path of the store-held lane entry named by the bare id `id`, or
 * `null`: an id that cannot name a lane entry reads no fold (design R15).
 */
function laneIdPath(lanes: StoreLanes, id: string): string | null {
  return laneShaped(id) ? lanes.byId(id) : null;
}

/** A lane entry the store holds, as a reference judge reads it (design D6, D7). */
export interface StoreLaneEntry {
  /** The vault-relative POSIX path of its page. */
  readonly rel: string;
  /** Its fields, as a page's frontmatter. */
  readonly meta: FrontmatterMap;
  /**
   * Whether it lives in `private`, by the rule of `laneEntryInPrivate` for
   * a held lane path: true while the fold may miss a record (fail closed).
   */
  readonly private: boolean;
  /**
   * Set when the store holds no live entry there and the winning record of
   * its key is a removal held in `private`: the path is private below
   * local reach, and it has no fields for any other rule to read.
   */
  readonly removed?: true;
}

/**
 * The store-held lane entry at the vault-relative POSIX path `rel`, read
 * from the fold of every partition, or `null` when the store holds none
 * there or the lane pages of `vault` are files. A path whose entry was
 * removed by a record held in `private` answers as a private entry with
 * no fields (`removed`): the entry was private when it went, so a file
 * left at its path does not answer for it below local reach.
 */
export function storeLaneEntryAt(
  vault: string,
  rel: string,
  configPath?: string,
): StoreLaneEntry | null {
  const prefix = `${BRAIN_ROOT_REL}/`;
  // Canonicalized before it is split (F1): a doubled separator or a
  // trailing slash names the entry its canonical spelling does.
  const canonical = canonicalLaneSpelling(rel);
  const segments = canonical.split("/");
  if (!canonical.startsWith(prefix) || segments.some((s) => s === "" || s === "." || s === "..")) {
    return null;
  }
  const place = lanePlaceOf(canonical.slice(prefix.length));
  if (place === null) return null;
  // The rule of `laneEntryInPrivate`, read from one fold here: that module
  // reaches this one through the write-side judge, so it is not imported.
  // While the fold may miss a record, a lane path names an entry that may
  // be private whether or not the fold shows it, and a failed question
  // answers the same (fail closed).
  try {
    if (storeLanesOf(vault, configPath) === null) return null;
    const fold = laneFoldOf(configPath);
    if (laneFoldIncomplete(fold)) return { rel: canonical, meta: {}, private: true };
    const key = laneEntryKey(place.lane, place.entry);
    const value = fold.entries.get(key);
    if (value === undefined) {
      return fold.privateRemovals.has(key)
        ? { rel: canonical, meta: {}, private: true, removed: true }
        : null;
    }
    return {
      rel: canonical,
      meta: value.fields as FrontmatterMap,
      private: fold.privateKeys.has(key),
    };
  } catch {
    return { rel: canonical, meta: {}, private: true };
  }
}

/** A scope for `vault` that works each answer out once, on first use. */
export function artifactRefScope(
  vault: string,
  fromStore?: boolean,
  configPath?: string,
): ArtifactRefScope {
  let store = fromStore;
  let dirs: BrainDirs | undefined;
  let entities: { readonly value: StoreEntities | null } | undefined;
  let lanes: { readonly value: StoreLanes | null; readonly unknown: boolean } | undefined;
  const asked = (): { readonly value: StoreLanes | null; readonly unknown: boolean } => {
    try {
      return { value: storeLanesAsked(vault, configPath), unknown: false };
    } catch {
      return { value: null, unknown: true };
    }
  };
  return {
    fromStore: () => (store ??= memoryFromStore(vault, configPath)),
    dirs: () => (dirs ??= brainDirs(vault)),
    entities: () =>
      (entities ??= {
        value: memoryEntities({ vault, ...(configPath !== undefined ? { configPath } : {}) }),
      }).value,
    lanes: () => (lanes ??= asked()).value,
    lanesUnknown: () => (lanes ??= asked()).unknown,
  };
}

/** The `.md` extension every Brain artifact id resolves through. */
const MARKDOWN_EXT = ".md";

/**
 * Strip the wikilink brackets a report row may have kept around its
 * reference, leaving the target verbatim.
 *
 * The brackets are SYNTAX, not part of the reference: a retirement's
 * `retired_by`, a dream transition's `link` and an evidence row's
 * `artifact` all carry `[[…]]` straight out of frontmatter or a log
 * body, and `[[Brain/preferences/pref-x.md]]` names exactly the page
 * `Brain/preferences/pref-x.md`. Before this, such a reference matched
 * neither branch below and the row failed OPEN.
 *
 * Deliberately NOT `parseWikilinkRich`: that normaliser collapses folder
 * segments and drops `.md`, which turns a path-shaped link into a bare
 * basename that resolves to no artifact - the same fail-open by a longer
 * route.
 *
 * The alias and anchor DO come off, through the decoration-only half of
 * that normaliser. Leaving them on was a fail-open with a comment on it:
 * `pref-x|alias`, `pref-x#Raw` and
 * `Brain/preferences/pref-x.md|the rule` end in neither `.md` nor an id
 * any directory holds, so they resolved to nothing and their rows passed
 * unconditionally - and these are not hypothetical spellings, they are
 * what `brain_apply_evidence` documents for its own `artifact` argument.
 * Cutting decoration can only ever SHORTEN the target, so a reference
 * that resolved before still resolves and one that did not may now.
 */
function unbracket(ref: string): string {
  const match = ANCHORED_WIKILINK_RE.exec(ref.trim());
  return stripWikilinkDecoration(match === null ? ref : match[1]!);
}

/**
 * Resolve a bare Brain artifact id to its vault-relative path, or `null`
 * when no artifact of that id is on disk.
 *
 * ## Why the directory list is the whole boundary
 *
 * `visible()` reads an id that resolves to no file as "this row names
 * nothing that could be hidden" and lets the row through. That reading is
 * true only for ids this function would have FOUND had the artifact
 * existed - so every directory omitted here is a directory whose pages
 * are silently unclassifiable, and every binding's fail-closed promise
 * turns into a fail-open one for exactly those pages. The list is
 * therefore every `Brain/` directory holding id-addressable Markdown:
 *
 *   - `preferences` / `retired` carry `owner:` through the preference
 *     writer, and carry `visibility:` wherever an operator wrote one;
 *   - `inbox` / `processed` / `pending` carry whatever an operator or an
 *     importer wrote into a signal's frontmatter;
 *   - `sources` (`src-<slug>.md`) and `entities` are taggable the same
 *     way, and `brain_search_by_source` already filters the first of them
 *     on the search side - so an id-shaped reference to one reaching a
 *     view here and passing was the two halves disagreeing;
 *   - `decisions` (`decision-<slug>.md`) is named by id in the
 *     decision-change receipts (`[[decision-<slug>]]`).
 *
 * `log` is deliberately absent - a log shard is named by date, is shared
 * by construction, and carries no per-page claim to read. `bases` holds
 * `.base` view definitions rather than Markdown pages, and `snapshots`
 * holds dated copies addressed by path rather than by id.
 */
function artifactPath(
  vault: string,
  id: string,
  scope: ArtifactRefScope,
  laneMatch?: LaneRefMatch,
): string | null {
  const dirs = scope.dirs();
  const fromStore = scope.fromStore();
  // Store-only (task 2.10): a preference or a signal is a record of the
  // folds, not a file, and still names the page it would be, so the id
  // keeps naming something the view must judge rather than nothing.
  if (fromStore) {
    const rel = memoryRelOf(scope.entities(), id);
    if (rel !== null) return rel;
  }
  const memoryDirs = fromStore
    ? []
    : [dirs.preferences, dirs.retired, dirs.inbox, dirs.processed, dirs.archived, dirs.pending];
  for (const dir of [
    ...memoryDirs,
    join(vault, BRAIN_SOURCES_REL),
    dirs.entities,
    join(vault, BRAIN_DECISIONS_REL),
  ]) {
    const abs = join(dir, `${id}${MARKDOWN_EXT}`);
    // The visibility predicate speaks vault-relative POSIX paths - the
    // form a path-shaped reference already carries. Handing it the native
    // `Brain\preferences\...` spelling on Windows would match no rule and
    // let a hidden artifact through, the fail-open this view exists to
    // prevent. Slicing the vault's length off `abs` has the same failure
    // for a vault spelled `/v/` or `/v/x/..` (`join` normalizes `abs`, not
    // `vault`), so the path is taken relative to the resolved vault.
    if (existsSync(abs)) return vaultRelative(abs, vault);
  }
  // A machine whose lane pages live in the store holds these as lane
  // entries, not files (design D6 item 1). A lane match the caller already
  // made for this reference is used as it is (design R15).
  if (laneMatch !== undefined) return laneMatch.kind === "entry" ? laneMatch.rel : null;
  const lanes = scope.lanes();
  return lanes === null ? null : laneIdPath(lanes, id);
}

/**
 * The candidate an extensionless vault-page reference denotes: the bare
 * spelling when that file exists, else its `.md` twin when the twin
 * exists - the same first-existing rule the claim ledger's write side
 * applies to an extensionless source, so the read-side gate cannot drift
 * from the spelling the writer used. When neither file exists the
 * reference names nothing here (`null` reads as visible): a convention
 * like `Notes/<slug>-applied` in a log payload is not a page, and
 * judging it as a missing `.md` page would drop every row carrying it.
 * Both candidates are probed only inside the vault, so a
 * traversal-shaped reference never reaches the filesystem outside it.
 */
function pageCandidate(vault: string, bare: string, scope: ArtifactRefScope): string | null {
  if (isVaultFile(vault, bare)) return bare;
  // A store-held lane entry is no file: the path as written names it when
  // the store holds one there (a `.json` session file, for one), before
  // any `.md` twin is tried.
  if (bare.startsWith(`${BRAIN_ROOT_REL}/`) && scope.lanes()?.holds(bare) === true) return bare;
  const twin = bare + MARKDOWN_EXT;
  if (isVaultFile(vault, twin)) return twin;
  // A store-held lane entry is no file: its `.md` twin names it when the
  // store holds one there (design D6 item 1).
  if (!bare.startsWith(`${BRAIN_ROOT_REL}/`)) return null;
  return scope.lanes()?.holds(twin) === true ? twin : null;
}

/** The vault-relative path names a regular file, so it can name a page. */
function isVaultFile(vault: string, rel: string): boolean {
  if (!pathIsInside(join(vault, rel), vault)) return false;
  try {
    return statSync(join(vault, rel)).isFile();
  } catch {
    return false;
  }
}

/**
 * The vault-relative path `ref` names, or `null` when it names nothing on
 * disk. A reference that names a path is resolved as one, including its
 * extensionless spelling, whose .md twin is the page an Obsidian writer
 * named (a gate that resolved only the .md form failed OPEN for exactly
 * that spelling). A bare id is a Brain artifact id ({@link artifactPath}).
 * A `.md` path is returned as written, even outside the vault: the caller
 * decides what a path outside the vault means.
 *
 * Two spellings are brought to the vault-relative POSIX form first, since
 * the visibility rules and the callers' join speak only that form:
 *
 *  - on Windows a `\` is a separator (`posixRel`), so
 *    `Brain\preferences\pref-x` is the path it spells rather than a bare
 *    id that resolves to nothing;
 *  - an absolute path is made relative to the vault: one inside the vault
 *    names its page, one outside comes back climbing out of it (or
 *    absolute, on another Windows drive), which every caller refuses.
 *
 * A caller that resolves many references in one operation passes one
 * `scope` for all of them (see {@link ArtifactRefScope}). A caller that
 * already asked {@link laneRefMatch} for `ref` with the same scope passes
 * its answer as `laneMatch`, so a bare id reads no lane index again.
 */
/**
 * The page a bare memory-record id (a preference or a signal) names, or
 * `null` for any other reference: the first step {@link resolveArtifactRef}
 * takes for a bare id, which a view below local reach judges before a
 * shared lane entry of the same id (code review of packages 1 to 5).
 */
export function memoryRecordRel(
  vault: string,
  ref: string,
  scope: ArtifactRefScope = artifactRefScope(vault),
): string | null {
  const spelled = posixRel(unbracket(ref));
  if (spelled.length === 0) return null;
  const bare = canonicalLaneSpelling(isAbsolute(spelled) ? vaultRelative(spelled, vault) : spelled);
  if (bare.length === 0 || bare.endsWith(MARKDOWN_EXT) || bare.includes("/")) return null;
  if (scope.fromStore()) return memoryRelOf(scope.entities(), bare);
  const dirs = scope.dirs();
  for (const dir of [
    dirs.preferences,
    dirs.retired,
    dirs.inbox,
    dirs.processed,
    dirs.archived,
    dirs.pending,
  ]) {
    const abs = join(dir, `${bare}${MARKDOWN_EXT}`);
    if (existsSync(abs)) return vaultRelative(abs, vault);
  }
  return null;
}

export function resolveArtifactRef(
  vault: string,
  ref: string,
  scope: ArtifactRefScope = artifactRefScope(vault),
  laneMatch?: LaneRefMatch,
): string | null {
  const spelled = posixRel(unbracket(ref));
  if (spelled.length === 0) return null;
  const bare = canonicalLaneSpelling(isAbsolute(spelled) ? vaultRelative(spelled, vault) : spelled);
  if (bare.length === 0) return null;
  if (bare.endsWith(MARKDOWN_EXT)) return bare;
  if (bare.includes("/")) return pageCandidate(vault, bare, scope);
  return artifactPath(vault, bare, scope, laneMatch);
}
