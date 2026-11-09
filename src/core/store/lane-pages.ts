/**
 * The page store of the Brain record lanes (design D14 item 2, task 2.10
 * WP6): the one place the lane modules (dead-ends, handoffs, pledges,
 * obligations, decisions, ...) read and write their pages, so each of them
 * keeps its page format and follows the machine's switch with no code of
 * its own.
 *
 *  - **Store-only machine** (`store-only.ts`): a page is a `lane-entry`
 *    record (`lane-records.ts`), addressed by its legacy path
 *    (`lane-paths.ts`): its frontmatter becomes the entry's fields, its
 *    body the entry's text. A write appends a record through
 *    {@link storeWrite}; a removal appends the entry's tombstone; a move
 *    is the tombstone of the old entry and the new entry, written as one
 *    operation in one partition. Reads fold the lane-entry records. No
 *    byte is written under `<vault>/Brain/`, and no vault is needed.
 *  - **Unswitched machine**: the page is the legacy file, written exactly
 *    as before, with the phase 1 dual write behind the flag
 *    ({@link routeWrite}).
 *
 * Privacy (phase 1 rules): a page is private when its frontmatter
 * reserves it, or when its fields or text name a private page or one that
 * cannot be judged. Each call is one operation with one verdict, and every
 * record it writes lands in one partition; an enclosing
 * `withOperationPrivacy` raises it too.
 *
 * Authority follows the origin channel (`authorityFromOrigin`): a command
 * the user ran is `human`, an agent tool call is `agent`. Standing rules
 * are always `human` (D14 item 4).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

import { BRAIN_ROOT_REL } from "../brain/path-constants.ts";
import { acquireLockSyncWithRetry } from "../brain/sync-lockfile.ts";
import { assertVaultIdentityForWrite } from "../brain/vault-identity.ts";
import {
  atomicCreateFileSyncExclusive,
  atomicWriteFileSync,
  FileAlreadyExistsError,
  renameWithRetry,
} from "../fs-atomic.ts";
import { canonicalJson } from "../integrity/digest.ts";
import { noVaultRoot } from "../platform-dirs.ts";
import { containedRecordPath } from "../record-path.ts";
import type { FrontmatterMap } from "../types.ts";
import {
  formatFrontmatter,
  parseFrontmatter,
  parseFrontmatterText,
  writeFrontmatterAtomic,
  type WriteFrontmatterAtomicOptions,
} from "../vault.ts";
import type { Authority, StorePartition } from "./constants.ts";
import { authorityFromOrigin, type DualWriteContext, type DualWriteRecord } from "./dual-write.ts";
import { laneFingerprintOf, laneLockTarget, laneStoreFold } from "./lane-fold-cache.ts";
import { brainRelOfEntry, lanePlaceOf } from "./lane-paths.ts";
import {
  laneEntryKey,
  laneEntryRecord,
  laneEntryRemoveRecord,
  STANDING_RULE_LANE,
  type LaneEntryValue,
} from "./lane-records.ts";
import { opaqueFields } from "./operation-privacy.ts";
import { isPrivateFrontmatter } from "./private-page.ts";
import { configuredStore } from "./read/store-entities.ts";
import { rowNamesPrivatePage } from "./reference-privacy.ts";
import { storeOnlyMode } from "./store-only.ts";
import { acquireDirLock, STORE_LOCK_STALE_MS, withLocalLock } from "./local-lock.ts";
import { assertNoteVaultForWrite } from "../vault-adapter/index.ts";
import { withOperationPrivacy } from "./operation-scope.ts";
import { routeWrite, storeWrite } from "./store-write.ts";

/**
 * The vault root a lane module works under when no vault is configured.
 * Nothing is ever written below it: with no vault the machine is
 * store-only, so every lane page is a store record. It only gives the lane
 * modules a stable root to build their paths from.
 */
export function laneVaultRoot(vault: string | null | undefined): string {
  return vault ?? noVaultRoot();
}

/**
 * The write guard of a lane write: the vault identity guard (freeze,
 * migration gate, identity marker) on an unswitched machine; nothing on a
 * store-only one, where the store write checks the store identity itself
 * (design D14 item 13).
 */
export function assertLaneWrite(vault: string): void {
  if (!lanePagesInStore(vault)) assertVaultIdentityForWrite(vault);
}

/** Whether lane pages of `vault` live in the store on this machine. */
export function lanePagesInStore(vault: string): boolean {
  return storeOnlyMode({ vault }).storeOnly;
}

/** Fields of a lane page that are stamps and ids, never page references. */
const PAGE_OPAQUE_FIELDS = opaqueFields("slug", "date", "valid_from", "content_hash", "revision");

/**
 * Does the store hold `path` on this machine: a store-only machine and a
 * path under `<vault>/Brain/`. Any other path (a user's `skills/` or
 * `runbooks/` page a lane module also reads) stays a file in both modes.
 */
function heldInStore(vault: string, path: string): boolean {
  return lanePagesInStore(vault) && insideBrain(vault, path);
}

/** `routeWrite` for a lane path; a path outside `Brain/` is written as a file. */
function routeLaneWrite(vault: string, path: string, spec: Parameters<typeof routeWrite>[0]): void {
  // A path outside `Brain/` is no lane entry in either mode: a file, never
  // dual-written as a record (it has no place in the lane path rule).
  if (!insideBrain(vault, path)) {
    guardUserVaultWrite(vault, path);
    spec.legacy();
    return;
  }
  routeWrite(spec);
}

/** Whether `path` lies under `<vault>/Brain/` (or is it). */
function insideBrain(vault: string, path: string): boolean {
  const rel = relative(join(vault, BRAIN_ROOT_REL), path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The guard of a lane module's write outside `Brain/` on a store-only
 * machine. A path in the user's vault (a materialised `skills/` page, a
 * runbook) goes through the vault adapter's write guard: the vault must be
 * the one bound to this machine's store, and not frozen. With no vault
 * (the no-vault root) there is no user vault to write into, and the
 * adapter refuses by name. A path outside the vault (device-local machine
 * state) has no vault to guard. An unswitched machine guards with
 * `assertLaneWrite` as before.
 */
function guardUserVaultWrite(vault: string, path: string): void {
  if (!lanePagesInStore(vault)) return;
  const rel = relative(vault, path);
  if (rel.startsWith("..") || isAbsolute(rel)) return;
  assertNoteVaultForWrite(
    vault === laneVaultRoot(null) ? null : vault,
    "a lane write into the vault",
  );
}

function brainRelOf(vault: string, path: string): string {
  return relative(join(vault, BRAIN_ROOT_REL), path).split(sep).join("/");
}

function placeOf(vault: string, path: string): { lane: string; entry: string } {
  const place = lanePlaceOf(brainRelOf(vault, path));
  if (place === null) throw new Error(`not a Brain lane page: ${path}`);
  return place;
}

function context(vault: string): DualWriteContext {
  return existsSync(vault) ? { vault } : {};
}

// ----- The store side -----------------------------------------------------------

/** The live lane entries of the configured store, by `<lane>/<entry>`. */
function storeEntries(): ReadonlyMap<string, LaneEntryValue> {
  return laneStoreFold().entries;
}

/**
 * The physical time (ms) of the newest record of the live lane entry at
 * `path`, the store's stand-in for a file's mtime; `null` when there is no
 * such entry. A file's mtime on a path the store does not hold.
 */
export function laneEntryClockMs(vault: string, path: string): number | null {
  if (!heldInStore(vault, path)) {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return null;
    }
  }
  const { lane, entry } = placeOf(vault, path);
  return laneStoreFold().clocks.get(laneEntryKey(lane, entry)) ?? null;
}

function storeEntry(vault: string, path: string): LaneEntryValue | null {
  const { lane, entry } = placeOf(vault, path);
  return storeEntries().get(laneEntryKey(lane, entry)) ?? null;
}

/**
 * Whether the lane fold misses an `events` shard (unreadable, or gone
 * since this machine read it): an entry's private records may be in it,
 * so every privacy verdict over the fold fails closed (design D14).
 */
function foldIncomplete(): boolean {
  return laneStoreFold().unreadable.length > 0;
}

/** Whether the live entry `value` was written to the `private` partition. */
function livesInPrivate(value: LaneEntryValue): boolean {
  return laneStoreFold().privateKeys.has(laneEntryKey(value.lane, value.entry));
}

/**
 * Whether the store holds `path` on this machine as a live entry of the
 * `private` partition. An entry can be private by partition alone, with no
 * `visibility:` in its fields, so an exporter that turns entries back into
 * pages asks here to keep the privacy (review finding F333). A path the
 * store does not hold is no private entry. While the fold misses a shard,
 * every lane entry reads as private (fail closed).
 */
export function laneEntryInPrivate(vault: string, path: string): boolean {
  if (!heldInStore(vault, path)) return false;
  if (lanePlaceOf(brainRelOf(vault, path)) === null) return false;
  if (foldIncomplete()) return true;
  const value = storeEntry(vault, path);
  return value !== null && livesInPrivate(value);
}

/** The partition the live entry `value` lives in. */
function partitionOf(value: LaneEntryValue): StorePartition {
  return livesInPrivate(value) ? "private" : "shared";
}

/**
 * The tombstone of a live entry, in the partition the entry lives in
 * whatever the rest of its operation is (`Located`, content-free): a
 * device that holds only `shared` must see a shared entry's tombstone.
 * `onlyIfApart`: the tombstone of an entry a write replaces, needed only
 * when the replacement lands in another partition.
 */
function tombstoneOf(value: LaneEntryValue, onlyIfApart = false): DualWriteRecord {
  const partition = partitionOf(value);
  return {
    ...laneEntryRemoveRecord({
      lane: value.lane,
      entry: value.entry,
      authority: authorityFor(value.lane),
      private: partition === "private",
    }),
    located: { partition, content: false, ...(onlyIfApart ? { onlyIfApart: true } : {}) },
  };
}

/**
 * The tombstone a write replacing the entry at `path` adds before its new
 * record: the old entry lives in `shared`, so if the new value lands in
 * `private` (a raise), a device that holds only `shared` sees the entry
 * go rather than keep reading the old value. Nothing when no shared entry
 * is replaced; the append drops it when the new value stays in `shared`.
 */
function replacedShared(vault: string, path: string): DualWriteRecord[] {
  if (!isLaneEntryPath(vault, path)) return [];
  const prior = storeEntry(vault, path);
  return prior !== null && !livesInPrivate(prior) ? [tombstoneOf(prior, true)] : [];
}

/** An entry's fields as a fresh map: a caller may edit what it reads. */
function fieldsCopy(value: LaneEntryValue): FrontmatterMap {
  return structuredClone(value.fields) as FrontmatterMap;
}

/** Whether `value` already holds exactly these fields and text. */
function sameEntry(
  value: LaneEntryValue | null,
  fields: Readonly<Record<string, unknown>>,
  text: string,
): boolean {
  return (
    value !== null && value.text === text && canonicalJson(value.fields) === canonicalJson(fields)
  );
}

function authorityFor(lane: string): Authority {
  return lane === STANDING_RULE_LANE ? "human" : authorityFromOrigin();
}

function isPrivateEntry(
  vault: string,
  fields: Readonly<Record<string, unknown>>,
  text: string,
): boolean {
  return (
    isPrivateFrontmatter(fields) ||
    rowNamesPrivatePage(existsSync(vault) ? vault : null, { fields, text }, PAGE_OPAQUE_FIELDS)
  );
}

function entryRecord(
  vault: string,
  path: string,
  fields: Readonly<Record<string, unknown>>,
  text: string,
  isPrivate: boolean,
  /**
   * `located`: `isPrivate` is where an existing entry lives (a move), and
   * the record stays there; the lane's private-when-held rule would send
   * a shared entry's move, its tombstone included, to `private`, where a
   * device without that partition never sees the old entry removed.
   */
  placement: "judged" | "located" = "judged",
): DualWriteRecord {
  const { lane, entry } = placeOf(vault, path);
  const agent =
    typeof fields["agent"] === "string" && fields["agent"].trim() !== ""
      ? fields["agent"].trim()
      : undefined;
  return laneEntryRecord({
    lane,
    entry,
    fields,
    text,
    authority: authorityFor(lane),
    ...(agent !== undefined ? { agent } : {}),
    private: isPrivate,
    // The lanes the migration imports as blobs are private wherever this
    // machine holds the private partition (`surface-map.ts` `blobLane`).
    ...(placement === "judged" && PRIVATE_WHEN_HELD_LANES.has(lane)
      ? { privateWhenHeld: true }
      : {}),
  });
}

/** Lanes whose records go to `private` whenever this machine holds it. */
const PRIVATE_WHEN_HELD_LANES: ReadonlySet<string> = new Set(["source-archive"]);

// ----- Reads --------------------------------------------------------------------

/** One lane page as a lane module reads it. */
export interface LanePage {
  /** Absolute path of the page (a legacy path; no file on a store-only machine). */
  readonly path: string;
  readonly frontmatter: FrontmatterMap;
  readonly body: string;
}

/**
 * Whether the lane file at `path` exists, or, for a lane folder, whether
 * any entry lives below it (what `existsSync` answers for a directory).
 */
export function lanePageExists(vault: string, path: string): boolean {
  if (!heldInStore(vault, path)) return existsSync(path);
  const rel = brainRelOf(vault, path);
  if (rel === "" || rel.startsWith("..")) return false;
  if (lanePlaceOf(rel) !== null && storeEntry(vault, path) !== null) return true;
  const prefix = `${rel}/`;
  for (const value of storeEntries().values()) {
    if (brainRelOfEntry(value.lane, value.entry).startsWith(prefix)) return true;
  }
  return false;
}

/** The page at `path`, or null when there is none. Throws on a legacy page that cannot be read. */
export function readLanePage(vault: string, path: string): LanePage | null {
  if (heldInStore(vault, path)) {
    const value = storeEntry(vault, path);
    return value === null ? null : { path, frontmatter: fieldsCopy(value), body: value.text };
  }
  if (!existsSync(path)) return null;
  const [frontmatter, body] = parseFrontmatterText(readFileSync(path, "utf8"));
  return { path, frontmatter, body };
}

/**
 * `parseFrontmatter(path)` for a lane page: its frontmatter and body, read
 * from the fold on a store-only machine. A page that is not there reads as
 * an empty map and body, as the legacy parser answers an absent file.
 */
export function parseLanePage(vault: string, path: string): readonly [FrontmatterMap, string] {
  if (!heldInStore(vault, path)) return parseFrontmatter(path);
  const value = storeEntry(vault, path);
  return value === null ? [{}, ""] : [fieldsCopy(value), value.text];
}

/**
 * The write lock of the lane file at `path`, as `acquireLockSyncWithRetry`
 * hands it: the legacy lockfile beside the page on an unswitched machine,
 * a device-local lock on a store-only one (no lock file in the vault).
 */
export function acquireLaneLock(
  vault: string,
  path: string,
  options: { readonly budgetMs?: number } = {},
): { release(): void } {
  if (!heldInStore(vault, path)) {
    return options.budgetMs === undefined
      ? acquireLockSyncWithRetry(path)
      : acquireLockSyncWithRetry(path, options.budgetMs);
  }
  const target = laneLockTarget(path);
  mkdirSync(dirname(target), { recursive: true });
  const release = acquireDirLock(target, {
    staleMs: STORE_LOCK_STALE_MS,
    budgetMs: options.budgetMs ?? 10_000,
    label: "lane page lock",
    remedy: "retry once the other writer finishes",
  });
  return { release };
}

/**
 * Run `fn` holding the write lock of the lane file at `path`: the legacy
 * lockfile beside it on an unswitched machine (`sync-lockfile.ts`), a
 * device-local lock keyed by the path on a store-only one, so no lock file
 * lands in the vault.
 */
export function withLaneLock<T>(vault: string, path: string, fn: () => T): T {
  if (!heldInStore(vault, path)) {
    const handle = acquireLockSyncWithRetry(path);
    try {
      return fn();
    } finally {
      handle.release();
    }
  }
  return withLocalLock(laneLockTarget(path), fn);
}

/**
 * The raw text of a lane file, as `readFileSync(path, "utf8")` reads it:
 * a missing file throws an `ENOENT` error, so a caller's own missing-file
 * handling (a named refusal, a skipped row) keeps working in both modes.
 */
export function readLaneFile(vault: string, path: string): string {
  if (!heldInStore(vault, path)) return readFileSync(path, "utf8");
  const text = readLaneText(vault, path);
  if (text !== null) return text;
  const error = new Error(`ENOENT: no such lane file, open '${path}'`) as NodeJS.ErrnoException;
  error.code = "ENOENT";
  throw error;
}

/**
 * The byte size of the lane file at `path`: the file's size on an
 * unswitched machine (throwing for a missing path or one that is not a
 * regular file, as a `statSync` walk would skip it), the UTF-8 length of
 * the entry's text on a store-only one.
 */
export function laneFileBytes(vault: string, path: string): number {
  if (!heldInStore(vault, path)) {
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error(`not a regular file: ${path}`);
    return stat.size;
  }
  return Buffer.byteLength(readLaneFile(vault, path), "utf8");
}

/** The raw text of a lane file (a page, or a JSON or text file), or null. */
export function readLaneText(vault: string, path: string): string | null {
  if (heldInStore(vault, path)) {
    const value = storeEntry(vault, path);
    if (value === null) return null;
    if (path.endsWith(".md")) return formatFrontmatter(value.fields as FrontmatterMap, value.text);
    return path.endsWith(".json") && value.text === ""
      ? `${JSON.stringify(value.fields, null, 2)}\n`
      : value.text;
  }
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/**
 * The names of the lane files directly in `dir` that end in `ext`, sorted:
 * what `readdirSync(dir).filter(...)` gives on an unswitched machine.
 */
export function listLaneFiles(vault: string, dir: string, ext = ".md"): string[] {
  if (!heldInStore(vault, dir)) {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith(ext))
      .toSorted();
  }
  const names: string[] = [];
  const prefix = brainRelOf(vault, dir);
  for (const value of storeEntries().values()) {
    const rel = brainRelOfEntry(value.lane, value.entry);
    const slash = rel.lastIndexOf("/");
    const parent = slash === -1 ? "" : rel.slice(0, slash);
    if (parent !== prefix || !rel.endsWith(ext)) continue;
    names.push(basename(rel));
  }
  return names.toSorted();
}

/**
 * The vault (or lane root) an absolute `Brain/` path was built under: the
 * part before its last `Brain` segment. For a reader handed only a page
 * path (an entity record's `path`), so it can read the page in both modes.
 */
export function vaultOfBrainPath(path: string): string {
  const parts = path.split(sep);
  const at = parts.lastIndexOf(BRAIN_ROOT_REL);
  return at <= 0 ? dirname(path) : parts.slice(0, at).join(sep) || sep;
}

/**
 * Store-only machine: the absolute paths of every lane file below `dir`, at
 * any depth, sorted (the store has no directories; a folder is a path
 * prefix). An unswitched machine walks its own tree, so this answers `[]`
 * there and the caller keeps its legacy walk.
 */
export function listLaneTree(vault: string, dir: string, ext = ".md"): string[] {
  if (!heldInStore(vault, dir)) return [];
  const prefix = brainRelOf(vault, dir);
  const brain = join(laneVaultRoot(vault), BRAIN_ROOT_REL);
  const out: string[] = [];
  for (const value of storeEntries().values()) {
    const rel = brainRelOfEntry(value.lane, value.entry);
    if (!rel.startsWith(prefix === "" ? "" : `${prefix}/`) || !rel.endsWith(ext)) continue;
    // The fold already refuses an entry id that is no record path; this
    // keeps a path outside `Brain/` out of every reader (and remover) of
    // the list even if that check is ever loosened (FORMAT.md, Trust).
    const path = containedRecordPath(brain, rel);
    if (path !== null) out.push(path);
  }
  return out.toSorted();
}

/**
 * A change stamp of the lane entries a store-only machine reads: it moves
 * whenever a lane record lands, so a reader's memo (the entity index) keyed
 * by it never serves a stale build. Empty on an unswitched machine.
 */
export function laneStoreStamp(vault: string): string {
  if (!lanePagesInStore(vault)) return "";
  const store = configuredStore();
  return store === null ? "" : laneFingerprintOf(store);
}

// ----- Writes -------------------------------------------------------------------

/**
 * Write the page at `path` (frontmatter and body), with the options
 * `writeFrontmatterAtomic` takes. `overwrite: false` refuses a page that
 * exists with a `FileAlreadyExistsError`, so a slug allocation ladder
 * (`allocateAndCreate`) works the same in both modes. Returns whether
 * anything was written.
 */
export function writeLanePage(
  vault: string,
  path: string,
  frontmatter: FrontmatterMap,
  body: string,
  opts: WriteFrontmatterAtomicOptions = {},
): boolean {
  let written = true;
  // An overwrite with what the entry already holds writes nothing, as the
  // legacy writer skips a byte-identical file: a page re-rendered on every
  // run must not grow the shards or move the entry's clock.
  if (opts.overwrite === true && heldInStore(vault, path)) {
    if (sameEntry(storeEntry(vault, path), frontmatter, body)) return false;
  }
  const replaced = opts.overwrite === true && legacyPagePrivate(vault, path);
  withCreateLock(vault, path, opts.overwrite !== true, opts.existsErrorKind, () =>
    routeLaneWrite(vault, path, {
      legacy: () => {
        mkdirSync(dirname(path), { recursive: true });
        written = writeFrontmatterAtomic(path, frontmatter, body, opts);
      },
      store: () => [
        ...replacedShared(vault, path),
        entryRecord(
          vault,
          path,
          frontmatter,
          body,
          replaced || storedEntryPrivate(vault, path) || isPrivateEntry(vault, frontmatter, body),
        ),
      ],
      context: context(vault),
    }),
  );
  return written;
}

/**
 * Write a lane file whole from its text: a page (`.md`, its frontmatter
 * and body are split into the entry's fields and text), a JSON file (its
 * object becomes the fields) or any other text. With `exclusive`, a file
 * that exists is refused with a `FileAlreadyExistsError` in both modes.
 */
export function writeLaneText(
  vault: string,
  path: string,
  text: string,
  opts: { readonly exclusive?: boolean } = {},
): void {
  if (opts.exclusive !== true && heldInStore(vault, path)) {
    const { fields, body } = laneTextParts(path, text);
    if (sameEntry(storeEntry(vault, path), fields, body)) return;
  }
  const replaced = opts.exclusive !== true && legacyPagePrivate(vault, path);
  withCreateLock(vault, path, opts.exclusive === true, undefined, () =>
    routeLaneWrite(vault, path, {
      legacy: () => {
        mkdirSync(dirname(path), { recursive: true });
        if (opts.exclusive === true) atomicCreateFileSyncExclusive(path, text);
        else atomicWriteFileSync(path, text);
      },
      store: () => {
        const { fields, body } = laneTextParts(path, text);
        return [
          ...replacedShared(vault, path),
          entryRecord(
            vault,
            path,
            fields,
            body,
            replaced || storedEntryPrivate(vault, path) || isPrivateEntry(vault, fields, body),
          ),
        ];
      },
      context: context(vault),
    }),
  );
}

/**
 * Whether a write to `path` replaces a private lane entry (design D14, one
 * verdict per operation, fail closed). Such an entry stays private whatever
 * the new content says: an overwrite that drops the visibility field must
 * never land the entry's text in `shared`. Nothing lowers an entry's
 * partition; an operator who wants it shared removes it and writes it anew.
 *
 * Two halves, because on an unswitched machine the legacy file is replaced
 * before the dual-write record is built:
 *  - {@link legacyPagePrivate}, read before the write: the legacy page's
 *    own frontmatter (an unswitched machine only; a legacy page has no
 *    partition).
 *  - {@link storedEntryPrivate}, read when the record is built: the live
 *    store entry lives in `private` or its fields reserve it.
 */
function legacyPagePrivate(vault: string, path: string): boolean {
  if (!isLaneEntryPath(vault, path) || heldInStore(vault, path) || !existsSync(path)) return false;
  try {
    return isPrivateFrontmatter(laneTextParts(path, readFileSync(path, "utf8")).fields);
  } catch {
    // A page that exists but cannot be read cannot be judged: fail closed.
    return true;
  }
}

/**
 * See {@link legacyPagePrivate}. While the fold misses a shard, the entry
 * may be private in it: the write is judged private (on a machine without
 * the `private` partition, refused).
 */
function storedEntryPrivate(vault: string, path: string): boolean {
  if (!isLaneEntryPath(vault, path)) return false;
  if (foldIncomplete()) return true;
  const value = storeEntry(vault, path);
  return value !== null && (livesInPrivate(value) || isPrivateFrontmatter(value.fields));
}

function isLaneEntryPath(vault: string, path: string): boolean {
  return insideBrain(vault, path) && lanePlaceOf(brainRelOf(vault, path)) !== null;
}

/**
 * A lane file's text as an entry's fields and text: a page's frontmatter
 * and body, a JSON object as the fields, anything else (malformed JSON
 * included, which the legacy writer also writes as it is) as text.
 */
function laneTextParts(
  path: string,
  text: string,
): { fields: Record<string, unknown>; body: string } {
  if (path.endsWith(".md")) {
    const [frontmatter, rest] = parseFrontmatterText(text);
    return { fields: frontmatter, body: rest };
  }
  if (path.endsWith(".json")) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { fields: {}, body: text };
    }
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { fields: parsed as Record<string, unknown>, body: "" };
    }
  }
  return { fields: {}, body: text };
}

/**
 * Run a create-once write of `path` under a device-local create lock on a
 * store-only machine, so the existence check and the record append are one
 * step: of two writers racing for one entry, one creates it and the other
 * gets the `FileAlreadyExistsError` the unswitched path's exclusive create
 * gives. An unswitched machine needs no lock (its create is a hardlink),
 * and an overwrite takes none. The lock is keyed apart from the page lock,
 * so a caller holding `withLaneLock` on the same page does not deadlock.
 */
function withCreateLock(
  vault: string,
  path: string,
  createOnce: boolean,
  existsKind: string | undefined,
  fn: () => void,
): void {
  if (!createOnce || !heldInStore(vault, path)) {
    fn();
    return;
  }
  withLocalLock(laneLockTarget(path, "create\u0000"), () => {
    // Checked outside the store write, so the refusal reaches the caller as
    // the same `FileAlreadyExistsError` (EEXIST) the unswitched path throws.
    if (storeEntry(vault, path) !== null) {
      throw new FileAlreadyExistsError(path, {
        ...(existsKind !== undefined ? { kind: existsKind } : {}),
        displayPath: brainRelOf(vault, path),
      });
    }
    fn();
  });
}

/**
 * Remove the page at `path`; a page that is not there is a no-op. Returns
 * whether this call removed it (`false` when it was already gone, a lost
 * race with another remover included).
 */
export function removeLanePage(vault: string, path: string): boolean {
  if (heldInStore(vault, path)) {
    const value = storeEntry(vault, path);
    if (value === null) return false;
    // In the partition the entry lives in, never re-judged from its
    // content now: a shared entry's tombstone must reach every device.
    const isPrivate = livesInPrivate(value);
    withOperationPrivacy(isPrivate, () => storeWrite(() => tombstoneOf(value), context(vault)));
    return true;
  }
  guardUserVaultWrite(vault, path);
  try {
    rmSync(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Move the page at `from` to `to` (an archive move), optionally rewritten
 * to `rewrite`'s frontmatter and body on the way (a reject that retires a
 * staged page). One operation: on a store-only machine the old entry's
 * tombstone and the new entry are written together: the tombstone in the
 * partition the entry lives in, the new entry there too, or in `private`
 * when the rewritten page is private.
 * On an unswitched machine a plain move is a rename; a rewrite writes the
 * new page (refusing one that exists) and then removes the old one.
 */
export function moveLanePage(
  vault: string,
  from: string,
  to: string,
  rewrite?: { readonly frontmatter: FrontmatterMap; readonly body: string },
): void {
  if (!heldInStore(vault, from)) {
    if (rewrite !== undefined) {
      writeLanePage(vault, to, rewrite.frontmatter, rewrite.body, {
        overwrite: false,
        vaultForRelativePath: vault,
      });
      removeLanePage(vault, from);
      return;
    }
    guardUserVaultWrite(vault, from);
    mkdirSync(dirname(to), { recursive: true });
    renameWithRetry(from, to);
    return;
  }
  const value = storeEntry(vault, from);
  if (value === null) throw new Error(`no lane page to move: ${from}`);
  // The tombstone stays where the entry lives: it must reach every device
  // that saw the entry. The new entry stays there too, unless a rewrite
  // whose page is private raises it to `private`, as does a fold that
  // misses a shard (the entry may have been raised in it).
  const isPrivate =
    livesInPrivate(value) ||
    foldIncomplete() ||
    (rewrite !== undefined && isPrivateEntry(vault, rewrite.frontmatter, rewrite.body));
  withOperationPrivacy(isPrivate, () =>
    storeWrite(
      () => [
        tombstoneOf(value),
        entryRecord(
          vault,
          to,
          rewrite?.frontmatter ?? value.fields,
          rewrite?.body ?? value.text,
          isPrivate,
          "located",
        ),
      ],
      context(vault),
    ),
  );
}

// ----- Folders of lane files (dream bundles) ------------------------------------

/**
 * The names of the folders directly below `dir` that hold lane files: the
 * subdirectories on an unswitched machine, the first path segments of the
 * entries below `dir` on a store-only one (the store has no directories).
 */
export function listLaneDirs(vault: string, dir: string): string[] {
  if (!heldInStore(vault, dir)) {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .toSorted();
  }
  const names = new Set<string>();
  for (const path of listLaneTree(vault, dir, "")) {
    const rest = relative(dir, path).split(sep);
    if (rest.length > 1) names.add(rest[0]!);
  }
  return [...names].toSorted();
}

/**
 * Move the folder `from` (every lane file below it) to `to`. A rename on an
 * unswitched machine; on a store-only one each entry's tombstone and its
 * new entry, all in one store write, each in the entry's own partition.
 */
export function moveLaneTree(vault: string, from: string, to: string): void {
  if (!heldInStore(vault, from)) {
    guardUserVaultWrite(vault, from);
    mkdirSync(dirname(to), { recursive: true });
    renameWithRetry(from, to);
    return;
  }
  const moves = listLaneTree(vault, from, "").map((path) => {
    const value = storeEntry(vault, path)!;
    return { value, target: join(to, relative(from, path)) };
  });
  if (moves.length === 0) return;
  // One store write, but every entry is placed by itself (design D14 item
  // 18): a shared entry and its tombstone stay in `shared`, so a device
  // that holds only `shared` sees it leave the folder, and a private
  // entry's text never reaches `shared`. An enclosing private operation
  // still raises the moved entries, never their tombstones.
  storeWrite(
    () =>
      moves.flatMap(({ value, target }) => {
        const partition = partitionOf(value);
        return [
          {
            ...entryRecord(
              vault,
              target,
              value.fields,
              value.text,
              partition === "private",
              "located",
            ),
            located: { partition, content: true },
          },
          tombstoneOf(value),
        ];
      }),
    context(vault),
  );
}

/** Remove the folder `dir` and every lane file below it; absent is a no-op. */
export function removeLaneTree(vault: string, dir: string): void {
  if (!heldInStore(vault, dir)) {
    guardUserVaultWrite(vault, dir);
    rmSync(dir, { recursive: true, force: true });
    return;
  }
  // One store write, so a folder is never half removed; each tombstone in
  // the partition its entry lives in, so a device that holds only `shared`
  // sees the folder's shared entries go.
  const values = listLaneTree(vault, dir, "").map((path) => storeEntry(vault, path)!);
  if (values.length === 0) return;
  storeWrite(() => values.map((value) => tombstoneOf(value)), context(vault));
}
