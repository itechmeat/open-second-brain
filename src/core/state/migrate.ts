/**
 * Moving a vault's state to another place, and putting it back.
 *
 * `surfaces.ts` answers where the state IS. This module is the one
 * operation that changes that answer, and it is the operation in this
 * project with the worst failure mode: bytes that exist in neither the
 * old location nor the new one are gone, and half the declared surfaces
 * are `vault-content`, which by definition does not rebuild.
 *
 * Two decisions follow from that and shape everything below.
 *
 * ## Fail BEFORE commit, not on first sight
 *
 * {@link planStateMigration} runs every check and returns ALL of them.
 * It never short-circuits on the first refusal, and it never touches the
 * filesystem. An operator who fixes a symlink only to be told about a
 * held writer lock, then about a full disk, learns their vault's
 * problems one interrupted migration at a time; the whole plan is
 * rejected at once instead, and {@link applyStateMigration} refuses to
 * run a plan carrying any refusal at all.
 *
 * Within the apply itself the same rule holds one level down. Every file
 * is COPIED and its landed bytes re-digested before ANY source byte is
 * removed. A copy that fails half way unwinds the copies it made and
 * leaves the source exactly as it found it; only once the whole tree has
 * landed and verified does the removal pass run. A move implemented as
 * per-file rename would be faster and would also be the shape that
 * strands a tree across two directories.
 *
 * ## Put back only what is still the same
 *
 * {@link planStateRollback} restores what the manifest binds AND whose
 * digest still matches. Anything else - a file edited at the destination
 * since the migration, a file the manifest names that is no longer
 * there, a source path that has diverged - is REFUSED BY NAME and left
 * exactly where it is. Nothing this module can do makes an operator's
 * later edit recoverable, so the one thing it must never do is delete
 * it. The refusals are part of the returned value rather than a warning
 * on stderr, which is what lets the CLI make them part of its exit code.
 *
 * ## What the manifest binds
 *
 * Through {@link sha256Hex} and {@link canonicalJson}, the one digest
 * encoding in this project: the source type, the canonical roots, the
 * full path inventory, a byte count per file and a SHA-256 per file, and
 * a digest over all of it. A manifest that does not verify is refused
 * rather than repaired - a rollback driven by a manifest somebody edited
 * is a restore of something nobody measured.
 *
 * ## What this module does NOT enumerate
 *
 * It has no list of state locations. Every path it touches comes from
 * {@link inventoryStateSurfaces}, so a surface added to `surfaces.ts`
 * moves without a second edit here, and a surface this module could move
 * but the inventory does not declare cannot exist.
 */

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  rmdirSync,
  statfsSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { canonicalJson, DIGEST_ALGORITHM, sha256Hex } from "../integrity/digest.ts";
import { isWriterLockHeld } from "../search/store/writer-lock.ts";
import {
  inventoryStateSurfaces,
  STATE_REACHABILITY,
  STATE_SURFACE_ID,
  type StateInventoryInput,
  type StateSurfaceId,
} from "./surfaces.ts";

// ----- Vocabularies ---------------------------------------------------------

/** The manifest file a migration leaves at its destination. */
export const MIGRATION_MANIFEST_FILE = "state-migration.json";

/** The manifest layout this build writes and is willing to read back. */
export const MIGRATION_MANIFEST_SCHEMA_VERSION = 1;

/**
 * What a migration was taken FROM.
 *
 * One member today, and a field rather than an assumption for the same
 * reason `schema_version` is: a manifest is read back by a later build,
 * and a build that cannot name the shape it is looking at cannot refuse
 * a shape it does not understand. {@link planStateRollback} checks it,
 * so the field has a job rather than a plan to have one.
 */
export const MIGRATION_SOURCE_TYPE = Object.freeze({ vault: "vault" } as const);

export type MigrationSourceType =
  (typeof MIGRATION_SOURCE_TYPE)[keyof typeof MIGRATION_SOURCE_TYPE];

/**
 * Why a migration will not run.
 *
 * Closed, because every member is a distinct repair: the operator who
 * hits `symlink` resolves a link, the one who hits `writer_lock_held`
 * waits for an index write, and folding them into one "cannot migrate"
 * would make the difference something they have to read prose to find.
 */
export const MIGRATION_REFUSAL = Object.freeze({
  symlink: "symlink",
  specialFile: "special_file",
  destinationOccupied: "destination_occupied",
  insufficientSpace: "insufficient_space",
  reservedNamespace: "reserved_namespace",
  writerLockHeld: "writer_lock_held",
  unreadableSurface: "unreadable_surface",
} as const);

export type MigrationRefusalCode = (typeof MIGRATION_REFUSAL)[keyof typeof MIGRATION_REFUSAL];

/** Why a rollback will not put one entry back. */
export const ROLLBACK_REFUSAL = Object.freeze({
  digestMismatch: "digest_mismatch",
  missingAtDestination: "missing_at_destination",
  sourceDiverged: "source_diverged",
  unreadable: "unreadable",
} as const);

export type RollbackRefusalCode = (typeof ROLLBACK_REFUSAL)[keyof typeof ROLLBACK_REFUSAL];

/** Raised for a condition the caller cannot plan around. Always names the remedy. */
export class StateMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateMigrationError";
  }
}

// ----- The manifest ---------------------------------------------------------

/** One file the migration binds. */
export interface MigrationEntry {
  /** Vault-relative, POSIX-separated, so a manifest survives a copy between hosts. */
  readonly relative_path: string;
  readonly bytes: number;
  readonly digest: string;
}

/** Everything a rollback needs, bound by one digest. */
export interface MigrationManifest {
  readonly schema_version: number;
  readonly algorithm: string;
  readonly source_type: MigrationSourceType;
  readonly source_root: string;
  readonly destination_root: string;
  /**
   * The minimal set of vault-relative directories covering every moved
   * file: a declared surface nested inside another is absorbed by the
   * one that contains it, so no byte is bound twice.
   */
  readonly canonical_roots: ReadonlyArray<string>;
  readonly entries: ReadonlyArray<MigrationEntry>;
  readonly total_bytes: number;
  readonly created_at: string;
  /** `sha256Hex(canonicalJson(<this object without this field>))`. */
  readonly digest: string;
}

/** Bind a manifest body to its digest. The one place either is computed. */
function sealManifest(body: Omit<MigrationManifest, "digest">): MigrationManifest {
  return { ...body, digest: sha256Hex(canonicalJson(body)) };
}

/** Whether a manifest's digest still describes its body. */
function manifestVerifies(manifest: MigrationManifest): boolean {
  const { digest, ...body } = manifest;
  return sha256Hex(canonicalJson(body)) === digest;
}

// ----- Planning a migration -------------------------------------------------

/** What was found, and what to do about it. Never one without the other. */
export interface MigrationRefusal {
  readonly code: MigrationRefusalCode;
  /** The absolute path the refusal is about. */
  readonly path: string;
  readonly found: string;
  readonly remedy: string;
}

/** A declared surface that resolved OUTSIDE the vault, and is therefore not moved. */
export interface ExternalSurface {
  readonly id: StateSurfaceId;
  readonly label: string;
  readonly path: string;
  readonly reason: string;
}

export interface MigrationPlan {
  readonly source: string;
  readonly destination: string;
  readonly manifest: MigrationManifest;
  /** Empty exactly when the plan may be applied. */
  readonly refusals: ReadonlyArray<MigrationRefusal>;
  /** Surfaces an override put outside the vault; they stay where they are. */
  readonly external: ReadonlyArray<ExternalSurface>;
}

export interface MigrationPlanInput extends StateInventoryInput {
  /** Where the state is to be moved to. Created by the apply, never by the plan. */
  readonly destination: string;
  /** Timestamp the manifest records. Injected so a manifest is reproducible in tests. */
  readonly now?: Date;
  /**
   * Free bytes at a path. Injected only by tests, which cannot fill a
   * disk; the product uses `statfsSync` on the nearest existing ancestor.
   */
  readonly freeBytesAt?: (path: string) => number;
  /**
   * Whether the search writer lock is held. Injected only by tests - the
   * product asks `isWriterLockHeld`, and a throw from it is a refusal
   * rather than a `false`, exactly as that module's contract requires.
   */
  readonly writerLockHeldAt?: (dbPath: string) => boolean;
}

/**
 * Everything that must be true before a single byte moves.
 *
 * Reads the filesystem and writes nothing. The returned plan is the whole
 * answer: an empty {@link MigrationPlan.refusals} is the only licence
 * {@link applyStateMigration} accepts.
 */
export function planStateMigration(input: MigrationPlanInput): MigrationPlan {
  const source = resolve(input.vault);
  const destination = resolve(input.destination);
  const inventory = inventoryStateSurfaces({ ...input, vault: source });

  const refusals: MigrationRefusal[] = [];
  const external: ExternalSurface[] = [];
  const inVaultRoots = new Map<string, StateSurfaceId>();

  for (const surface of inventory.surfaces) {
    if (surface.reachability.state === STATE_REACHABILITY.unchecked) {
      refusals.push({
        code: MIGRATION_REFUSAL.unreadableSurface,
        path: surface.path,
        found: `the ${surface.label} ${surface.reachability.reason ?? "could not be probed"}`,
        remedy:
          "a surface this run cannot read is a surface it cannot move, and moving the rest " +
          "would leave it behind without saying so; make the path readable to this user, or " +
          "run the migration as the user that owns it",
      });
      continue;
    }
    if (surface.reachability.state !== STATE_REACHABILITY.present) continue;
    const rel = vaultRelative(source, surface.path);
    if (rel === null) {
      external.push({
        id: surface.id,
        label: surface.label,
        path: surface.path,
        reason:
          `an override placed it outside ${source}, so migrating the vault does not move it; ` +
          "it stays where it was put",
      });
      continue;
    }
    inVaultRoots.set(rel, surface.id);
  }

  const canonicalRoots = collapseNested([...inVaultRoots.keys()]);

  const entries: MigrationEntry[] = [];
  for (const root of canonicalRoots) collect(source, root, entries, refusals);
  entries.sort((a, b) => (a.relative_path < b.relative_path ? -1 : 1));
  const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);

  refusals.push(...reservedNamespaceRefusals(source, destination));
  const occupied = destinationRefusal(destination);
  if (occupied !== null) refusals.push(occupied);
  const space = spaceRefusal(destination, totalBytes, input.freeBytesAt ?? freeBytesAt);
  if (space !== null) refusals.push(space);
  const lock = writerLockRefusal(
    inventory.surfaces.find((s) => s.id === STATE_SURFACE_ID.searchIndex)?.path ?? null,
    input.writerLockHeldAt ?? isWriterLockHeld,
  );
  if (lock !== null) refusals.push(lock);

  return {
    source,
    destination,
    manifest: sealManifest({
      schema_version: MIGRATION_MANIFEST_SCHEMA_VERSION,
      algorithm: DIGEST_ALGORITHM,
      source_type: MIGRATION_SOURCE_TYPE.vault,
      source_root: source,
      destination_root: destination,
      canonical_roots: canonicalRoots,
      entries,
      total_bytes: totalBytes,
      created_at: (input.now ?? new Date()).toISOString(),
    }),
    refusals,
    external,
  };
}

/**
 * `path` as a vault-relative POSIX path, or `null` when it is not inside
 * the vault at all. The vault itself is `null` too: a surface that
 * resolved to the vault root would drag the whole tree in.
 */
function vaultRelative(vault: string, path: string): string | null {
  const rel = relative(vault, resolve(path));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

/** Absolute path for a vault-relative POSIX path. */
function absolute(root: string, rel: string): string {
  return join(root, ...rel.split("/"));
}

/** Drop every path that lies under another one in the same set, then sort. */
function collapseNested(paths: ReadonlyArray<string>): string[] {
  return paths
    .filter((candidate) => !paths.some((other) => candidate.startsWith(`${other}/`)))
    .toSorted();
}

/**
 * Every file under one canonical root, refusing anything that is not a
 * plain file or a directory.
 *
 * `lstatSync`, never `statSync`: a symlink is refused for what it IS, and
 * a `statSync` here would follow it and copy the target's bytes into the
 * destination under the link's name - which is a silent change of meaning
 * rather than a move.
 */
function collect(
  source: string,
  rel: string,
  entries: MigrationEntry[],
  refusals: MigrationRefusal[],
): void {
  const path = absolute(source, rel);
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    refusals.push({
      code: MIGRATION_REFUSAL.unreadableSurface,
      path,
      found: `could not be read (${err.code ?? "unknown error"}): ${err.message}`,
      remedy:
        "make the path readable to this user before migrating; a tree this run cannot " +
        "enumerate cannot be bound by a manifest, and an unbound file is not restorable",
    });
    return;
  }

  if (stat.isSymbolicLink()) {
    refusals.push({
      code: MIGRATION_REFUSAL.symlink,
      path,
      found: `a symbolic link to ${readLinkTarget(path)}`,
      remedy:
        "a migration copies bytes, so a link would arrive pointing at the OLD location and " +
        "the target would silently stay behind; replace the link with the file it names, or " +
        "move its target out of the state tree, then plan again",
    });
    return;
  }
  if (stat.isDirectory()) {
    for (const child of readdirSync(path).toSorted()) {
      collect(source, `${rel}/${child}`, entries, refusals);
    }
    return;
  }
  if (!stat.isFile()) {
    refusals.push({
      code: MIGRATION_REFUSAL.specialFile,
      path,
      found: `a ${specialFileKind(stat)}, which has no bytes to copy`,
      remedy:
        "remove it from the state tree, or recreate it at the destination after the " +
        "migration; copying it would produce a plain file that only looks like the original",
    });
    return;
  }

  const body = readFileSync(path);
  entries.push({ relative_path: rel, bytes: body.byteLength, digest: sha256Hex(body) });
}

function readLinkTarget(path: string): string {
  try {
    return readlinkSync(path);
  } catch {
    return "a target this run could not read";
  }
}

/** What kind of non-file this is, in the words `stat(2)` uses for it. */
function specialFileKind(stat: Stats): string {
  if (stat.isFIFO()) return "FIFO (named pipe)";
  if (stat.isSocket()) return "socket";
  if (stat.isBlockDevice()) return "block device";
  if (stat.isCharacterDevice()) return "character device";
  return "file of an unrecognised type";
}

/**
 * Destinations a migration will not write into.
 *
 * The two nesting arms are the ones that corrupt rather than merely
 * surprise: a destination inside the vault is copied INTO the tree being
 * walked, and a destination containing the vault makes every source path
 * a child of the target. The other two are namespaces nobody dedicates to
 * one tool: scattering forty state locations across `$HOME` or `/` is not
 * undoable by reading a manifest.
 */
function reservedNamespaceRefusals(source: string, destination: string): MigrationRefusal[] {
  const out: MigrationRefusal[] = [];
  const push = (found: string, remedy: string): void => {
    out.push({ code: MIGRATION_REFUSAL.reservedNamespace, path: destination, found, remedy });
  };
  if (destination === source || destination.startsWith(`${source}${sep}`)) {
    push(
      `a path inside the vault being migrated (${source})`,
      "name a destination outside the vault; copying the state tree into itself would " +
        "recurse into the copy it is making",
    );
  } else if (source.startsWith(`${destination}${sep}`)) {
    push(
      `an ancestor of the vault being migrated (${source})`,
      "name a destination that does not contain the vault; every source path is already " +
        "below it, so the move has no direction",
    );
  }
  if (dirname(destination) === destination) {
    push(
      "the filesystem root",
      "name a directory dedicated to this vault's state; state written at the root is " +
        "indistinguishable from everything else there",
    );
  }
  if (destination === resolve(homedir())) {
    push(
      `the home directory itself (${destination})`,
      "name a subdirectory of the home directory instead, so the state stays one tree an " +
        "operator can move, back up, or delete as a unit",
    );
  }
  return out;
}

/** A destination that already holds content is refused rather than merged into. */
function destinationRefusal(destination: string): MigrationRefusal | null {
  let stat: Stats;
  try {
    stat = lstatSync(destination);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return null;
    return {
      code: MIGRATION_REFUSAL.destinationOccupied,
      path: destination,
      found: `could not be examined (${err.code ?? "unknown error"}): ${err.message}`,
      remedy:
        "a destination this run cannot look at cannot be shown to be empty; fix the " +
        "permissions on it, or name one that does not exist yet",
    };
  }
  if (!stat.isDirectory()) {
    return {
      code: MIGRATION_REFUSAL.destinationOccupied,
      path: destination,
      found: "an existing non-directory",
      remedy: "name an empty directory, or a path that does not exist yet",
    };
  }
  const children = readdirSync(destination).toSorted();
  if (children.length === 0) return null;
  return {
    code: MIGRATION_REFUSAL.destinationOccupied,
    path: destination,
    found: `${children.length} existing ${children.length === 1 ? "entry" : "entries"} (${children.join(", ")})`,
    remedy:
      "name an empty directory. Merging into an occupied one would make the manifest " +
      "unable to say which files this migration put there, and a rollback would have to " +
      "guess",
  };
}

/** Free bytes on the filesystem holding the nearest existing ancestor of `path`. */
function freeBytesAt(path: string): number {
  let at = resolve(path);
  while (!existsSync(at)) {
    const parent = dirname(at);
    if (parent === at) break;
    at = parent;
  }
  const stat = statfsSync(at);
  return Number(stat.bsize) * Number(stat.bavail);
}

function spaceRefusal(
  destination: string,
  needed: number,
  probe: (path: string) => number,
): MigrationRefusal | null {
  let free: number;
  try {
    free = probe(destination);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    return {
      code: MIGRATION_REFUSAL.insufficientSpace,
      path: destination,
      found: `free space could not be measured (${err.code ?? "unknown error"}): ${err.message}`,
      remedy:
        "a migration that runs out of space mid-copy is the case this check exists for, so " +
        "an unmeasurable filesystem is refused rather than attempted; name a destination on " +
        "a filesystem this user can stat",
    };
  }
  if (free >= needed) return null;
  return {
    code: MIGRATION_REFUSAL.insufficientSpace,
    path: destination,
    found: `${bytesPhrase(free)} available at the destination, ${bytesPhrase(needed)} needed`,
    remedy:
      "free space on the destination filesystem, or name a destination with room; the copy " +
      "runs to completion before any source byte is removed, so a full disk would abort the " +
      "whole migration rather than lose anything",
  };
}

function bytesPhrase(count: number): string {
  return `${count} ${count === 1 ? "byte" : "bytes"}`;
}

/**
 * A migration racing an index write is the one failure a digest cannot
 * undo: the writer holds a file this run has already hashed, and the
 * bytes it appends after the hash land nowhere. `isWriterLockHeld` is
 * advisory - it answers about the instant it is called - which is enough
 * here, because the alternative is not a stronger check but no check.
 */
function writerLockRefusal(
  indexPath: string | null,
  probe: (dbPath: string) => boolean,
): MigrationRefusal | null {
  if (indexPath === null) return null;
  let held: boolean;
  try {
    held = probe(indexPath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    return {
      code: MIGRATION_REFUSAL.writerLockHeld,
      path: indexPath,
      found: `the writer lock state could not be determined (${err.code ?? "unknown error"}): ${err.message}`,
      remedy:
        '"I could not find out" is not "the lock is free"; make the lock path readable, ' +
        "then plan again once no reindex is running",
    };
  }
  if (!held) return null;
  return {
    code: MIGRATION_REFUSAL.writerLockHeld,
    path: indexPath,
    found: "the search index writer lock is held by a live writer",
    remedy:
      "wait for the running reindex or index write to finish and plan again; bytes appended " +
      "to the index after this run hashed it would land in neither copy, and that is the one " +
      "loss a digest cannot detect afterwards",
  };
}

// ----- Applying a migration -------------------------------------------------

export interface MigrationResult {
  readonly manifest_path: string;
  /** Vault-relative paths that landed and verified, in manifest order. */
  readonly moved: ReadonlyArray<string>;
  readonly bytes: number;
}

/**
 * Copy every bound file, verify it landed, write the manifest, and only
 * then remove the sources.
 *
 * The order is the guarantee. A failure during the copy pass unwinds what
 * it copied and returns the source untouched; a failure after it leaves
 * both copies plus a manifest, which {@link planStateRollback} reads as
 * already-restored rather than as a conflict.
 */
export function applyStateMigration(plan: MigrationPlan): MigrationResult {
  if (plan.refusals.length > 0) {
    throw new StateMigrationError(
      `refusing to migrate: ${plan.refusals.length} check(s) failed - ` +
        plan.refusals.map((r) => `${r.code} at ${r.path} (${r.found})`).join("; ") +
        ". Resolve them and plan again; nothing has been moved.",
    );
  }

  const landed: string[] = [];
  try {
    for (const entry of plan.manifest.entries) {
      const target = absolute(plan.destination, entry.relative_path);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(absolute(plan.source, entry.relative_path), target);
      const digest = sha256Hex(readFileSync(target));
      if (digest !== entry.digest) {
        throw new StateMigrationError(
          `${entry.relative_path} did not land intact: the manifest binds ${entry.digest} ` +
            `and the copy at ${target} digests to ${digest}`,
        );
      }
      landed.push(target);
    }
  } catch (error) {
    for (const target of landed.toReversed()) rmSync(target, { force: true });
    pruneEmptyDirectories(plan.destination, plan.manifest.canonical_roots);
    // The destination directory itself, but only while it is empty: the
    // plan refused an occupied destination, so anything in it now is
    // ours, and a `rmdir` that fails because something else appeared is
    // the correct outcome rather than a case to force past.
    try {
      rmdirSync(plan.destination);
    } catch {
      // Left in place, with whatever appeared in it. The message below
      // names the source as untouched, which is the fact that matters.
    }
    throw new StateMigrationError(
      `migration aborted during the copy pass and the destination was unwound; the source ` +
        `at ${plan.source} is untouched. Cause: ${(error as Error).message}`,
    );
  }

  const manifestPath = join(plan.destination, MIGRATION_MANIFEST_FILE);
  atomicWriteFileSync(manifestPath, `${JSON.stringify(plan.manifest, null, 2)}\n`);

  for (const entry of plan.manifest.entries) {
    rmSync(absolute(plan.source, entry.relative_path), { force: true });
  }
  pruneEmptyDirectories(plan.source, plan.manifest.canonical_roots);

  return {
    manifest_path: manifestPath,
    moved: plan.manifest.entries.map((entry) => entry.relative_path),
    bytes: plan.manifest.total_bytes,
  };
}

/**
 * Remove directories under `roots` that are now empty, deepest first.
 *
 * Empty ONLY: a directory still holding something this migration did not
 * bind - an operator's own file inside a state root - keeps the root
 * alive, which is the correct outcome and the reason this is not an
 * `rm -r` of the root.
 */
function pruneEmptyDirectories(base: string, roots: ReadonlyArray<string>): void {
  const prune = (path: string): boolean => {
    let stat: Stats;
    try {
      stat = lstatSync(path);
    } catch {
      return true;
    }
    if (!stat.isDirectory()) return false;
    let empty = true;
    for (const child of readdirSync(path)) {
      if (!prune(join(path, child))) empty = false;
    }
    if (!empty) return false;
    rmdirSync(path);
    return true;
  };
  for (const root of roots) prune(absolute(base, root));
}

// ----- Rolling a migration back ---------------------------------------------

/** One entry the rollback will put back. */
export interface RollbackEntry {
  readonly relative_path: string;
  readonly from: string;
  readonly to: string;
  /** True when the source already holds the bound bytes and only the copy is removed. */
  readonly already_in_place: boolean;
}

/** One entry the rollback will NOT touch, and why. */
export interface RollbackRefusal {
  readonly code: RollbackRefusalCode;
  readonly relative_path: string;
  readonly path: string;
  readonly found: string;
  readonly remedy: string;
}

export interface RollbackPlan {
  readonly manifest_path: string;
  readonly manifest: MigrationManifest;
  readonly source: string;
  readonly destination: string;
  readonly restore: ReadonlyArray<RollbackEntry>;
  readonly refusals: ReadonlyArray<RollbackRefusal>;
}

export interface RollbackPlanInput {
  /** The directory a migration was moved TO; it holds the manifest. */
  readonly destination: string;
}

/**
 * Read the manifest and decide, per entry, whether it can go back.
 *
 * Writes nothing. Every entry is classified, including the ones that
 * cannot be restored, because the list of what will be LEFT is the half
 * an operator has to act on.
 */
export function planStateRollback(input: RollbackPlanInput): RollbackPlan {
  const destination = resolve(input.destination);
  const manifestPath = join(destination, MIGRATION_MANIFEST_FILE);
  const manifest = readManifest(manifestPath);
  const source = manifest.source_root;

  const restore: RollbackEntry[] = [];
  const refusals: RollbackRefusal[] = [];

  for (const entry of manifest.entries) {
    const from = absolute(destination, entry.relative_path);
    const to = absolute(source, entry.relative_path);
    const atDestination = digestOf(from);
    if (atDestination === null) {
      refusals.push({
        code: ROLLBACK_REFUSAL.missingAtDestination,
        relative_path: entry.relative_path,
        path: from,
        found: "the manifest binds it, but nothing is there now",
        remedy:
          "restore it from a backup into the destination and roll back again; this run will " +
          "not invent a file it cannot read",
      });
      continue;
    }
    if (atDestination !== entry.digest) {
      refusals.push({
        code: ROLLBACK_REFUSAL.digestMismatch,
        relative_path: entry.relative_path,
        path: from,
        found: `changed since the migration (bound ${entry.digest}, now ${atDestination})`,
        remedy:
          "it is left exactly where it is and is never deleted; copy it somewhere safe, or " +
          "keep the destination as the live location for it",
      });
      continue;
    }
    const atSource = digestOf(to);
    if (atSource !== null && atSource !== entry.digest) {
      refusals.push({
        code: ROLLBACK_REFUSAL.sourceDiverged,
        relative_path: entry.relative_path,
        path: to,
        found: `something has written the source path since the migration (bound ${entry.digest}, now ${atSource})`,
        remedy:
          "the newer file at the source is kept and the destination copy is left in place; " +
          "reconcile the two by hand and remove whichever one you do not want",
      });
      continue;
    }
    restore.push({
      relative_path: entry.relative_path,
      from,
      to,
      already_in_place: atSource !== null,
    });
  }

  return { manifest_path: manifestPath, manifest, source, destination, restore, refusals };
}

function readManifest(manifestPath: string): MigrationManifest {
  if (!existsSync(manifestPath)) {
    throw new StateMigrationError(
      `no migration manifest at ${manifestPath}; a rollback restores what a migration bound, ` +
        "so point --from at the directory `o2b state migrate --apply` wrote to",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new StateMigrationError(
      `the migration manifest at ${manifestPath} is not readable JSON (${(error as Error).message}); ` +
        "restore it from a backup - a rollback driven by a manifest nobody can parse would be " +
        "a restore of something nobody measured",
    );
  }
  const manifest = parsed as MigrationManifest;
  if (manifest.schema_version !== MIGRATION_MANIFEST_SCHEMA_VERSION) {
    throw new StateMigrationError(
      `the migration manifest at ${manifestPath} declares schema_version ` +
        `${String(manifest.schema_version)}; this build reads ` +
        `${MIGRATION_MANIFEST_SCHEMA_VERSION}. Roll it back with the build that wrote it.`,
    );
  }
  if (manifest.source_type !== MIGRATION_SOURCE_TYPE.vault) {
    throw new StateMigrationError(
      `the migration manifest at ${manifestPath} was taken from a ` +
        `${String(manifest.source_type)}, which this build cannot restore. Roll it back with ` +
        "the build that wrote it.",
    );
  }
  if (!manifestVerifies(manifest)) {
    throw new StateMigrationError(
      `the migration manifest at ${manifestPath} does not match its own digest, so what it ` +
        "binds is no longer what was measured; restore the manifest from a backup rather " +
        "than rolling back against an edited one",
    );
  }
  return manifest;
}

/** The digest of a plain file, or `null` when nothing is there. */
function digestOf(path: string): string | null {
  try {
    return sha256Hex(readFileSync(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new StateMigrationError(
      `${path} could not be read while planning a rollback (${(error as Error).message}); ` +
        "fix the permissions on it before restoring, so no entry is classified from a guess",
    );
  }
}

export interface RollbackResult {
  /** Vault-relative paths now back at the source. */
  readonly restored: ReadonlyArray<string>;
  readonly refused: ReadonlyArray<RollbackRefusal>;
  /** True when the manifest was removed because nothing is left bound by it. */
  readonly manifest_removed: boolean;
}

/**
 * Put back everything the plan cleared, and nothing else.
 *
 * The manifest is removed only when there is nothing left to refuse. An
 * incomplete rollback keeps it, because the refused entries are still the
 * only record of where those bytes came from.
 */
export function applyStateRollback(plan: RollbackPlan): RollbackResult {
  const restored: string[] = [];
  for (const entry of plan.restore) {
    if (!entry.already_in_place) {
      mkdirSync(dirname(entry.to), { recursive: true });
      copyFileSync(entry.from, entry.to);
      const digest = sha256Hex(readFileSync(entry.to));
      const bound = plan.manifest.entries.find(
        (candidate) => candidate.relative_path === entry.relative_path,
      );
      if (bound === undefined || digest !== bound.digest) {
        throw new StateMigrationError(
          `${entry.relative_path} did not restore intact to ${entry.to}; the destination copy ` +
            "is still in place, so nothing is lost - investigate the source filesystem before " +
            "rolling back again",
        );
      }
    }
    rmSync(entry.from, { force: true });
    restored.push(entry.relative_path);
  }
  pruneEmptyDirectories(plan.destination, plan.manifest.canonical_roots);

  const complete = plan.refusals.length === 0;
  if (complete) rmSync(plan.manifest_path, { force: true });

  return { restored, refused: plan.refusals, manifest_removed: complete };
}

// ----- The rendering --------------------------------------------------------

/**
 * The migration plan an operator reads.
 *
 * The ONE place a plan becomes prose, following `renderStateInventory`
 * and `renderDataOwnership`: the `--json` document and this sentence are
 * two views of one value, so they cannot drift the way two hand-written
 * reports always do.
 */
export function renderMigrationPlan(plan: MigrationPlan): string {
  const lines: string[] = [
    `State migration: ${plan.source} -> ${plan.destination}`,
    `  ${plan.manifest.entries.length} file(s) under ` +
      `${plan.manifest.canonical_roots.length} root(s), ${plan.manifest.total_bytes} byte(s), ` +
      `bound by ${plan.manifest.algorithm}:${plan.manifest.digest}`,
  ];
  for (const root of plan.manifest.canonical_roots) {
    const under = plan.manifest.entries.filter(
      (entry) => entry.relative_path === root || entry.relative_path.startsWith(`${root}/`),
    );
    const bytes = under.reduce((sum, entry) => sum + entry.bytes, 0);
    lines.push(`    - ${root} (${under.length} file(s), ${bytes} byte(s))`);
  }
  if (plan.external.length > 0) {
    lines.push("", "  Left where they are, because they are not inside the vault:");
    for (const surface of plan.external) {
      lines.push(`    - ${surface.label} — ${surface.path}`);
      lines.push(`      ${surface.reason}`);
    }
  }
  if (plan.refusals.length > 0) {
    lines.push("", `  REFUSED - ${plan.refusals.length} check(s) failed; nothing will move:`);
    for (const refusal of plan.refusals) {
      lines.push(`    - ${refusal.code} at ${refusal.path}`);
      lines.push(`      found: ${refusal.found}`);
      lines.push(`      do:    ${refusal.remedy}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

/** The rollback plan an operator reads. Same contract as above. */
export function renderRollbackPlan(plan: RollbackPlan): string {
  const lines: string[] = [
    `State rollback: ${plan.destination} -> ${plan.source}`,
    `  manifest ${plan.manifest_path} (taken ${plan.manifest.created_at})`,
    `  ${plan.restore.length} of ${plan.manifest.entries.length} bound file(s) still match ` +
      "their recorded digest and will be restored",
  ];
  if (plan.refusals.length > 0) {
    lines.push(
      "",
      `  REFUSED - ${plan.refusals.length} file(s) are left exactly where they are and are ` +
        "never deleted:",
    );
    for (const refusal of plan.refusals) {
      lines.push(`    - ${refusal.relative_path} (${refusal.code}) at ${refusal.path}`);
      lines.push(`      found: ${refusal.found}`);
      lines.push(`      do:    ${refusal.remedy}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
