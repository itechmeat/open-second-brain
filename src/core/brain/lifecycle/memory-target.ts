/**
 * The one record a single-record lifecycle verb changes (tombstone,
 * supersede, temporal-replace, correct), on either side of the switch
 * (design D14 items 1, 2 and 5).
 *
 * On an unswitched machine the record is its page: a legacy path the
 * caller names, written in place as before, and dual-written to the store
 * behind the phase 1 flag, so a peer that already switched sees the
 * change at once rather than after this machine's own migration.
 *
 * On a store-only machine (`store-only.ts`) the memory records are no
 * pages any more, whether the legacy tree is still on disk or not: a
 * signal is its `signal` and `signal-state` records, a preference its
 * `preference-set` records, any other `Brain/` page a lane entry. A
 * lifecycle change is a field change of that record, written to the store
 * only; a frozen legacy page is never read or written for it. A path
 * outside `Brain/` (a vault note) stays a file on both sides.
 *
 * Addressing, the same on both sides:
 *
 *  - the legacy path (`Brain/inbox/sig-x.md`, `Brain/preferences/pref-x.md`,
 *    `Brain/decisions/x.md`, `Notes/x.md`);
 *  - the bare id or a wikilink (`sig-x`, `[[pref-x]]`, `ret-x`), looked up
 *    in the memory folders, then among the other `Brain/` records by
 *    name (refused when two share it);
 *  - `store:<id>`, as the writers name a store-only record
 *    (`brain feedback` answers `store:sig-x`);
 *  - a search result's store record path (`.brain-store/<partition>/<record id>`,
 *    or `store:<partition>/<record id>`): the record's entity.
 *
 * A record the caller may not read (`readable`) is refused as a missing
 * one. Every refusal is a {@link MemoryTargetError} naming the reference.
 *
 * After a store write the change is read back from the folds
 * ({@link verifyMemoryPatches}): a field register another writer of higher
 * authority holds (a human's status beside an agent's tombstone) keeps its
 * value, and the verb must refuse rather than answer success.
 */

import { existsSync, readdirSync, realpathSync } from "node:fs";
import { basename, join, posix, relative, resolve, sep } from "node:path";

import type { FrontmatterMap } from "../../types.ts";
import { parseFrontmatter } from "../../vault.ts";
import { BRAIN_LOG_REL, BRAIN_ROOT_REL } from "../path-constants.ts";
import { resolveNotePath } from "../note-path.ts";
import {
  MEMORY_FOLDERS,
  memoryFolderRel,
  storeMemoryPage,
  type StoreMemoryPage,
} from "../memory-pages.ts";
import { preferencePrivacy, preferenceStoreRecords, storeFieldsOf } from "../preference.ts";
import { storePreferenceEntry, typedPreferenceFields } from "../preference-store.ts";
import { signalStateRecord, storeSignal } from "../signal-state.ts";
import { privateWithheld } from "../../store/caller-reach.ts";
import {
  assertCreateMatchAtReach,
  assertHolderReadableAtReach,
  assertLaneWriteAtReach,
  LaneEntryWithheldError,
  winnerHeldInPrivate,
} from "../../store/lane-reach-guard.ts";
import { assertStoreContentWrite } from "../../store/content-write-gates.ts";
import { STORE_PARTITIONS, type Authority } from "../../store/constants.ts";
import { authorityFromOrigin, dualWrite, type DualWriteRecord } from "../../store/dual-write.ts";
import { isPrivateFrontmatter } from "../../store/private-page.ts";
import { protectionStore } from "../../store/read/protection-store.ts";
import { readStreamRecords } from "../../store/read/stream-read.ts";
import {
  entryRecord,
  isPrivateEntry,
  legacyPagePrivate,
  storeEntries,
  storeEntry,
  storedEntryPrivate,
} from "../../store/lane-entry-store.ts";
import { brainRelOfEntry, lanePlaceOf } from "../../store/lane-paths.ts";
import { isStoreOnly } from "../../store/store-only.ts";
import { storeWrite } from "../../store/store-write.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";
import { memoryIdOfRef, normalizeChainLink } from "./tombstone-read.ts";

/** Every refusal of {@link resolveMemoryTarget}. */
export class MemoryTargetError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MemoryTargetError";
  }
}

/** What kind of record a lifecycle verb changes. */
export type MemoryTargetKind = "signal" | "preference" | "lane" | "file";

/** One record a lifecycle verb changes. */
export interface MemoryTarget {
  readonly kind: MemoryTargetKind;
  /** Vault-relative POSIX path of the page (the legacy path it has, or would have). */
  readonly rel: string;
  /** The absolute legacy path (`rel` under the vault); no file on a store-only machine. */
  readonly abs: string;
  /** The bare id the record is chained and mentioned under. */
  readonly id: string;
  /** Whether the record lives in the store on this machine (written there only). */
  readonly inStore: boolean;
  /** The frontmatter as the page carries it (the on-disk key shapes). */
  readonly meta: FrontmatterMap;
  readonly body: string;
  /** The store id of a signal or preference (`sig-x`, `pref-x`); the page id otherwise. */
  readonly storeId: string;
}

export interface ResolveMemoryTargetOptions {
  /** The vault-relative paths the caller may read; another is refused as missing. */
  readonly readable?: (rel: string) => boolean;
  readonly configPath?: string;
}

const PAGE_EXT = ".md";
const PREFERENCE_PREFIX = "pref-";
const RETIRED_PREFIX = "ret-";
const SIGNAL_PREFIX = "sig-";
const STORE_REF_PREFIX = "store:";
const STORE_RECORD_PATH_PREFIX = ".brain-store/";
/** A store record id (a ULID: 26 Crockford base32 characters). */
const RECORD_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Whether lifecycle writes for `vault` go to the store only. */
export function lifecycleStoreOnly(vault: string, configPath?: string): boolean {
  return isStoreOnly({ vault, ...(configPath !== undefined ? { configPath } : {}) });
}

/**
 * The write guard of a lifecycle write: the store's content gates (the
 * freeze) on a store-only machine, where the store identity check of the
 * write replaces the vault marker; the vault identity guard otherwise.
 */
export function assertLifecycleWrite(vault: string, configPath?: string): void {
  if (lifecycleStoreOnly(vault, configPath)) assertStoreContentWrite(vault);
  else assertVaultIdentityForWrite(vault);
}

function toPosixRel(vault: string, abs: string): string {
  return relative(vault, abs).split(sep).join("/");
}

function insideBrainRel(rel: string): boolean {
  return rel === BRAIN_ROOT_REL || rel.startsWith(`${BRAIN_ROOT_REL}/`);
}

/** The memory folder a vault-relative path sits directly in, if any. */
function memoryFolderOfRel(rel: string): boolean {
  const dir = posix.dirname(rel);
  return MEMORY_FOLDERS.some((f) => memoryFolderRel(f) === dir);
}

function refusal(ref: string, why: string): MemoryTargetError {
  return new MemoryTargetError(`note does not exist: ${ref}${why === "" ? "" : ` (${why})`}`);
}

/** The reference with its `[[ ]]` fence and `|alias` removed. */
function unfenced(raw: string): string {
  let value = raw.trim();
  const fence = /^\[\[([^\]]+)\]\]$/.exec(value);
  if (fence) value = fence[1]!.trim();
  const pipe = value.indexOf("|");
  return pipe >= 0 ? value.slice(0, pipe).trim() : value;
}

/** The record id a store record reference names (`.brain-store/<p>/<id>`, `<p>/<id>`, `<id>`). */
function recordIdOf(ref: string): string | null {
  const rest = ref.startsWith(STORE_RECORD_PATH_PREFIX)
    ? ref.slice(STORE_RECORD_PATH_PREFIX.length)
    : ref;
  const parts = rest.split("/");
  if (parts.length === 2 && (STORE_PARTITIONS as ReadonlyArray<string>).includes(parts[0]!)) {
    return RECORD_ID_RE.test(parts[1]!) ? parts[1]! : null;
  }
  return parts.length === 1 && RECORD_ID_RE.test(parts[0]!) ? parts[0]! : null;
}

/**
 * The entity the store record `recordId` belongs to: a signal or a
 * preference by its id, a lane entry by its `Brain/` path. `null` when no
 * held `events` shard holds the record.
 */
function entityOfRecord(recordId: string, configPath?: string): string | null {
  const store = protectionStore(configPath, { needShared: true });
  if (store === null) return null;
  for (const partition of STORE_PARTITIONS) {
    if (!store.partitions.has(partition) || (privateWithheld() && partition !== "shared")) continue;
    const read = readStreamRecords(store.root, partition, { stream: "events" });
    const record = read.records.find((r) => r.id === recordId);
    if (record === undefined) continue;
    const body = record.body;
    if (record.kind === "signal" && typeof body["id"] === "string") return body["id"];
    if (typeof body["signal"] === "string") return body["signal"];
    if (typeof body["preference"] === "string") return body["preference"];
    if (typeof body["lane"] === "string" && typeof body["entry"] === "string") {
      return posix.join(BRAIN_ROOT_REL, brainRelOfEntry(body["lane"], body["entry"]));
    }
    return null;
  }
  return null;
}

/** The store's signal or preference page named `id` (a preference under either page id). */
function storePageById(
  vault: string,
  id: string,
  configPath?: string,
): StoreMemoryPage | undefined {
  const context = configPath !== undefined ? { configPath } : {};
  const found = storeMemoryPage(vault, id, context);
  if (found !== undefined) return found;
  if (id.startsWith(PREFERENCE_PREFIX)) {
    return storeMemoryPage(
      vault,
      `${RETIRED_PREFIX}${id.slice(PREFERENCE_PREFIX.length)}`,
      context,
    );
  }
  if (id.startsWith(RETIRED_PREFIX)) {
    return storeMemoryPage(
      vault,
      `${PREFERENCE_PREFIX}${id.slice(RETIRED_PREFIX.length)}`,
      context,
    );
  }
  return undefined;
}

function fromStorePage(vault: string, page: StoreMemoryPage): MemoryTarget {
  const [meta, body] = page.read();
  const kind: MemoryTargetKind = page.kind === "signal" ? "signal" : "preference";
  const storeId =
    kind === "preference" && page.id.startsWith(RETIRED_PREFIX)
      ? `${PREFERENCE_PREFIX}${page.id.slice(RETIRED_PREFIX.length)}`
      : page.id;
  return {
    kind,
    rel: page.rel,
    abs: join(vault, ...page.rel.split("/")),
    id: page.id,
    inStore: true,
    meta: { ...meta },
    body,
    storeId,
  };
}

function fromStoreLane(vault: string, rel: string): MemoryTarget | null {
  const brainRel = rel.slice(BRAIN_ROOT_REL.length + 1);
  if (lanePlaceOf(brainRel) === null) return null;
  const abs = join(vault, ...rel.split("/"));
  const value = storeEntry(vault, abs);
  if (value === null) return null;
  const id = normalizeChainLink(rel);
  return {
    kind: "lane",
    rel,
    abs,
    id,
    inStore: true,
    meta: structuredClone(value.fields) as FrontmatterMap,
    body: value.text,
    storeId: id,
  };
}

/**
 * Classify a page file of an unswitched machine (or a vault note) by where
 * it sits and what it is. `root` is the canonical vault root `abs` was
 * resolved under (`resolveNotePath` answers the real path).
 */
function fromFile(root: string, abs: string): MemoryTarget {
  const rel = toPosixRel(root, abs);
  const [meta, body] = parseFrontmatter(abs);
  const kindField = meta["kind"];
  let kind: MemoryTargetKind = "file";
  if (insideBrainRel(rel)) {
    if (memoryFolderOfRel(rel) && kindField === "brain-signal") kind = "signal";
    else if (
      memoryFolderOfRel(rel) &&
      (kindField === "brain-preference" || kindField === "brain-retired")
    ) {
      kind = "preference";
    } else if (
      !memoryFolderOfRel(rel) &&
      lanePlaceOf(rel.slice(BRAIN_ROOT_REL.length + 1)) !== null
    ) {
      kind = "lane";
    }
  }
  const id = normalizeChainLink(rel);
  const metaId = typeof meta["id"] === "string" ? meta["id"] : id;
  const storeId =
    kind === "preference" && metaId.startsWith(RETIRED_PREFIX)
      ? `${PREFERENCE_PREFIX}${metaId.slice(RETIRED_PREFIX.length)}`
      : kind === "signal" || kind === "preference"
        ? metaId
        : id;
  return { kind, rel, abs, id, inStore: false, meta: { ...meta }, body, storeId };
}

/** The unique `Brain/` page of an unswitched vault whose basename is `<id>.md`, outside the log. */
function legacyPageNamed(
  vault: string,
  id: string,
  readable: ((rel: string) => boolean) | undefined,
): string | null {
  // Only the pages the caller may read are candidates: a withheld page is
  // never chosen, never makes the name ambiguous and is never named.
  const mayRead = (abs: string): boolean =>
    readable === undefined || readable(toPosixRel(vault, abs));
  for (const folder of MEMORY_FOLDERS) {
    const abs = join(vault, ...memoryFolderRel(folder).split("/"), `${id}${PAGE_EXT}`);
    if (existsSync(abs) && mayRead(abs)) return abs;
  }
  const found: string[] = [];
  const skip = new Set([join(vault, ...BRAIN_LOG_REL.split("/"))]);
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !skip.has(full)) walk(full);
      } else if (entry.isFile() && entry.name === `${id}${PAGE_EXT}` && mayRead(full)) {
        found.push(full);
      }
    }
  };
  walk(join(vault, BRAIN_ROOT_REL));
  if (found.length > 1) {
    throw new MemoryTargetError(
      `${id} names ${found.length} Brain pages (${found
        .map((f) => toPosixRel(vault, f))
        .toSorted()
        .join(", ")}); name the one you mean by its path`,
    );
  }
  return found[0] ?? null;
}

/** The unique live lane entry of the store whose basename is `id`, as its vault-relative path. */
function storeLaneNamed(
  id: string,
  readable: ((rel: string) => boolean) | undefined,
): string | null {
  const found: string[] = [];
  for (const value of storeEntries().values()) {
    const rel = posix.join(BRAIN_ROOT_REL, brainRelOfEntry(value.lane, value.entry));
    // A withheld entry is no candidate (see `legacyPageNamed`).
    if (normalizeChainLink(rel) === id && (readable === undefined || readable(rel)))
      found.push(rel);
  }
  if (found.length > 1) {
    throw new MemoryTargetError(
      `${id} names ${found.length} Brain records (${found.toSorted().join(", ")}); ` +
        "name the one you mean by its path",
    );
  }
  return found[0] ?? null;
}

/**
 * Refuse `rel` when the caller may not read it, before anything of the
 * record is read: a withheld record is refused as a missing one.
 */
function assertReadable(
  rel: string,
  ref: string,
  readable: ((rel: string) => boolean) | undefined,
): void {
  if (readable !== undefined && !readable(rel)) throw refusal(ref, "");
}

/**
 * A caller's path spelling as one form: Unicode NFC (a macOS file system
 * hands out NFD names) and `/` separators (a Windows caller writes `\\`).
 */
function canonicalSpelling(ref: string): string {
  return ref.normalize("NFC").replaceAll("\\", "/");
}

/** The key two spellings of one path share on a case-insensitive file system. */
function foldedKey(rel: string): string {
  return rel.normalize("NFC").toLowerCase();
}

/** Whether a vault-relative POSIX path is in the legacy tree, in any case. */
function inBrainAnyCase(rel: string): boolean {
  const first = rel.split("/")[0] ?? "";
  return foldedKey(first) === foldedKey(BRAIN_ROOT_REL);
}

/** `rel` with its root and memory folder spelled as the tree spells them. */
function canonicalBrainSpelling(rel: string): string {
  const segments = rel.split("/");
  const canonical = [BRAIN_ROOT_REL, ...segments.slice(1)].join("/");
  const dir = posix.dirname(canonical);
  for (const folder of MEMORY_FOLDERS) {
    const folderRel = memoryFolderRel(folder);
    if (foldedKey(folderRel) === foldedKey(dir)) {
      return posix.join(folderRel, posix.basename(canonical));
    }
  }
  return canonical;
}

/**
 * The `Brain/`-relative spelling of the path `abs` names when it reaches
 * the legacy tree by any route, else `null`: lexically in any case (a
 * case-insensitive file system answers `brain/` with `Brain/`), or, when
 * the path exists, through what it resolves to (a link, a case-folded
 * name). The store-versus-file decision is made on this canonical path.
 */
function legacyTreeRel(vault: string, abs: string): string | null {
  const root = resolve(vault);
  const lexical = canonicalSpelling(toPosixRel(root, abs));
  if (inBrainAnyCase(lexical)) return canonicalBrainSpelling(lexical);
  if (!existsSync(abs)) return null;
  try {
    const real = canonicalSpelling(toPosixRel(realpathSync(root), realpathSync(abs)));
    return inBrainAnyCase(real) ? canonicalBrainSpelling(real) : null;
  } catch {
    return null;
  }
}

/**
 * The store's live lane entry at `rel`, or the one entry whose path
 * differs from it only in case or Unicode form (a case-insensitive file
 * system spells one path many ways); `null` when there is none or the
 * spelling names several.
 */
function storeLaneRelAt(vault: string, rel: string): string | null {
  const abs = join(vault, ...rel.split("/"));
  if (
    lanePlaceOf(rel.slice(BRAIN_ROOT_REL.length + 1)) !== null &&
    storeEntry(vault, abs) !== null
  ) {
    return rel;
  }
  const key = foldedKey(rel);
  const found: string[] = [];
  for (const value of storeEntries().values()) {
    const candidate = posix.join(BRAIN_ROOT_REL, brainRelOfEntry(value.lane, value.entry));
    if (foldedKey(candidate) === key) found.push(candidate);
  }
  // Below local reach a shared spelling found here stands in for the
  // entry named only when the whole fold agrees: a match held in `private`
  // (the entry named, or another spelling) is the fixed refusal, never a
  // shared spelling patched in its place.
  if (found.length > 0) {
    assertCreateMatchAtReach(vault, () =>
      [...storeEntries().values()]
        .map((value) => posix.join(BRAIN_ROOT_REL, brainRelOfEntry(value.lane, value.entry)))
        .filter((candidate) => foldedKey(candidate) === key)
        .map((candidate) => join(vault, ...candidate.split("/"))),
    );
  }
  return found.length === 1 ? found[0]! : null;
}

/**
 * The record `ref` names (see the module docblock for the forms), read as
 * the verb will change it. Throws {@link MemoryTargetError} for a
 * reference that names nothing this machine holds, names it ambiguously,
 * or names a record the caller may not read.
 */
export function resolveMemoryTarget(
  vault: string,
  rawRef: string,
  options: ResolveMemoryTargetOptions = {},
): MemoryTarget {
  const original = rawRef.trim();
  if (original === "") throw new MemoryTargetError("a target is required");
  const storeOnly = lifecycleStoreOnly(vault, options.configPath);
  let ref = unfenced(original);
  // Whether the caller named a store record explicitly, judged after the
  // wikilink fence is removed: `store:...` or a `.brain-store/...` path.
  const explicitStore =
    ref.startsWith(STORE_REF_PREFIX) || ref.startsWith(STORE_RECORD_PATH_PREFIX);
  if (ref.startsWith(STORE_REF_PREFIX)) ref = ref.slice(STORE_REF_PREFIX.length).trim();
  const recordId = recordIdOf(ref);
  if (recordId !== null && (explicitStore || storeOnly)) {
    const entity = entityOfRecord(recordId, options.configPath);
    if (entity !== null) ref = entity;
    // A bare name of a record id's shape that no record has may still be a
    // page's name; an explicit store address must name a record.
    else if (explicitStore) throw refusal(original, "no record of the brain store has this id");
  }
  const isPath = ref.includes("/") || ref.includes("\\") || ref.toLowerCase().endsWith(PAGE_EXT);
  if (isPath) {
    const spelled = canonicalSpelling(ref);
    const abs = resolve(vault, spelled);
    const root = resolve(vault);
    if (abs !== root && !abs.startsWith(root + sep)) {
      throw new MemoryTargetError(`note path resolves outside the vault: ${ref}`);
    }
    // Once switched a Brain record is the store's, whatever a frozen legacy
    // page next to it still says, and whatever spelling or route (case,
    // Unicode form, separators, a link) reaches that page.
    const brainRel = storeOnly ? legacyTreeRel(vault, abs) : null;
    if (brainRel !== null) {
      assertReadable(brainRel, original, options.readable);
      if (memoryFolderOfRel(brainRel)) {
        const page = storePageById(vault, normalizeChainLink(brainRel), options.configPath);
        if (page === undefined) throw refusal(original, "the brain store holds no such record");
        assertReadable(page.rel, original, options.readable);
        return fromStorePage(vault, page);
      }
      const laneRel = storeLaneRelAt(vault, brainRel);
      if (laneRel !== null) assertReadable(laneRel, original, options.readable);
      const lane = laneRel === null ? null : fromStoreLane(vault, laneRel);
      if (lane === null) throw refusal(original, "the brain store holds no such record");
      return lane;
    }
    let resolved: string;
    try {
      // `readable` is asked before the note is read.
      resolved = resolveNotePath(vault, spelled, {
        mustExist: true,
        ...(options.readable !== undefined ? { readable: options.readable } : {}),
      });
    } catch (err) {
      throw new MemoryTargetError((err as Error).message, { cause: err });
    }
    // The real path is judged against the real vault root, so a vault
    // reached through a link classifies its pages by their vault path.
    const realRoot = canonicalRoot(vault);
    assertReadable(toPosixRel(realRoot, resolved), original, options.readable);
    return fromFile(realRoot, resolved);
  }
  // A bare id.
  const id = normalizeChainLink(canonicalSpelling(ref));
  if (storeOnly) {
    const page = storePageById(vault, id, options.configPath);
    if (page !== undefined) {
      assertReadable(page.rel, original, options.readable);
      return fromStorePage(vault, page);
    }
    if (!id.startsWith(SIGNAL_PREFIX) && !id.startsWith(PREFERENCE_PREFIX)) {
      const rel = storeLaneNamed(id, options.readable);
      if (rel !== null) {
        assertReadable(rel, original, options.readable);
        const lane = fromStoreLane(vault, rel);
        if (lane !== null) return lane;
      }
    }
    throw refusal(original, "the brain store holds no signal, preference or record of this name");
  }
  const found = legacyPageNamed(vault, id, options.readable);
  if (found === null) throw refusal(original, "no Brain page has this name");
  // The same containment the path form gets: a page that is a link out of
  // the vault is refused, never read or written.
  let resolved: string;
  try {
    resolved = resolveNotePath(vault, toPosixRel(vault, found), {
      mustExist: true,
      ...(options.readable !== undefined ? { readable: options.readable } : {}),
    });
  } catch (err) {
    throw new MemoryTargetError((err as Error).message, { cause: err });
  }
  const realRoot = canonicalRoot(vault);
  assertReadable(toPosixRel(realRoot, resolved), original, options.readable);
  return fromFile(realRoot, resolved);
}

/** The vault root as `resolveNotePath` resolves it (links followed). */
function canonicalRoot(vault: string): string {
  try {
    return realpathSync(resolve(vault));
  } catch {
    return resolve(vault);
  }
}

/**
 * The bare memory id a caller's reference names for the verbs addressed by
 * id (retire, reject, expire): a store record address (`store:<partition>/<id>`,
 * `.brain-store/<partition>/<id>`, fenced or not) is resolved to its
 * entity's id, every other form goes through `memoryIdOfRef`. An address
 * no held record answers is returned as written, so the verb refuses it.
 */
export function memoryIdOfStoreRef(rawRef: string, configPath?: string): string {
  const ref = unfenced(rawRef.trim());
  const explicitStore =
    ref.startsWith(STORE_REF_PREFIX) || ref.startsWith(STORE_RECORD_PATH_PREFIX);
  const bare = ref.startsWith(STORE_REF_PREFIX) ? ref.slice(STORE_REF_PREFIX.length).trim() : ref;
  const recordId = explicitStore ? recordIdOf(bare) : null;
  if (recordId !== null) {
    const entity = entityOfRecord(recordId, configPath);
    return entity === null ? rawRef.trim() : memoryIdOfRef(entity);
  }
  return memoryIdOfRef(rawRef);
}

/**
 * The store records of one patch of `target`'s frontmatter (`null` removes
 * a field), at `authority`, in the partition the record lives in:
 *
 *  - a signal: one `signal-state` record with the fields;
 *  - a preference: `preference-set` records with the normalised fields
 *    (`_status` is the field `status`), every one decided by this write;
 *  - a lane entry: the whole entry with the patch applied.
 *
 * A vault note has no store record: `[]`.
 */
export function memoryPatchRecords(
  vault: string,
  target: MemoryTarget,
  patch: Readonly<Record<string, unknown>>,
  authority: Authority,
): DualWriteRecord[] {
  switch (target.kind) {
    case "signal": {
      const isPrivate = target.inStore
        ? (storeSignal(target.storeId)?.private ?? true)
        : isPrivateFrontmatter(target.meta);
      return [
        signalStateRecord({ id: target.storeId, fields: patch, authority, private: isPrivate }),
      ];
    }
    case "preference": {
      const fields = typedPreferenceFields(storeFieldsOf({ ...patch }));
      const slug = target.storeId.slice(PREFERENCE_PREFIX.length);
      const held = target.inStore ? (storePreferenceEntry(slug)?.private ?? true) : false;
      const isPrivate =
        held || isPrivateFrontmatter(target.meta) || preferencePrivacy(vault, fields)();
      return (
        preferenceStoreRecords(target.storeId, fields, authority, isPrivate, Object.keys(fields)) ??
        []
      );
    }
    case "lane": {
      const fields: Record<string, unknown> = { ...target.meta };
      for (const [name, value] of Object.entries(patch)) {
        if (value === null) delete fields[name];
        else fields[name] = value;
      }
      // A stored entry keeps the partition it lives in (`located`): a
      // lifecycle change of a shared entry must reach a device that holds
      // only `shared`, whatever the lane's private-when-held rule says.
      if (target.inStore) {
        return [
          entryRecord(
            vault,
            target.abs,
            fields,
            target.body,
            storedEntryPrivate(vault, target.abs),
            "located",
          ),
        ];
      }
      const isPrivate =
        legacyPagePrivate(vault, target.abs) || isPrivateEntry(vault, fields, target.body);
      return [entryRecord(vault, target.abs, fields, target.body, isPrivate)];
    }
    case "file":
      return [];
  }
}

/** One change of one record: its target and the frontmatter fields it sets. */
export interface MemoryPatch {
  readonly target: MemoryTarget;
  readonly patch: Readonly<Record<string, unknown>>;
}

/** Whether any of the patches' store records would land in `private`. */
export function patchesPrivate(records: ReadonlyArray<DualWriteRecord>): boolean {
  return records.some((r) => r.private === true);
}

/**
 * Write `patches` as one operation: on a store-only machine the store
 * records of every target the store holds (one append, one partition),
 * then `legacy` for the vault notes among them; on an unswitched machine
 * `legacy` for every page, then the dual write behind the flag. Returns
 * whether the records landed in `private` (for the log event the verb
 * appends next, which must land beside them). A store failure throws the
 * store's `StoreWriteError`; nothing of the operation is written then.
 */
export function writeMemoryPatches(
  vault: string,
  patches: ReadonlyArray<MemoryPatch>,
  legacy: (onDisk: ReadonlyArray<MemoryPatch>) => void,
  options: { readonly authority?: Authority; readonly configPath?: string } = {},
): { readonly private: boolean } {
  const authority = options.authority ?? authorityFromOrigin();
  const context = {
    vault,
    ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
  };
  const stored = patches.filter((p) => p.target.inStore);
  const onDisk = patches.filter((p) => !p.target.inStore);
  // The last guard, whatever resolved the targets: a switched machine never
  // writes under the legacy tree, by any spelling or route. Refused before
  // anything of the operation is written.
  if (onDisk.length > 0 && lifecycleStoreOnly(vault, options.configPath)) {
    for (const { target } of onDisk) {
      if (legacyTreeRel(vault, target.abs) !== null) {
        throw new MemoryTargetError(
          `${target.rel} is in the frozen legacy tree of a switched vault: the change was ` +
            "refused, nothing was written; name the record so the brain store resolves it",
        );
      }
    }
  }
  const build = (items: ReadonlyArray<MemoryPatch>): DualWriteRecord[] =>
    items.flatMap((p) => memoryPatchRecords(vault, p.target, p.patch, authority));
  if (stored.length > 0) {
    const lanes = stored.filter((p) => p.target.kind === "lane").map((p) => p.target.abs);
    assertLaneWriteAtReach(vault, lanes, options.configPath);
    // All or none: a patch a higher-authority write would outrank is
    // refused before any record of the operation is appended.
    assertPatchesApply(vault, stored, authority, options.configPath);
    const records = build(stored);
    // Below local reach a lane record placed in `private` cannot be read
    // back through the caller's fold (verifyMemoryPatches): refused before
    // any record, nothing half done (the write rule).
    if (privateWithheld() && records.some((r) => r.private === true && r.kind === "lane-entry")) {
      throw new LaneEntryWithheldError();
    }
    if (records.length > 0) storeWrite(() => records, context);
    if (onDisk.length > 0) legacy(onDisk);
    return { private: patchesPrivate(records) };
  }
  legacy(onDisk);
  let records: DualWriteRecord[] = [];
  dualWrite(() => (records = build(onDisk)), context);
  return {
    private: patchesPrivate(records) || onDisk.some((p) => isPrivateFrontmatter(p.target.meta)),
  };
}

/** The kinds of a lane entry's register (one register per entry). */
const LANE_REGISTER_KINDS: ReadonlySet<string> = new Set(["lane-entry", "lane-entry-remove"]);

function outranked(target: MemoryTarget, field: string): MemoryTargetError {
  return new MemoryTargetError(
    `the change of ${target.rel} would not be applied: its ${field} is held by a human ` +
      "decision, which outranks an agent's write; nothing was written. Run the change from " +
      "the operator's own shell (`o2b`) instead",
  );
}

/**
 * Refuse `patches` before anything is written when a store register they
 * change is held by a write of higher authority. The folds resolve a
 * preference field and a lane entry by authority first, so an agent's
 * record loses to any human record of the same register, whatever its
 * clock; a signal's fields resolve by the clock alone and are never
 * outranked. A human write is never outranked either (the later one wins).
 * {@link verifyMemoryPatches} stays the backstop after the write.
 */
export function assertPatchesApply(
  vault: string,
  patches: ReadonlyArray<MemoryPatch>,
  authority: Authority,
  configPath?: string,
): void {
  if (authority === "human") return;
  type Held = { readonly body: Record<string, unknown>; readonly partition: string };
  let laneRecords: ReadonlyArray<Held> | null = null;
  const lanes = (): ReadonlyArray<Held> => {
    if (laneRecords !== null) return laneRecords;
    const store = protectionStore(configPath, { needShared: true });
    const out: Held[] = [];
    if (store !== null) {
      for (const partition of STORE_PARTITIONS) {
        if (!store.partitions.has(partition)) continue;
        for (const r of readStreamRecords(store.root, partition, { stream: "events" }).records) {
          if (LANE_REGISTER_KINDS.has(r.kind)) out.push({ body: r.body, partition });
        }
      }
    }
    laneRecords = out;
    return out;
  };
  for (const { target, patch } of patches) {
    if (!target.inStore) continue;
    if (target.kind === "preference") {
      const entry = storePreferenceEntry(
        target.storeId.slice(PREFERENCE_PREFIX.length),
        configPath,
      );
      if (entry === undefined) continue;
      const wanted = new Set(Object.keys(typedPreferenceFields(storeFieldsOf({ ...patch }))));
      for (const record of entry.state.history) {
        if (record.kind !== "preference-set" || record.body["authority"] !== "human") continue;
        const fields = record.body["fields"];
        if (typeof fields !== "object" || fields === null) continue;
        for (const name of Object.keys(fields)) {
          if (wanted.has(name)) throw outranked(target, `field ${name}`);
        }
      }
    } else if (target.kind === "lane") {
      const [record] = memoryPatchRecords(vault, target, patch, authority);
      if (record === undefined || record.body["authority"] === "human") continue;
      const place = lanePlaceOf(target.rel.slice(BRAIN_ROOT_REL.length + 1));
      if (place === null) continue;
      const held = lanes().filter(
        (r) =>
          r.body["lane"] === place.lane &&
          r.body["entry"] === place.entry &&
          r.body["authority"] === "human",
      );
      if (held.length > 0) {
        assertHolderReadableAtReach(winnerHeldInPrivate(place.lane, place.entry, configPath));
      }
      if (held.length > 0) throw outranked(target, "entry");
    }
  }
}

/** A frontmatter value as the page parser compares it: text, `null` for absent. */
function comparable(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function valueOf(meta: Readonly<Record<string, unknown>>, name: string): unknown {
  if (name in meta) return meta[name];
  const bare = name.startsWith("_") ? name.slice(1) : `_${name}`;
  return meta[bare];
}

/**
 * Read every store target of `patches` back and check each field holds
 * the value written. Throws {@link MemoryTargetError} naming the first
 * field that did not take (a register another writer of higher authority
 * holds): the verb refuses rather than answer a change no reader sees.
 */
export function verifyMemoryPatches(
  vault: string,
  patches: ReadonlyArray<MemoryPatch>,
  configPath?: string,
): void {
  for (const { target, patch } of patches) {
    if (!target.inStore) continue;
    let meta: Readonly<Record<string, unknown>> | null = null;
    if (target.kind === "lane") {
      meta = storeEntry(vault, target.abs)?.fields ?? null;
    } else {
      const page =
        storePageById(vault, target.id, configPath) ??
        storePageById(vault, target.storeId, configPath);
      meta = page === undefined ? null : page.read()[0];
    }
    if (meta === null) {
      throw new MemoryTargetError(`${target.rel} is no longer held by the brain store`);
    }
    for (const [name, value] of Object.entries(patch)) {
      if (comparable(valueOf(meta, name)) === comparable(value)) continue;
      throw new MemoryTargetError(
        `the change of ${target.rel} was not applied: its field ${name.replace(/^_/, "")} is held ` +
          "by a write of higher authority (a human decision outranks an agent's), so readers still " +
          "see the old value; run the change from the operator's own shell (`o2b`) instead",
      );
    }
  }
}

/** The basename a target's page has, for messages. */
export function targetName(target: MemoryTarget): string {
  return basename(target.rel);
}
