/**
 * Pre-`dream` snapshot, rotation, and rollback support.
 *
 * The contract (design doc §7.4 "Pre-run snapshot" + §15 Step 9a):
 *
 *   - Before any state-changing operation in a `dream` run we write
 *     `Brain/.snapshots/<run_id>.tar.zst` containing the entire
 *     `Brain/` tree **excluding** {@link BRAIN_SNAPSHOT_EXCLUDED_ENTRIES}.
 *     Including the snapshots dir would either explode the archive or
 *     racy-clobber an in-progress write; including the artifact cache
 *     would hash TTL'd tool output into a drift gate that no rollback
 *     would ever act on.
 *
 *   - Retention is enforced by `pruneSnapshots`: keep the
 *     `snapshots.retention_count` newest files, delete the rest.
 *
 *   - `restoreSnapshot` extracts the archive over `Brain/`. Critical
 *     constraint: the restore must NOT touch `Brain/.snapshots/`,
 *     otherwise rolling back to an older state could destroy newer
 *     snapshots (and with them the user's only path forward again).
 *     We achieve this by extracting into a sibling temp directory,
 *     verifying the contents, then replacing every top-level entry
 *     under `Brain/` *except* `.snapshots/`.
 *
 *   - Tooling: we shell out to system `tar` and `zstd`. Both are
 *     ubiquitous on the deployment surface (Linux server, macOS dev
 *     workstations, every shared CI runner). Falling back to gzip
 *     when `zstd` is absent keeps the feature usable on minimal
 *     containers; falling back to nothing when `tar` is absent throws
 *     {@link BrainSnapshotToolingMissingError} with an actionable
 *     message.
 *
 * No external dependencies. Everything is `node:child_process` +
 * `node:fs` so the cost is one subprocess per archive operation.
 *
 * ## Derived-store coverage, and why it is off by default
 *
 * The derived SQLite store (`<vault>/.open-second-brain/brain.sqlite`)
 * is a sibling of `Brain/`, and until now it was in no snapshot, no
 * manifest and no rollback - with nothing saying so, which made a
 * complete-looking pre-restore diff while the embeddings stayed at
 * whatever the live store happened to hold.
 *
 * What coverage buys is SPEND, not information. Feedback, activation and
 * tuning are replayable JSON folds inside `Brain/`; only the embeddings
 * and a tier baseline are database-only, so a lost store costs an
 * embedding bill and a reindex, never a fact. Against that: retention
 * keeps ten archives, and `.snapshots/` sits inside a vault replicated
 * peer-to-peer, so every retained copy is pushed to every device. Ten
 * multiples of a store on every peer is a real cost to pay for a
 * regenerable artifact.
 *
 * Hence the three-part answer. Coverage is opt-in. The ceiling REFUSES
 * rather than truncating, because half a database is not a recovery
 * point. And the live store size is recorded in every manifest whether
 * or not it was included, so an operator who has never enabled coverage
 * can still read what enabling it would cost.
 *
 * ## Every recovery point says why it exists
 *
 * `createSnapshot` requires a {@link BrainSnapshotReason}. It goes into
 * the manifest sidecar as an additive key at the existing schema version,
 * and into the Brain event log as one `snapshot` event carrying the run
 * id, the reason and the archive size — the counterpart the log has been
 * missing since `rollback` shipped, which recorded the restore while the
 * point it restores to left no trace but a filename.
 *
 * The reason is also the run-id prefix at every call site, which is
 * exactly why the READ path must not parse it back out: recovering the
 * field from the filename would look right on almost every archive this
 * project writes and would invent provenance for one it did not.
 */

import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { FileAlreadyExistsError } from "../fs-atomic.ts";
import { classifyRecoverability, type RecoverabilityVerdict } from "./gates/recoverability.ts";
import { sha256Hex } from "../integrity/digest.ts";
import { resolveConfiguredIndexPath } from "../search/paths.ts";
import { runIntegrityCheck } from "../search/store/lifecycle.ts";
import { acquireWriterLockSync } from "../search/store/writer-lock.ts";
import { appendLogEvent } from "./log.ts";
import {
  buildManifest,
  manifestSidecarPath,
  readManifestSidecar,
  SNAPSHOT_STORE_EXCLUSION,
  writeManifestSidecar,
  type BrainManifestDerivedStore,
  type SnapshotStoreExclusionReason,
} from "./manifest.ts";
import {
  BRAIN_ROOT_REL,
  BRAIN_SNAPSHOT_EXCLUDED_ENTRIES,
  BRAIN_SNAPSHOTS_REL,
  brainDirs,
  brainDirsForWrite,
  SNAPSHOT_ARCHIVE_SUFFIX,
  snapshotPath,
  snapshotStorePath,
  validateRunId,
} from "./paths.ts";
import { loadSnapshotDerivedStorePolicySafe, type BrainDerivedStorePolicy } from "./policy.ts";
import { isoSecond } from "./time.ts";
import { BRAIN_LOG_EVENT_KIND, type BrainSnapshotReason } from "./types.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";

// ----- Errors ---------------------------------------------------------------

/**
 * Thrown when the host lacks both `tar` and any compressor we know how
 * to use. Distinct from `BrainSnapshotError` so callers can pattern-
 * match and offer install instructions.
 */
export class BrainSnapshotToolingMissingError extends Error {
  constructor(tool: string, hint: string) {
    super(`snapshot tooling missing: '${tool}' not found on PATH. ${hint}`);
    this.name = "BrainSnapshotToolingMissingError";
  }
}

/**
 * Generic snapshot failure (archive write failed, restore failed,
 * archive contents corrupted). Includes the runId in the message so
 * the operator can locate it.
 */
export class BrainSnapshotError extends Error {
  readonly runId: string;
  /**
   * `cause` is forwarded rather than flattened into the message because the
   * caller that allocates a unique run id retries a lost race and has to
   * recognise a collision by its errno AND the path it names.
   * `createUniqueSnapshot` keys on
   * `isFileAlreadyExistsAt`, which walks the cause chain; an error that only
   * described its errno in prose would turn a retriable collision into a
   * terminal failure, which is the shape this release removes.
   */
  constructor(message: string, runId: string, options?: { readonly cause?: unknown }) {
    super(`snapshot[${runId}]: ${message}`, options);
    this.name = "BrainSnapshotError";
    this.runId = runId;
  }
}

/**
 * Thrown when `.snapshots/` is present and cannot be enumerated.
 *
 * {@link listSnapshots} used to answer an unreadable directory with `[]`,
 * which put "this vault has taken no recovery points" and "nobody could
 * read the recovery points" on one wire - and every surface above it then
 * printed the first sentence over the second. It is not a
 * {@link BrainSnapshotError} because it belongs to no run id: the failure
 * is the directory, and naming an arbitrary archive in the message would
 * imply the read got as far as one.
 */
export class BrainSnapshotListingError extends Error {
  /** Absolute path of the directory that could not be read. */
  readonly path: string;
  constructor(path: string, cause: unknown) {
    super(
      `snapshots directory ${path} could not be read: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
    this.name = "BrainSnapshotListingError";
    this.path = path;
  }
}

/**
 * Thrown when derived-store coverage was REQUESTED and could not be
 * honoured. Carries the reason from the same closed vocabulary a
 * manifest records, so the caller that reports the refusal and the
 * manifest that records an omission speak one language.
 *
 * It is a `BrainSnapshotError` because it is a snapshot failure in every
 * sense that matters to a caller: `createSnapshot` throws, nothing is
 * left on disk, and the destructive-snapshot gate consequently never
 * runs the operation it was protecting. That last property needs no
 * plumbing - it follows from refusing here rather than downgrading to a
 * partial snapshot that reports success.
 */
export class BrainSnapshotStoreError extends BrainSnapshotError {
  readonly reason: SnapshotStoreExclusionReason;
  constructor(message: string, runId: string, reason: SnapshotStoreExclusionReason) {
    super(`derived store not archived (${reason}): ${message}`, runId);
    this.name = "BrainSnapshotStoreError";
    this.reason = reason;
  }
}

// ----- Types ---------------------------------------------------------------

export interface CreateSnapshotResult {
  /** Absolute path of the resulting archive. */
  readonly path: string;
  /** What this snapshot did about the derived store. */
  readonly derived_store: BrainManifestDerivedStore;
}

/**
 * The derived-store knobs, shared by the create and the restore path
 * because both resolve the same live store: one to archive it, one to
 * write it back.
 */
export interface SnapshotStoreOptions {
  /**
   * Derived-store coverage policy. Defaults to the vault's
   * `snapshots:` block, so every existing call site picks the operator's
   * setting up without threading it through.
   */
  readonly derivedStore?: BrainDerivedStorePolicy;
  /**
   * Absolute path of the live derived store. Defaults to
   * {@link liveDerivedStorePath}, which resolves it the way the search
   * layer does - honouring both the `OPEN_SECOND_BRAIN_SEARCH_DB`
   * environment variable and the `search_db_path` config key. A caller
   * that already holds a resolved search config passes its own answer.
   */
  readonly derivedStorePath?: string;
}

export interface CreateSnapshotOptions extends SnapshotStoreOptions {
  /**
   * Why this recovery point is being taken. REQUIRED, and required
   * precisely because it used to be optional in effect: the reasons
   * existed only as run-id prefixes, three of them inline literals, and
   * nothing read them back. A default here would restore that state -
   * every unnamed call site would silently claim whatever the default
   * said - so there is none, and the compiler asks each caller instead.
   */
  readonly reason: BrainSnapshotReason;
  /**
   * Clock for the `snapshot` audit line's timestamp. Defaults to wall
   * clock. A caller that already has an injected clock passes it, so a
   * pass whose output is byte-reproducible given `now` - the dream pass
   * is, and a test asserts it - does not become non-reproducible merely
   * by recording that it took a recovery point.
   */
  readonly now?: Date;
}

export interface SnapshotInfo {
  readonly run_id: string;
  readonly path: string;
  /** ISO-8601 UTC mtime of the archive file. */
  readonly created_at: string;
  readonly size_bytes: number;
  /**
   * Absolute path of the sidecar manifest, or `null` when the
   * sidecar write failed at snapshot time (read-only directory or
   * similar). Rollback gracefully degrades on `null`.
   */
  readonly manifest_path: string | null;
  /**
   * Absolute path of the sibling derived-store archive when one is on
   * disk, `null` otherwise. Probed rather than believed: the manifest
   * says what the snapshot INTENDED, this says what retention has to
   * delete.
   */
  readonly store_archive_path: string | null;
  /**
   * The sidecar's derived-store record, or `null` when there is no
   * sidecar or the sidecar predates the feature. `null` is UNKNOWN
   * coverage and must never be rendered as "excluded".
   */
  readonly derived_store: BrainManifestDerivedStore | null;
  /**
   * Why the recovery point was taken, read back off the sidecar, or
   * `null` when there is no sidecar, the sidecar is unreadable, or it
   * predates the reason. `null` is UNKNOWN and is NOT recovered from the
   * run id, even though every run id this project mints begins with the
   * reason: parsing it back would report provenance for an archive that
   * never recorded any.
   */
  readonly reason: BrainSnapshotReason | null;
}

/**
 * Why one `.snapshots/` entry could not become a {@link SnapshotInfo}.
 *
 * Both members describe an entry that IS an archive by name - the suffix
 * matched - and could not be turned into a listing row. A file that is not
 * an archive at all (a sidecar manifest, a store archive, an operator's
 * stray note) is not in this vocabulary: it is not a recovery point that
 * could not be read, it is not a recovery point.
 */
export const SNAPSHOT_ENTRY_SKIP_REASON = Object.freeze({
  /** The name carries the archive suffix and the run id inside it does not validate. */
  runIdUnparseable: "run_id_unparseable",
  /** The archive is named in the directory and could not be stat'ed. */
  entryUnreadable: "entry_unreadable",
} as const);

export type SnapshotEntrySkipReason =
  (typeof SNAPSHOT_ENTRY_SKIP_REASON)[keyof typeof SNAPSHOT_ENTRY_SKIP_REASON];

export const SNAPSHOT_ENTRY_SKIP_REASONS: ReadonlyArray<SnapshotEntrySkipReason> = Object.freeze(
  Object.values(SNAPSHOT_ENTRY_SKIP_REASON),
);

export function isSnapshotEntrySkipReason(value: unknown): value is SnapshotEntrySkipReason {
  return (
    typeof value === "string" &&
    (SNAPSHOT_ENTRY_SKIP_REASONS as ReadonlyArray<string>).includes(value)
  );
}

/** One archive-shaped entry that is missing from {@link SnapshotListing.snapshots}. */
export interface SnapshotEntrySkip {
  /** Directory entry name, as `readdir` reported it. */
  readonly name: string;
  /** Absolute path of that entry. */
  readonly path: string;
  readonly reason: SnapshotEntrySkipReason;
  /** The underlying failure, in the words of whatever refused. */
  readonly detail: string;
}

/**
 * One skipped entry as a phrase, spelled once for every surface that
 * reports one: the doctor's uncertain stream and both CLI listings say the
 * same thing about the same file, and a second wording would be a second
 * claim about it.
 */
export function describeSnapshotEntrySkip(skip: SnapshotEntrySkip): string {
  return `${skip.name} (${skip.reason}: ${skip.detail})`;
}

/**
 * What {@link listSnapshots} found: the recovery points it could describe,
 * and the archive-shaped entries it could not.
 *
 * Two fields rather than one array because "these are the recovery points"
 * and "this listing is complete" are two different facts, and the second
 * one used to have no wire at all: every per-entry failure was dropped, so
 * a directory full of archives nobody could stat answered exactly like a
 * vault that had never taken one. Callers that only count archives read
 * {@link snapshots}; callers that tell an operator what their vault
 * contains have to read {@link skipped} too, and the compiler now makes
 * them look at it.
 */
export interface SnapshotListing {
  /** Newest-first by archive mtime. */
  readonly snapshots: SnapshotInfo[];
  /** Empty when every archive-shaped entry became a row. */
  readonly skipped: ReadonlyArray<SnapshotEntrySkip>;
}

/**
 * Why a prune did not remove what it was asked to.
 *
 * One member, and it is the one that mattered: `snapshots.retention_count`
 * is operator-supplied, and a zero silently removed every recovery point
 * in the vault on the next dream. A refusal is a value here rather than a
 * throw because the prune runs as a hygiene step behind every snapshot -
 * throwing would fail the operation the snapshot was protecting, which
 * trades a real guarantee for a tidy directory.
 */
export const SNAPSHOT_PRUNE_REFUSAL = Object.freeze({
  /** The requested retention is under {@link SNAPSHOT_RETENTION_FLOOR}. */
  belowRetentionFloor: "below_retention_floor",
} as const);

/** Closed union over {@link SNAPSHOT_PRUNE_REFUSAL}. */
export type SnapshotPruneRefusal =
  (typeof SNAPSHOT_PRUNE_REFUSAL)[keyof typeof SNAPSHOT_PRUNE_REFUSAL];

/** Membership list, in declaration order. */
export const SNAPSHOT_PRUNE_REFUSALS: ReadonlyArray<SnapshotPruneRefusal> = Object.freeze(
  Object.values(SNAPSHOT_PRUNE_REFUSAL),
);

/**
 * `unknown` rather than `string`: the value rides out of TypeScript in
 * the prune report a caller may persist or print, and the vocabulary
 * census probes every guard with `null`, `42` and `{}`.
 */
export function isSnapshotPruneRefusal(value: unknown): value is SnapshotPruneRefusal {
  return (
    typeof value === "string" && (SNAPSHOT_PRUNE_REFUSALS as ReadonlyArray<string>).includes(value)
  );
}

/**
 * The smallest retention {@link pruneSnapshots} will act on.
 *
 * One, because one archive is the difference between a vault with a way
 * back and a vault without one. A retention of zero is a configuration
 * that asks the most destructive operation in this module to leave
 * nothing behind, and obeying it silently is what made it dangerous.
 */
export const SNAPSHOT_RETENTION_FLOOR = 1;

export interface PruneSnapshotsOptions {
  /**
   * Run ids this pass must never remove, whatever the ordering says.
   *
   * The retention order is by MTIME, and the caller that most needs this
   * is the one that just wrote an archive: "the newest file is the newest
   * mtime" is an assumption about the filesystem, not arithmetic. `rsync
   * -t`, `cp -p`, an NFS server with clock skew, or a system clock
   * stepped backwards all leave an older archive claiming a newer mtime,
   * and at retention 1 the prune then evicted the recovery point the gate
   * had made one line earlier - which the gate reported as `covered`.
   *
   * The rollback is the second such caller: it takes a recovery point
   * mid-restore, and the archive being restored is still being read from
   * `.snapshots/` (its manifest sidecar, its derived-store archive) after
   * that point lands. Both are named here rather than trusted to sort.
   */
  readonly protectRunIds?: ReadonlyArray<string>;
}

export interface PruneSnapshotsResult {
  /** Vault-relative path of each deleted archive. */
  readonly deleted: ReadonlyArray<string>;
  /**
   * Archives the prune tried and failed to remove. Previously swallowed
   * whole: a permission error left the archive in place and reported a
   * clean prune, so retention silently stopped working and nothing said
   * so.
   */
  readonly failed: ReadonlyArray<string>;
  /**
   * How many archives the listing could DESCRIBE when the prune returns.
   *
   * An entry `listSnapshots` had to skip - a run id that will not validate,
   * a `stat` that failed - is still on disk and is not in this count, and
   * is not a prune candidate either: this function removes what it can
   * name. {@link SnapshotListing.skipped} is where those are reported.
   */
  readonly retained: number;
  /** Why nothing was pruned, or `null` when the prune ran. */
  readonly refusal: SnapshotPruneRefusal | null;
}

/**
 * What a restore did about the derived store. Separate fields rather than
 * a single verdict string, because "not replaced" splits into answers an
 * operator must be able to tell apart: the snapshot recorded that it did
 * not include the store, or the snapshot carries no record at all.
 */
export interface RestoreDerivedStoreResult {
  /** True when the archived store replaced the live one. */
  readonly replaced: boolean;
  /**
   * False when the snapshot carries no derived-store record: coverage is
   * unknown, and the live store was deliberately left untouched.
   */
  readonly coverage_known: boolean;
  /** Absolute path of the store that was replaced; null when none was. */
  readonly path: string | null;
  /** The manifest's named reason; null when included or unknown. */
  readonly exclusion_reason: SnapshotStoreExclusionReason | null;
  /**
   * Whether a sibling store archive is on disk for this snapshot, probed
   * rather than believed.
   *
   * Load-bearing exactly when {@link coverage_known} is false. The sidecar
   * write is non-fatal in `createSnapshot`, so coverage can run to
   * completion and leave no record of itself - and an archive sitting
   * beside the tar proves that happened. Without this field the reporting
   * surface had one sentence for two facts and chose the wrong one: it
   * called a lost RECORD a snapshot older than the FEATURE, while the
   * evidence to the contrary was in the same directory.
   */
  readonly store_archive_present: boolean;
}

export interface RestoreSnapshotResult {
  /** Number of regular files restored under `Brain/` (excluding the excluded entries). */
  readonly restored_files: number;
  readonly derived_store: RestoreDerivedStoreResult;
  /**
   * What the LIVE tree's recoverability was worth at the moment it was
   * discarded - not the archive's. A restore deletes every top-level
   * entry under `Brain/` and, before this field existed, said nothing
   * about the state it destroyed doing so. Without a
   * {@link RestoreSnapshotOptions.beforeDiscard} this reads `unproven`,
   * which is the honest answer and the reason `restoreSnapshotWithRecoveryPoint`
   * exists.
   */
  readonly recoverability: RecoverabilityVerdict;
}

/**
 * What a {@link RestoreSnapshotOptions.beforeDiscard} callback hands back
 * to prove it archived the tree about to be discarded.
 *
 * A structural pair rather than the gate's own `DestructiveSnapshot`,
 * because this module is the one `snapshot-gate.ts` composes: importing
 * its type back would make the pair a cycle. The `path` is the field that
 * matters - {@link restoreSnapshot} probes it on disk, so the verdict
 * rests on an archive rather than on a promise that one was taken.
 */
export interface RecoveryPointEvidence {
  /** Run id of the archive the callback wrote. */
  readonly runId: string;
  /** Absolute path of that archive. */
  readonly path: string;
}

export interface RestoreSnapshotOptions extends SnapshotStoreOptions {
  /**
   * Called once, AFTER the archive has been extracted into a temp
   * directory and BEFORE the first live entry is removed. That ordering
   * is the whole contract: extraction can fail on a corrupt or missing
   * archive, and a rollback that never touched the tree must not leave a
   * recovery point of it.
   *
   * Extraction being done is NOT the same as the restore being done with
   * `.snapshots/`: the manifest sidecar and the derived-store archive are
   * read after this callback returns, which is why a callback that prunes
   * is checked rather than trusted - see the re-validation in
   * {@link restoreSnapshot}.
   *
   * Return {@link RecoveryPointEvidence} to have the restore's
   * recoverability verdict count the archive. Returning nothing is a
   * legitimate answer and reads as `unproven`: the verdict is derived
   * from an archive being on disk when the restore finishes, never from
   * the fact that a callback was supplied.
   *
   * Injected rather than called directly because the recovery point is
   * minted by `snapshot-gate.ts`, which composes THIS module - taking
   * `takeSnapshot` from there would make the pair a cycle.
   */
  readonly beforeDiscard?: () => RecoveryPointEvidence | void;
}

// ----- Tooling detection ---------------------------------------------------

interface ToolAvailability {
  readonly tar: boolean;
  readonly zstd: boolean;
  readonly gzip: boolean;
}

/**
 * Detect tool availability by walking `process.env.PATH` and checking
 * the candidate binary exists. We deliberately avoid `spawnSync(cmd,
 * ["--version"])` because the underlying Node/Bun runtime resolves
 * commands against an internal PATH snapshot taken at process start
 * — so tests that mutate `process.env.PATH` between calls would have
 * no effect on a `spawnSync` probe. Reading the filesystem at probe
 * time keeps the detection honest and test-controllable.
 *
 * The cost (a handful of `existsSync` calls) is dwarfed by the actual
 * archive operation that follows.
 */
function detectTooling(): ToolAvailability {
  const pathEnv = process.env["PATH"] ?? "";
  const dirs = pathEnv.split(process.platform === "win32" ? ";" : ":").filter((d) => d.length > 0);
  const winExts =
    process.platform === "win32"
      ? (process.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";")
      : [];
  const probe = (cmd: string): boolean => {
    for (const d of dirs) {
      if (existsSync(join(d, cmd))) return true;
      for (const ext of winExts) {
        if (existsSync(join(d, cmd + ext.toLowerCase()))) return true;
      }
    }
    return false;
  };
  return {
    tar: probe("tar"),
    zstd: probe("zstd"),
    gzip: probe("gzip"),
  };
}

// ----- createSnapshot ------------------------------------------------------

/**
 * Make `Brain/.snapshots/` exist, or say what is there instead.
 *
 * This `mkdir` is the first disk touch of every snapshot, which makes it the
 * first thing that can fail and the worst place to fail opaquely. It used to
 * be a bare `mkdirSync`, so its errno left the module naming a syscall and a
 * path and nothing else - and, worse, reached the run-id allocator in
 * `snapshot-gate.ts`, which read the EEXIST as a lost race over the run id
 * and reported an id exhaustion that had never happened (GitHub #167).
 *
 * `recursive: true` already tolerates the normal case of the directory
 * existing, so a throw from here means the path is NOT a usable directory.
 * Which of the several ways that can be true is the only question the
 * operator has, and it is answerable on the spot: `lstat` the path and say
 * what is really there. A regular file, a symlink, a socket left by some
 * other tool, a parent that is not a directory, a permission fault - each has
 * a different remedy and the errno alone distinguishes none of them.
 *
 * The errno is carried as `cause`, not folded away: the diagnosis explains
 * the failure, it does not replace the evidence. A {@link BrainSnapshotError}
 * rather than a bare throw so this leaves the module in the one shape every
 * caller of {@link createSnapshot} already handles, run id included.
 */
function ensureSnapshotsDirectory(path: string, runId: string): void {
  try {
    mkdirSync(path, { recursive: true });
    return;
  } catch (err) {
    throw new BrainSnapshotError(
      `cannot use the archive directory ${BRAIN_SNAPSHOTS_REL} at ${path}: ` +
        `${describeExistingPath(path)} (${(err as Error).message ?? String(err)}); ` +
        `no recovery point can be written until ${BRAIN_SNAPSHOTS_REL} is a writable directory`,
      runId,
      { cause: err },
    );
  }
}

/**
 * What is actually at `path`, in one clause an operator can act on.
 *
 * `lstat` rather than `stat` because a dangling or looping symlink is one of
 * the states that produces this failure, and `stat` would report the target's
 * absence instead of the link's presence. Its own failure is reported rather
 * than swallowed: "the path cannot even be inspected" is a different remedy
 * (permissions on the parent) from "the path holds the wrong kind of thing".
 */
function describeExistingPath(path: string): string {
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "nothing is there, so the directory itself could not be created";
    return `it could not be inspected either (${code ?? (err as Error).message})`;
  }
  if (info.isDirectory()) return "it is a directory, but it could not be created or opened as one";
  if (info.isSymbolicLink()) {
    return existsSync(path)
      ? "it is a symbolic link to something that is not a usable directory"
      : "it is a symbolic link whose target does not exist";
  }
  if (info.isFile()) return "it is a regular file";
  if (info.isSocket()) return "it is a socket";
  if (info.isFIFO()) return "it is a FIFO";
  return "it is not a directory";
}

/**
 * Archive `Brain/` (minus {@link BRAIN_SNAPSHOT_EXCLUDED_ENTRIES}) into
 * `Brain/.snapshots/<run_id>.tar.zst`, optionally beside a compressed
 * copy of the derived store.
 *
 * Implementation:
 *
 *   1. Detect available tools. If `tar` is absent we throw.
 *   2. Cover the derived store FIRST, so a refusal leaves no tar behind.
 *   3. List the top-level entries under `Brain/`, drop the excluded ones.
 *   4. `tar -c -C <vault> Brain/<entry> ...` streamed into `zstd -19`
 *      (or `gzip -9` fallback) → output file.
 *
 * Using `--exclude=Brain/.snapshots` is tempting, but tar's exclude
 * pattern matching is shell-dependent and prone to subtle surprises
 * on filenames containing whitespace. Enumerating the kept entries
 * explicitly is byte-stable and easy to reason about.
 */
export function createSnapshot(
  vault: string,
  runId: string,
  opts: CreateSnapshotOptions,
): CreateSnapshotResult {
  validateRunId(runId);
  const dirs = brainDirsForWrite(vault);
  ensureSnapshotsDirectory(dirs.snapshots, runId);

  const outPath = snapshotPath(vault, runId);
  const tools = detectTooling();
  if (!tools.tar) {
    throw new BrainSnapshotToolingMissingError(
      "tar",
      "install GNU tar or BSD tar; both are supported.",
    );
  }

  // The derived store goes first. It is the step that can REFUSE, and a
  // refusal must leave nothing behind - running it before the tar is
  // written is what makes "no partial archive" a property of the order
  // rather than of a cleanup path that could be forgotten.
  const derivedStore = coverDerivedStore(vault, runId, tools, opts);

  // List top-level entries of Brain/ that we want to capture. Sort the
  // result so the resulting archive's contents are deterministic
  // across filesystems (readdirSync's order is FS-dependent).
  let topEntries: string[];
  try {
    topEntries = readdirSync(dirs.brain).filter((e) => !isSnapshotExcludedEntry(e));
  } catch (err) {
    discardStoreArchive(derivedStore, vault, runId);
    throw new BrainSnapshotError(
      `failed to list Brain/: ${(err as Error).message ?? String(err)}`,
      runId,
    );
  }
  topEntries.sort();

  // Build `tar -c -C <vault> Brain/<entry> Brain/<entry>...` so paths
  // inside the archive start at `Brain/` — matching the rollback
  // contract that the archive is "the Brain/ tree".
  const tarArgs = ["-c", "-C", vault, "--", ...topEntries.map((e) => `${BRAIN_ROOT_REL}/${e}`)];

  try {
    compressInto(
      { kind: "buffer", bytes: runArchiveProducer("tar", tarArgs, runId) },
      outPath,
      tools,
      runId,
    );
    if (!existsSync(outPath)) {
      throw new BrainSnapshotError(
        `archive write reported success but ${outPath} is absent`,
        runId,
      );
    }
  } catch (err) {
    // The store archive we just wrote belongs to a snapshot that does
    // not exist. Leaving it would make the run id look taken to the
    // collision resolver and would survive retention, which only prunes
    // archives it can list.
    discardStoreArchive(derivedStore, vault, runId);
    throw err;
  }

  // Sidecar manifest. Failure is non-fatal: the archive is the
  // load-bearing artifact, and a snapshot without a manifest just
  // degrades rollback's drift detection to a silent-overwrite path
  // (with a warning at rollback time). The alternative — failing
  // the whole snapshot because the sidecar could not be written —
  // would block dream from making any progress on a read-only
  // `.snapshots/` directory.
  try {
    writeManifestSidecar(
      vault,
      runId,
      buildManifest(dirs.brain, { derivedStore, snapshotReason: opts.reason }),
    );
  } catch (err) {
    process.stderr.write(
      `warning: manifest sidecar write failed for snapshot ` +
        `'${runId}': ${(err as Error).message ?? String(err)}; ` +
        `rollback drift detection will be skipped for this snapshot.\n`,
    );
  }

  logSnapshotEvent(vault, runId, opts.reason, outPath, opts.now ?? new Date());
  return { path: outPath, derived_store: derivedStore };
}

/**
 * Record the recovery point in the Brain event log — the counterpart the
 * log has been missing since `rollback` was added, which recorded the
 * restore while the point it restores to left no trace but a filename.
 *
 * Best-effort, in the same shape the `rollback` verb already uses for its
 * own event, and for a stronger reason here: this function runs AFTER the
 * archive is on disk, and `createSnapshot` is called by the
 * destructive-snapshot gate before the mutation it protects. A throw would
 * therefore abort an operation whose recovery point already exists,
 * turning a lost audit line into a refused mutation. The archive is the
 * load-bearing artifact; the event is how it is found later.
 */
function logSnapshotEvent(
  vault: string,
  runId: string,
  reason: BrainSnapshotReason,
  archivePath: string,
  now: Date,
): void {
  try {
    // Measured off the file rather than carried from the compressor, so
    // the number describes the archive an operator can `ls`. An
    // unmeasurable archive raises into the handler below and no event is
    // written: a `0` here would read as an empty archive, which is a real
    // and very different state.
    const sizeBytes = statSync(archivePath).size;
    appendLogEvent(vault, {
      timestamp: isoSecond(now),
      eventType: BRAIN_LOG_EVENT_KIND.snapshot,
      body: { run_id: runId, reason, size_bytes: String(sizeBytes) },
    });
  } catch (err) {
    process.stderr.write(
      `warning: append snapshot log event failed for '${runId}': ` +
        `${(err as Error).message ?? String(err)}; the archive itself is intact.\n`,
    );
  }
}

/** True for a top-level `Brain/` entry the snapshot family never touches. */
function isSnapshotExcludedEntry(name: string): boolean {
  return BRAIN_SNAPSHOT_EXCLUDED_ENTRIES.includes(name);
}

// ----- Derived-store coverage ----------------------------------------------

/**
 * Byte length of `path`, or `null` when it is not there to measure.
 * Never zero-as-absent: a freshly created SQLite file is legitimately
 * small, and an operator reading "0" needs it to mean zero bytes.
 */
function fileSizeOrNull(path: string): number | null {
  try {
    const st = statSync(path);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

/**
 * The live derived store, resolved the way the search layer resolves it.
 *
 * The resolver honours the `search_db_path` override; the bare path
 * helper answers only the default location. That distinction is the whole
 * point: on a vault carrying the override, an archive built from the
 * default would describe a file the search layer never reads, and if a
 * stale database happened to sit there it would have been archived and
 * reported as a success. It is imported from the resolver leaf rather
 * than the search barrel because the barrel is reachable from this module
 * and importing it back closes a cycle the architecture ratchet refuses.
 */
function liveDerivedStorePath(vault: string): string {
  return resolveConfiguredIndexPath(vault);
}

/**
 * Decide and, when asked, perform derived-store coverage for one
 * snapshot. Returns the record the manifest will carry; THROWS
 * {@link BrainSnapshotStoreError} when coverage was requested and any
 * step could not be completed.
 *
 * The refusal is the point. A snapshot that quietly dropped the store it
 * was asked to protect would report success, and the destructive
 * operation it guards would then run against a recovery point that is
 * not the one the operator configured.
 */
function coverDerivedStore(
  vault: string,
  runId: string,
  tools: ToolAvailability,
  opts: SnapshotStoreOptions,
): BrainManifestDerivedStore {
  const policy = opts.derivedStore ?? loadSnapshotDerivedStorePolicySafe(vault);
  // Resolved through the search layer's resolver, never re-derived here.
  const sourcePath = opts.derivedStorePath ?? liveDerivedStorePath(vault);
  const liveSize = fileSizeOrNull(sourcePath);

  const excluded = (reason: SnapshotStoreExclusionReason): BrainManifestDerivedStore =>
    Object.freeze({
      included: false,
      source_path: sourcePath,
      archive_name: null,
      archive_sha256: null,
      archive_size: null,
      live_size: liveSize,
      exclusion_reason: reason,
    });

  if (!policy.include) return excluded(SNAPSHOT_STORE_EXCLUSION.not_requested);

  if (liveSize === null) {
    throw new BrainSnapshotStoreError(
      `no store file at ${sourcePath}`,
      runId,
      SNAPSHOT_STORE_EXCLUSION.absent,
    );
  }

  const archivePath = snapshotStorePath(vault, runId);
  if (existsSync(archivePath)) {
    throw new BrainSnapshotError(
      `refusing to overwrite an existing archive: ${archivePath}`,
      runId,
    );
  }

  // The writer lock on the LIVE store path, held across the integrity
  // scan and the copy, so an index run cannot mutate the file underneath
  // the snapshot. It is the same lock every other writer serialises on,
  // taken synchronously because this whole module is synchronous.
  const release = acquireWriterLockSync(sourcePath);
  try {
    assertStoreIsSound(sourcePath, runId);

    // Measured against the LIVE size, which is what the operator's
    // ceiling is expressed in and what they can check with `ls`. The
    // compressed archive is smaller, but refusing on a number nobody can
    // predict before the work is done would be a worse contract.
    if (liveSize > policy.maxBytes) {
      throw new BrainSnapshotStoreError(
        `store is ${liveSize} bytes, over the ${policy.maxBytes}-byte ceiling ` +
          `(snapshots.derived_store_max_bytes)`,
        runId,
        SNAPSHOT_STORE_EXCLUSION.over_size_ceiling,
      );
    }

    writeStoreArchive(sourcePath, archivePath, tools, runId);
  } finally {
    release();
  }

  const archiveSize = fileSizeOrNull(archivePath);
  if (archiveSize === null) {
    throw new BrainSnapshotError(
      `store archive write reported success but ${archivePath} is absent`,
      runId,
    );
  }
  return Object.freeze({
    included: true,
    source_path: sourcePath,
    archive_name: basename(archivePath),
    archive_sha256: sha256Hex(readFileSync(archivePath)),
    archive_size: archiveSize,
    live_size: liveSize,
    exclusion_reason: null,
  });
}

/**
 * Refuse a condemned store rather than archiving it over a good
 * snapshot.
 *
 * This runs the integrity scanner the previous release already shipped -
 * `PRAGMA quick_check`, classified by {@link runIntegrityCheck} - rather
 * than inventing a second gate with its own opinion. A file that is not
 * a SQLite database at all fails here too: `new Database` is lazy, so
 * the first statement raises and the scanner classifies the raise as a
 * fault, which is the honest answer.
 */
function assertStoreIsSound(sourcePath: string, runId: string): void {
  let db: Database;
  try {
    db = new Database(sourcePath, { readonly: true });
  } catch (err) {
    throw new BrainSnapshotStoreError(
      `cannot open ${sourcePath}: ${(err as Error).message ?? String(err)}`,
      runId,
      SNAPSHOT_STORE_EXCLUSION.integrity_fault,
    );
  }
  try {
    const verdict = runIntegrityCheck(db);
    if (!verdict.ok) {
      throw new BrainSnapshotStoreError(
        `${sourcePath} failed a structural integrity check: ${verdict.fault}`,
        runId,
        SNAPSHOT_STORE_EXCLUSION.integrity_fault,
      );
    }
  } finally {
    db.close();
  }
}

/**
 * `VACUUM INTO` a private temp file, then compress that into
 * `archivePath`.
 *
 * `VACUUM INTO` rather than a file copy because the store runs in WAL
 * mode: the main file alone is not a consistent database, and the
 * runtime exposes no online-backup API. `VACUUM INTO` is read-only with
 * respect to the source, produces a single self-contained and compacted
 * file, and is the native answer to exactly this question.
 *
 * The temp file lives in the OS temp directory rather than beside the
 * store, so a crash between the vacuum and the compression leaves
 * nothing in the vault for the next reader to find.
 */
function writeStoreArchive(
  sourcePath: string,
  archivePath: string,
  tools: ToolAvailability,
  runId: string,
): void {
  const tmp = mkdtempSync(join(tmpdir(), `o2b-store-vacuum-${runId}-`));
  const vacuumed = join(tmp, DERIVED_STORE_VACUUM_FILE);
  // Whether the destination was ALREADY taken when this call began. It
  // decides whether the cleanup below may touch it: an archive a racing
  // process wrote is the very thing the overwrite refusal protects, and
  // removing it in the name of cleaning up after that refusal would
  // reintroduce the data-loss path by the back door.
  const preexisting = existsSync(archivePath);
  try {
    const db = new Database(sourcePath, { readonly: true });
    try {
      db.query("VACUUM INTO ?").run(vacuumed);
    } finally {
      db.close();
    }
    compressInto({ kind: "file", path: vacuumed }, archivePath, tools, runId);
  } catch (err) {
    // A failed compression may have left a partial archive of OUR making;
    // the snapshot is about to be refused, so nothing may survive that a
    // later read could mistake for a recovery point.
    if (!preexisting) {
      try {
        unlinkSync(archivePath);
      } catch {
        // Nothing was written, or it is already gone. Either is fine.
      }
    }
    if (err instanceof BrainSnapshotError) throw err;
    throw new BrainSnapshotError(
      `failed to archive the derived store: ${(err as Error).message ?? String(err)}`,
      runId,
    );
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // tmp cleanup is best-effort; the OS will reclaim it eventually.
    }
  }
}

/** Filename of the vacuumed copy inside its private temp directory. */
const DERIVED_STORE_VACUUM_FILE = "store.sqlite";

/** Remove a store archive whose snapshot is being abandoned. */
function discardStoreArchive(
  record: BrainManifestDerivedStore,
  vault: string,
  runId: string,
): void {
  if (!record.included) return;
  try {
    rmSync(snapshotStorePath(vault, runId), { force: true });
  } catch (err) {
    process.stderr.write(
      `warning: could not remove the orphaned derived-store archive for ` +
        `'${runId}': ${(err as Error).message ?? String(err)}\n`,
    );
  }
}

/**
 * Compress the producer's stdout into `outPath`, choosing zstd when the
 * host has it and gzip otherwise.
 *
 * ## Both compressors refuse an existing target, and that is load-bearing
 *
 * `zstd -o` has always refused to overwrite. The gzip fallback wrote
 * through `writeFileSync`, which does not - so on a host without zstd
 * two concurrent destructive operations that landed on the same run id
 * would silently destroy each other's recovery point. That was not a
 * cosmetic asymmetry: `createUniqueSnapshot` in `snapshot-gate.ts`
 * resolves a run-id collision by RETRYING when the create fails and the
 * archive now exists, so on a gzip-only host the collision path had no
 * failure to retry on and the whole mechanism was inert.
 *
 * The refusal is therefore made explicit here, before either compressor
 * runs, so both paths fail with the same typed error and the same
 * message. The gzip write additionally opens with `wx` (exclusive
 * create), which closes the window between the check and the write that
 * a probe alone would leave open.
 *
 * The on-disk extension stays `.tar.zst` under gzip. The restore probes
 * the magic bytes rather than the name, and one suffix keeps listing and
 * retention a single comparison.
 */
function compressInto(
  payload: CompressionSource,
  outPath: string,
  tools: ToolAvailability,
  runId: string,
): void {
  if (existsSync(outPath)) {
    // The refusal carries an EEXIST-shaped cause because the id allocator
    // above ladders past a taken name and needs to recognise this as the
    // collision it is. Without it the allocator sees an opaque snapshot
    // failure, declines to retry, and aborts the destructive operation the
    // snapshot exists to protect.
    throw new BrainSnapshotError(`refusing to overwrite an existing archive: ${outPath}`, runId, {
      cause: new FileAlreadyExistsError(outPath, { kind: "snapshot archive" }),
    });
  }
  if (tools.zstd) {
    // `zstd -o` opens the destination itself and refuses an existing one.
    const args =
      payload.kind === "file"
        ? ["-19", "-q", "-o", outPath, payload.path]
        : ["-19", "-q", "-o", outPath, "-"];
    runCompressor("zstd", args, payload, runId, null);
    return;
  }
  if (tools.gzip) {
    // gzip only writes to stdout, so the destination is ours to open.
    const args = payload.kind === "file" ? ["-9", "-c", payload.path] : ["-9", "-c"];
    runCompressor("gzip", args, payload, runId, outPath);
    return;
  }
  throw new BrainSnapshotToolingMissingError(
    "zstd or gzip",
    "install zstd (preferred) or gzip; we use the first available.",
  );
}

/**
 * What a compressor reads. A `buffer` is the tar stream we already hold;
 * a `file` is the vacuumed store copy, handed over by path so a
 * multi-hundred-megabyte database never round-trips through memory.
 */
type CompressionSource =
  | { readonly kind: "buffer"; readonly bytes: Buffer }
  | { readonly kind: "file"; readonly path: string };

/** Hard ceiling on any single captured subprocess stream. */
const SUBPROCESS_MAX_BUFFER_BYTES = 256 * 1024 * 1024;

/**
 * Run one compressor over `payload`. When `outPath` is non-null the
 * compressor writes to stdout and we own the destination file; when it
 * is null the compressor was given the destination itself.
 */
/**
 * The path a `-o <path>` compressor invocation was told to write.
 *
 * Read back off the argv rather than threaded separately, because the argv is
 * what the process actually acted on: a second copy of the path could drift
 * from the one the command used and then misclassify the failure.
 */
function destinationOf(args: ReadonlyArray<string>): string {
  const flag = args.indexOf("-o");
  return flag >= 0 ? (args[flag + 1] ?? "") : "";
}

function runCompressor(
  cmd: string,
  args: ReadonlyArray<string>,
  payload: CompressionSource,
  runId: string,
  outPath: string | null,
): void {
  const r = spawnSync(cmd, [...args], {
    ...(payload.kind === "buffer" ? { input: payload.bytes } : {}),
    stdio: [
      payload.kind === "buffer" ? "pipe" : "ignore",
      outPath === null ? "inherit" : "pipe",
      "pipe",
    ],
    maxBuffer: SUBPROCESS_MAX_BUFFER_BYTES,
  });
  if (r.error) {
    throw new BrainSnapshotError(`${cmd} failed to start: ${r.error.message}`, runId);
  }
  if (r.status !== 0) {
    const stderr = (r.stderr ?? Buffer.from("")).toString("utf8").trim();
    // `zstd -o` opens the destination itself and refuses one that already
    // exists, and it reports that refusal the same way it reports every other
    // failure: a non-zero status and a sentence. So when the command has
    // ALREADY failed and the destination is now present, the failure is
    // classified as a collision rather than left opaque.
    //
    // This is not the discredited "check existsSync after the throw and
    // swallow" pattern: the error is thrown either way and nothing is
    // retried here. Only its `cause` differs, which is what lets the id
    // allocator ladder to the next name instead of aborting a destructive
    // operation because a peer won the same second.
    const lostRace = outPath === null && existsSync(destinationOf(args));
    throw new BrainSnapshotError(
      `${cmd} exited with status ${r.status}: ${stderr}`,
      runId,
      lostRace
        ? { cause: new FileAlreadyExistsError(destinationOf(args), { kind: "snapshot archive" }) }
        : undefined,
    );
  }
  if (outPath === null) return;
  // Exclusive create. `wx` is what makes the gzip path refuse an
  // existing archive the way `zstd -o` always has; see
  // {@link compressInto} for why that refusal is load-bearing rather
  // than tidy. A torn write remains possible (worst case: a corrupt
  // archive that fails on restore, the same outcome as any other
  // interrupted snapshot) - what is no longer possible is silently
  // replacing someone else's recovery point.
  try {
    writeFileSync(outPath, r.stdout ?? Buffer.from(""), { flag: "wx" });
  } catch (err) {
    throw new BrainSnapshotError(
      `failed to write ${outPath}: ${(err as Error).message ?? String(err)}`,
      runId,
      { cause: err },
    );
  }
}

/**
 * Run the archive producer and capture its stdout.
 *
 * We avoid a shell pipe entirely: spawn `tar`, capture its stdout into a
 * Buffer (acceptable: Brain trees are Markdown and stay small), then
 * feed the compressor synchronously. The previous approach used
 * `sh -c "tar ... | zstd ..."` and broke on quoting of paths with
 * whitespace; buffering through Node is simpler and verifiably correct.
 *
 * Argument quoting: we deliberately do NOT shell-escape paths, because
 * `tar -C <vault>` already roots everything relative to the vault, and
 * the only user-supplied bytes in `tarArgs` are the run id (which
 * `validateRunId` constrains to `[A-Za-z0-9._-]`) and the top-level
 * `Brain/` entries (`inbox`, `preferences`, …) which are themselves
 * filesystem names produced by our own writers.
 */
function runArchiveProducer(cmd: string, args: ReadonlyArray<string>, runId: string): Buffer {
  const r = spawnSync(cmd, [...args], {
    maxBuffer: SUBPROCESS_MAX_BUFFER_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.error) {
    throw new BrainSnapshotError(`${cmd} failed to start: ${r.error.message}`, runId);
  }
  if (r.status !== 0) {
    const stderr = (r.stderr ?? Buffer.from("")).toString("utf8").trim();
    throw new BrainSnapshotError(`${cmd} exited with status ${r.status}: ${stderr}`, runId);
  }
  if (!r.stdout) {
    throw new BrainSnapshotError(`${cmd} produced no stdout`, runId);
  }
  return r.stdout;
}

// ----- listSnapshots / pruneSnapshots --------------------------------------

/**
 * Enumerate `.snapshots/*.tar.zst` in newest-first order (by mtime),
 * alongside the archive-shaped entries that could not be described.
 *
 * Files outside the canonical naming pattern are skipped and NOT reported:
 * a sidecar manifest, a store archive or a stray text file is not a
 * recovery point, so naming it would be noise.
 *
 * The three answers this returns are three different facts:
 *
 *   - a directory that is not there is an empty history: no snapshot has
 *     ever been taken, and both fields are empty.
 *   - a directory that IS there and cannot be enumerated throws
 *     {@link BrainSnapshotListingError}, because `[]` for that too is what
 *     let the listing surfaces print "no snapshots available" over a read
 *     that never happened.
 *   - an archive that is named in the directory and cannot be turned into
 *     a row - an unvalidatable run id, or a `stat` that failed - lands in
 *     {@link SnapshotListing.skipped}. It used to be dropped with a bare
 *     `continue`, which put a populated history nobody could stat and a
 *     vault that never took one on the same wire; the caller decides what
 *     to say about it, but it can no longer fail to know.
 */
export function listSnapshots(vault: string): SnapshotListing {
  const dirs = brainDirs(vault);
  if (!existsSync(dirs.snapshots)) return { snapshots: [], skipped: [] };
  let entries: string[];
  try {
    entries = readdirSync(dirs.snapshots);
  } catch (err) {
    throw new BrainSnapshotListingError(dirs.snapshots, err);
  }
  const infos: SnapshotInfo[] = [];
  const skipped: SnapshotEntrySkip[] = [];
  for (const name of entries) {
    if (!name.endsWith(SNAPSHOT_ARCHIVE_SUFFIX)) continue;
    const runId = name.slice(0, -SNAPSHOT_ARCHIVE_SUFFIX.length);
    const full = join(dirs.snapshots, name);
    // The `.snapshots/` dir is ours, so a malformed run_id here indicates
    // manual tampering — the listing stays tolerant and keeps describing
    // the archives it can, but the entry is carried out rather than
    // dropped: an operator hunting a recovery point they know they took
    // needs to be told the file is there under a name this build will not
    // accept.
    try {
      validateRunId(runId);
    } catch (err) {
      skipped.push({
        name,
        path: full,
        reason: SNAPSHOT_ENTRY_SKIP_REASON.runIdUnparseable,
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    let st;
    try {
      st = statSync(full);
    } catch (err) {
      skipped.push({
        name,
        path: full,
        reason: SNAPSHOT_ENTRY_SKIP_REASON.entryUnreadable,
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    const sidecar = manifestSidecarPath(vault, runId);
    const storeArchive = snapshotStorePath(vault, runId);
    // One read for both sidecar-derived columns: two calls would parse
    // the same file twice and could disagree if a peer rewrote it between
    // them.
    const manifest = readManifestSidecar(vault, runId);
    infos.push({
      run_id: runId,
      path: full,
      created_at: new Date(st.mtimeMs).toISOString(),
      size_bytes: st.size,
      manifest_path: existsSync(sidecar) ? sidecar : null,
      store_archive_path: existsSync(storeArchive) ? storeArchive : null,
      // `?? null` collapses "no sidecar", "unreadable sidecar" and
      // "sidecar predating the feature" into one answer, which is
      // correct: all three mean the coverage is UNKNOWN, and none of
      // them is evidence that the store was excluded.
      derived_store: manifest?.derived_store ?? null,
      // Same three states, same single answer, and the same refusal to
      // improve on it: the run id is not evidence of a reason.
      reason: manifest?.snapshot_reason ?? null,
    });
  }
  // Sort newest-first by mtime. We deliberately avoid lexicographic
  // sort on the run_id because manual rollback runs might use a
  // non-timestamped id and we still want them to land where the
  // operator's mental model expects (most recent first).
  infos.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  return { snapshots: infos, skipped };
}

/**
 * Delete all but the `retention_count` newest archives. Returns what it
 * removed, what resisted removal, how many archives survive, and - when
 * it declined to run at all - why. Idempotent: a second run on the same
 * directory removes nothing.
 *
 * This is the most destructive operation in the module, and it cannot be
 * gated on taking a recovery point: gating the thing that destroys
 * recovery points on making one is circular. It gets a floor and a named
 * refusal instead. Below {@link SNAPSHOT_RETENTION_FLOOR} nothing is
 * removed and the refusal travels back, because a configured retention of
 * zero asks this function to leave a vault with no way back, and it used
 * to comply on every snapshot and every dream without saying a word.
 *
 * A removal that fails is REPORTED rather than swallowed. It used to be
 * silently skipped, so a permission problem stopped retention working and
 * every prune still read as clean. A failure also STOPS the companion
 * removal for that archive: the sidecar manifest and the store archive go
 * only on the branch where the archive itself went, because an archive
 * left on disk without its manifest is worse than either - rollback
 * against it skips drift detection and silently never restores its
 * derived store.
 *
 * {@link PruneSnapshotsOptions.protectRunIds} is how a caller keeps the
 * archive it is standing on. See that field for why the ordering alone
 * was never enough.
 */
export function pruneSnapshots(
  vault: string,
  retentionCount: number,
  opts: PruneSnapshotsOptions = {},
): PruneSnapshotsResult {
  // Vault-identity write guard (context-integrity-gates, Unit J). This is
  // the most destructive operation in the module - an `rmSync` over
  // archives - and it was the only one of the three without the guard
  // its `createSnapshot` and `restoreSnapshot` siblings carry.
  assertVaultIdentityForWrite(vault);
  if (!Number.isInteger(retentionCount)) {
    throw new Error(`pruneSnapshots: retentionCount must be an integer; got ${retentionCount}`);
  }
  if (retentionCount < SNAPSHOT_RETENTION_FLOOR) {
    // Refused, not obeyed, and not thrown: see the docblock.
    return Object.freeze({
      deleted: Object.freeze([]),
      failed: Object.freeze([]),
      retained: listSnapshots(vault).snapshots.length,
      refusal: SNAPSHOT_PRUNE_REFUSAL.belowRetentionFloor,
    });
  }
  const all = listSnapshots(vault).snapshots;
  if (all.length <= retentionCount) {
    return Object.freeze({
      deleted: Object.freeze([]),
      failed: Object.freeze([]),
      retained: all.length,
      refusal: null,
    });
  }
  const protectedIds = new Set(opts.protectRunIds ?? []);
  // Protected archives are moved to the FRONT of the retention order and
  // then filtered out of the victim list a second time. Two mechanisms
  // for one guarantee, because they answer different failures: the
  // reordering keeps the retained count at exactly `retentionCount` in
  // the normal case, and the filter is what holds when a caller protects
  // more archives than the retention allows.
  const ordered = [
    ...all.filter((s) => protectedIds.has(s.run_id)),
    ...all.filter((s) => !protectedIds.has(s.run_id)),
  ];
  const victims = ordered.slice(retentionCount).filter((s) => !protectedIds.has(s.run_id));
  const deleted: string[] = [];
  const failed: string[] = [];
  for (const v of victims) {
    try {
      rmSync(v.path, { force: true });
    } catch {
      // The archive stays put and the caller is told which one, so a
      // recurring permission problem is visible instead of being
      // rediscovered when retention has quietly stopped working. The
      // companions below are deliberately NOT reached: an archive
      // without its manifest is an archive a rollback misreads.
      failed.push(v.path);
      continue;
    }
    deleted.push(v.path);
    // Remove the matching sidecar manifest and derived-store archive if
    // present. Independent try/catch per companion so a missing one (a
    // snapshot whose sidecar write failed at creation time, or one taken
    // without store coverage) must not abort the prune of subsequent
    // victims.
    for (const companion of [v.manifest_path, v.store_archive_path]) {
      if (companion === null) continue;
      try {
        rmSync(companion, { force: true });
      } catch {
        // Same rationale as above — best-effort.
      }
    }
  }
  return Object.freeze({
    deleted: Object.freeze(deleted),
    failed: Object.freeze(failed),
    retained: all.length - deleted.length,
    refusal: null,
  });
}

// ----- restoreSnapshot -----------------------------------------------------

/**
 * Result of {@link extractSnapshotToTemp}. `brainRoot` is the
 * extracted `Brain/` directory (sibling to the live tree, inside a
 * private tmp dir); `tmpRoot` is the parent directory the caller
 * owns. {@link cleanup} removes the tmp dir best-effort.
 */
export interface ExtractSnapshotResult {
  readonly tmpRoot: string;
  readonly brainRoot: string;
  readonly cleanup: () => void;
}

/**
 * Extract a snapshot archive into a private tmp directory and return
 * pointers to the materialised tree. The caller is responsible for
 * invoking {@link ExtractSnapshotResult.cleanup} once the data is no
 * longer needed.
 *
 * Used by:
 *   - {@link restoreSnapshot} — actually replaces the live tree.
 *   - `o2b brain rollback --dry-run` — previews the restore plan.
 *   - `o2b brain snapshot diff` — read-only inspector across two
 *     snapshots or a snapshot and the live tree.
 *
 * Shared so the tar / zstd / gzip decompression logic stays in one
 * place. Throws {@link BrainSnapshotError} on archive corruption /
 * missing root, {@link BrainSnapshotToolingMissingError} when the
 * host lacks the required external tool.
 */
export function extractSnapshotToTemp(vault: string, runId: string): ExtractSnapshotResult {
  validateRunId(runId);
  const archive = snapshotPath(vault, runId);
  if (!existsSync(archive)) {
    throw new BrainSnapshotError(`archive does not exist: ${archive}`, runId);
  }
  const tools = detectTooling();
  if (!tools.tar) {
    throw new BrainSnapshotToolingMissingError(
      "tar",
      "install GNU tar or BSD tar; both support the same -x command.",
    );
  }

  const tmp = mkdtempSync(join(tmpdir(), `o2b-brain-extract-${runId}-`));
  const cleanup = (): void => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // tmp cleanup is best-effort; the OS will reclaim it eventually.
    }
  };
  try {
    // Probe the magic bytes to decide how to decompress. zstd starts
    // with `28 B5 2F FD`; gzip with `1F 8B`. Anything else is rejected
    // — we don't blindly try every decompressor.
    const decompressor = detectArchiveCompression(archive);
    if (decompressor === "zstd" && !tools.zstd) {
      throw new BrainSnapshotToolingMissingError(
        "zstd",
        "archive is zstd-compressed; install zstd to restore it.",
      );
    }
    if (decompressor === "gzip" && !tools.gzip) {
      throw new BrainSnapshotToolingMissingError(
        "gzip",
        "archive is gzip-compressed; install gzip to restore it.",
      );
    }

    if (decompressor === "zstd") {
      const zstd = spawnSync("zstd", ["-d", "-c", archive], {
        maxBuffer: 256 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (zstd.error || zstd.status !== 0) {
        const stderr = (zstd.stderr ?? Buffer.from("")).toString("utf8").trim();
        throw new BrainSnapshotError(
          `zstd decompress failed: ${zstd.error?.message ?? stderr}`,
          runId,
        );
      }
      // `-f -` is explicit stdin: GNU tar defaults to stdin without
      // it, but BSD tar and busybox tar do not, so passing the flag
      // keeps the extraction portable across hosts.
      const tar = spawnSync("tar", ["-x", "-f", "-", "-C", tmp], {
        input: zstd.stdout,
        stdio: ["pipe", "inherit", "pipe"],
      });
      if (tar.error || tar.status !== 0) {
        const stderr = (tar.stderr ?? Buffer.from("")).toString("utf8").trim();
        throw new BrainSnapshotError(`tar extract failed: ${tar.error?.message ?? stderr}`, runId);
      }
    } else {
      const tar = spawnSync("tar", ["-x", "-z", "-f", archive, "-C", tmp], {
        stdio: ["ignore", "inherit", "pipe"],
      });
      if (tar.error || tar.status !== 0) {
        const stderr = (tar.stderr ?? Buffer.from("")).toString("utf8").trim();
        throw new BrainSnapshotError(`tar extract failed: ${tar.error?.message ?? stderr}`, runId);
      }
    }

    const extractedBrain = join(tmp, BRAIN_ROOT_REL);
    if (!existsSync(extractedBrain)) {
      throw new BrainSnapshotError(`archive does not contain a ${BRAIN_ROOT_REL}/ root`, runId);
    }
    return Object.freeze({ tmpRoot: tmp, brainRoot: extractedBrain, cleanup });
  } catch (err) {
    cleanup();
    throw err;
  }
}

/**
 * Restore the archive identified by `runId` over `Brain/`, and the
 * derived store alongside it when the snapshot recorded one. The current
 * `.snapshots/` directory is preserved verbatim so older rollbacks still
 * have a path back.
 *
 * Steps:
 *
 *   1. Locate the archive.
 *   2. Extract into a sibling temp dir.
 *   3. Verify the extracted tree contains a `Brain/` root.
 *   4. Run {@link RestoreSnapshotOptions.beforeDiscard}, the seam where
 *      a recovery point of the tree about to be discarded is taken.
 *   5. For each top-level entry under the extracted `Brain/` (which
 *      excludes {@link BRAIN_SNAPSHOT_EXCLUDED_ENTRIES} by virtue of how
 *      the archive was written), remove the corresponding live entry and
 *      copy the extracted one into place.
 *   6. Swap the derived store, when and only when the manifest says the
 *      snapshot included one.
 *   7. Clean up the temp dir.
 *
 * Step 5 is a data-loss operation with the strongest confirmation ladder
 * in the codebase in front of it and, until step 4 existed, nothing at
 * all behind it: an operator who rolled back to the wrong run id had no
 * way back. Callers that want one use `restoreSnapshotWithRecoveryPoint`
 * in `snapshot-gate.ts`; callers that do not get a `recoverability`
 * verdict saying so rather than silence.
 */
export function restoreSnapshot(
  vault: string,
  runId: string,
  opts: RestoreSnapshotOptions = {},
): RestoreSnapshotResult {
  const dirs = brainDirsForWrite(vault);

  // Everything a restore needs is checked before anything is replaced.
  //
  // The store step used to run after the Markdown tree had already been
  // deleted and re-copied, so a missing store archive threw over work
  // that had in fact completed: the caller reported a failed rollback,
  // logged nothing, and the vault was rolled back anyway. Reachable
  // whenever the sidecar survives without its companion archive - partial
  // replication, a sync rule excluding large binaries, or an operator
  // reclaiming disk. The create path already refuses before it writes;
  // this is the same ordering on the way back.
  assertDerivedStoreRestorable(vault, runId);
  // The records the pre-flight just validated, as one comparable value.
  const storeStateBefore = derivedStoreRestoreState(vault, runId);

  const ext = extractSnapshotToTemp(vault, runId);
  try {
    // Replace every top-level entry under Brain/, except the entries the
    // snapshot family never touches. The `.snapshots/` exclusion is the
    // load-bearing safety guarantee: rolling back an older state must
    // not erase newer snapshots, otherwise the operator is one click
    // away from losing their forward path. `.artifacts/` is excluded for
    // the opposite reason - it is not in the archive at all, so deleting
    // the live copy would restore nothing over it.
    const replacementEntries = readdirSync(ext.brainRoot).filter(
      (e) => !isSnapshotExcludedEntry(e),
    );

    // The correct semantics are "live tree == snapshot tree minus the
    // excluded entries". Delete every live top-level entry except those,
    // then copy in from the extracted Brain/. This makes restore
    // deterministic.
    const liveEntries = existsSync(dirs.brain)
      ? readdirSync(dirs.brain).filter((e) => !isSnapshotExcludedEntry(e))
      : [];

    // The last moment at which the live tree still exists. A throw here
    // propagates and nothing has been removed yet, which is the same
    // abort-before-the-operation rule the destructive gate applies.
    const evidence = opts.beforeDiscard?.() ?? null;

    // The callback is the one step that can change `.snapshots/` between
    // the pre-flight and the store swap - it takes a recovery point, and
    // a retention pass rides behind that. `assertDerivedStoreRestorable`
    // above validated a state this callback may have invalidated, so the
    // pre-flight is re-run against the state that actually reaches the
    // rest of the restore, and the RECORD is compared rather than only
    // re-checked: a manifest that has been removed outright would pass a
    // fresh pre-flight while turning a covered store into "coverage
    // unknown, nothing restored".
    if (opts.beforeDiscard !== undefined) {
      assertDerivedStoreRestorable(vault, runId);
      const after = derivedStoreRestoreState(vault, runId);
      if (after !== storeStateBefore) {
        throw new BrainSnapshotError(
          "the derived-store records of this snapshot changed while the recovery point was " +
            `being taken (${storeStateBefore} -> ${after}); refusing before the Brain tree is ` +
            "touched, so nothing is half-restored",
          runId,
        );
      }
    }

    for (const name of liveEntries) {
      const target = join(dirs.brain, name);
      try {
        rmSync(target, { recursive: true, force: true });
      } catch (err) {
        throw new BrainSnapshotError(
          `failed to remove live entry ${name}: ${(err as Error).message ?? String(err)}`,
          runId,
        );
      }
    }
    // Copy in each extracted entry. `cpSync({ recursive: true })` is
    // available in Node 18+ and Bun, which is the target runtime.
    let restoredFiles = 0;
    mkdirSync(dirs.brain, { recursive: true });
    for (const name of replacementEntries) {
      const from = join(ext.brainRoot, name);
      const to = join(dirs.brain, name);
      cpSync(from, to, { recursive: true });
      restoredFiles += countFiles(to);
    }
    const derivedStore = restoreDerivedStore(vault, runId, opts);
    return {
      restored_files: restoredFiles,
      derived_store: derivedStore,
      // What the DISCARDED tree was worth, not the archive's. The live
      // derived store is replaced only when the archive carried one, so
      // it joins the blast radius exactly when it was actually swapped.
      recoverability: classifyRecoverability({
        // An ARCHIVE, probed here at the end of the restore rather than
        // the presence of a callback. `beforeDiscard !== undefined` said
        // `covered` for any caller that supplied a function - including
        // one that took no snapshot, and including the case where the
        // recovery point was written and then evicted by the retention
        // pass behind it.
        recoveryPoint: evidence !== null && existsSync(evidence.path),
        blastRadius: { brainTopLevel: true, derivedStore: derivedStore.replaced },
      }),
    };
  } finally {
    ext.cleanup();
  }
}

/**
 * Put the archived derived store back, but ONLY when the manifest says
 * this snapshot carried one.
 *
 * Three answers, and the caller reports whichever it gets rather than
 * leaving any of them implicit:
 *
 *   - the manifest records inclusion: decompress and swap;
 *   - the manifest records an exclusion: nothing is touched, and the
 *     named reason travels back;
 *   - there is no record at all: coverage is UNKNOWN, and whether a
 *     sibling archive is on disk travels back with it. A restore must not
 *     guess in either direction here - replacing a live store on a hunch
 *     destroys embeddings the archive never held, and reporting
 *     "excluded" would claim a check that never ran. The archive probe is
 *     what lets the caller say WHY the record is missing instead of
 *     asserting the snapshot is older than the feature.
 */
/**
 * Refuse a restore that cannot be completed, before it starts.
 *
 * Two conditions, both of which used to surface only after the Markdown
 * tree had been replaced. A derived-store record this build cannot read
 * means coverage is indeterminate, so neither replacing the live store
 * nor leaving it can be justified; a record that names an archive which
 * is not on disk means the restore is already incomplete. Either way the
 * honest answer is to touch nothing and say why.
 */
/**
 * The three facts a restore's store step depends on, as one comparable
 * token: whether the sidecar is readable, what it says about coverage,
 * and whether the store archive is on disk.
 *
 * Compared rather than re-checked because the failure this exists to
 * catch REMOVES a record: a fresh pre-flight over a vanished manifest
 * passes (no record, nothing to validate) and the restore then reports
 * coverage as unknown over a store it was asked to put back.
 */
function derivedStoreRestoreState(vault: string, runId: string): string {
  const manifest = readManifestSidecar(vault, runId);
  const record = manifest?.derived_store ?? null;
  return [
    manifest === null ? 0 : 1,
    manifest?.derived_store_unreadable === true ? 1 : 0,
    record === null ? 0 : record.included ? 1 : 2,
    record?.archive_sha256 ?? "",
    existsSync(snapshotStorePath(vault, runId)) ? 1 : 0,
  ].join("/");
}

function assertDerivedStoreRestorable(vault: string, runId: string): void {
  const manifest = readManifestSidecar(vault, runId);
  if (manifest === null) return;
  if (manifest.derived_store_unreadable === true) {
    throw new BrainSnapshotError(
      "the manifest carries a derived-store record this build cannot read, so whether the " +
        "snapshot covered the store is indeterminate; refusing to restore rather than " +
        "guessing at the live store",
      runId,
    );
  }
  const record = manifest.derived_store ?? null;
  if (record === null || !record.included) return;
  const archive = snapshotStorePath(vault, runId);
  if (!existsSync(archive)) {
    throw new BrainSnapshotError(
      `manifest records a derived-store archive but ${archive} is absent; refusing before the ` +
        "Brain tree is touched, so nothing is half-restored",
      runId,
    );
  }
}

function restoreDerivedStore(
  vault: string,
  runId: string,
  opts: SnapshotStoreOptions,
): RestoreDerivedStoreResult {
  const record = readManifestSidecar(vault, runId)?.derived_store ?? null;
  // Probed once, for every branch, and deliberately independent of the
  // record: it is the only evidence that separates a snapshot with no
  // record from a snapshot whose record was lost after the archive landed.
  const storeArchivePresent = existsSync(snapshotStorePath(vault, runId));
  if (record === null) {
    return Object.freeze({
      replaced: false,
      coverage_known: false,
      path: null,
      exclusion_reason: null,
      store_archive_present: storeArchivePresent,
    });
  }
  if (!record.included) {
    return Object.freeze({
      replaced: false,
      coverage_known: true,
      path: null,
      exclusion_reason: record.exclusion_reason,
      store_archive_present: storeArchivePresent,
    });
  }

  const archive = snapshotStorePath(vault, runId);
  if (!existsSync(archive)) {
    // Unreachable through `restoreSnapshot`, which refuses this in its
    // pre-flight. Kept because this function is also the one a future
    // caller would reach directly, and a store swap must never begin
    // against an archive that is not there.
    throw new BrainSnapshotError(
      `manifest records a derived-store archive but ${archive} is absent`,
      runId,
    );
  }
  // The manifest's `source_path` is where the store WAS; the live target
  // is where it is now. They differ when the operator moved the vault or
  // set a `search_db_path` override after the snapshot, and the live
  // answer is the one a restore must write to.
  const target = opts.derivedStorePath ?? liveDerivedStorePath(vault);
  swapDerivedStore(archive, target, runId);
  return Object.freeze({
    replaced: true,
    coverage_known: true,
    path: target,
    exclusion_reason: null,
    store_archive_present: true,
  });
}

/**
 * Decompress `archive` beside the live store and rename it into place
 * under the writer lock.
 *
 * The same swap discipline `reindexVault` already uses: build the
 * replacement at a sibling path on the same filesystem, keep the
 * outgoing file as `.bak`, then a single atomic rename. Holding the
 * writer lock across it is what stops an index run from writing into the
 * file being replaced.
 *
 * The WAL siblings of the OUTGOING file are removed after the swap. The
 * decompressed archive came from `VACUUM INTO` and is a complete
 * database on its own; an orphan `-wal` from the file it replaced would
 * make the next open fail with SQLITE_IOERR_SHORT_READ, which is the
 * exact failure `consolidateWal` exists to prevent on the reindex path.
 */
function swapDerivedStore(archive: string, target: string, runId: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const incoming = `${target}${RESTORE_STAGING_SUFFIX}`;
  const outgoing = `${target}${RESTORE_BACKUP_SUFFIX}`;
  const release = acquireWriterLockSync(target);
  try {
    rmSync(incoming, { force: true });
    decompressArchiveTo(archive, incoming, runId);
    rmSync(outgoing, { force: true });
    if (existsSync(target)) renameSync(target, outgoing);
    renameSync(incoming, target);
    for (const sidecar of WAL_SIBLING_SUFFIXES) {
      rmSync(`${target}${sidecar}`, { force: true });
    }
  } catch (err) {
    rmSync(incoming, { force: true });
    if (err instanceof BrainSnapshotError || err instanceof BrainSnapshotToolingMissingError) {
      throw err;
    }
    throw new BrainSnapshotError(
      `failed to restore the derived store to ${target}: ${(err as Error).message ?? String(err)}`,
      runId,
    );
  } finally {
    release();
  }
}

/** Staging name of the store being restored, beside its destination. */
const RESTORE_STAGING_SUFFIX = ".restore";
/**
 * The outgoing store, kept under the SAME `.bak` name the reindex swap
 * uses - so the crash-recovery preamble every `Store.open` runs restores
 * it if a rollback dies between the two renames.
 */
const RESTORE_BACKUP_SUFFIX = ".bak";
/** SQLite's write-ahead-log siblings of a database file. */
const WAL_SIBLING_SUFFIXES: ReadonlyArray<string> = Object.freeze(["-wal", "-shm"]);

/** Decompress a snapshot archive to `outPath`, probing the magic bytes. */
function decompressArchiveTo(archive: string, outPath: string, runId: string): void {
  const tools = detectTooling();
  const compressor = detectArchiveCompression(archive);
  if (compressor === "zstd" && !tools.zstd) {
    throw new BrainSnapshotToolingMissingError(
      "zstd",
      "archive is zstd-compressed; install zstd to restore it.",
    );
  }
  if (compressor === "gzip" && !tools.gzip) {
    throw new BrainSnapshotToolingMissingError(
      "gzip",
      "archive is gzip-compressed; install gzip to restore it.",
    );
  }
  if (compressor === "zstd") {
    // `zstd -o` opens the destination itself and refuses an existing one.
    runCompressor(
      "zstd",
      ["-d", "-q", "-o", outPath, archive],
      { kind: "file", path: archive },
      runId,
      null,
    );
    return;
  }
  // gzip only writes to stdout; `wx` keeps the destination exclusive.
  writeFileSync(outPath, runArchiveProducer("gzip", ["-d", "-c", archive], runId), {
    flag: "wx",
  });
}

// ----- Helpers -------------------------------------------------------------

function detectArchiveCompression(archive: string): "zstd" | "gzip" {
  const buf = Buffer.alloc(4);
  const fd = openSync(archive, "r");
  try {
    readSync(fd, buf, 0, 4, 0);
  } finally {
    closeSync(fd);
  }
  // zstd magic: 0x28 0xB5 0x2F 0xFD (little-endian view of 0xFD2FB528).
  if (buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd) {
    return "zstd";
  }
  // gzip magic: 0x1F 0x8B
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    return "gzip";
  }
  // Default to zstd since that's our preferred writer — restore will
  // fail loudly through the zstd subprocess if the bytes don't match.
  return "zstd";
}

function countFiles(path: string): number {
  try {
    const st = statSync(path);
    if (st.isFile()) return 1;
    if (!st.isDirectory()) return 0;
  } catch {
    return 0;
  }
  let count = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const sub = join(path, entry.name);
    if (entry.isDirectory()) {
      count += countFiles(sub);
    } else if (entry.isFile()) {
      count++;
    }
  }
  return count;
}
