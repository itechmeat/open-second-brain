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
 *   - Tooling: we shell out to system `tar` (GNU tar on Linux, bsdtar
 *     on macOS and in `System32\tar.exe` on Windows 10+) and use `zstd`
 *     when it is on PATH. Without `zstd` the archive is gzip-compressed
 *     in-process through `node:zlib`, so no `gzip` binary is needed -
 *     native Windows has none. A missing `tar` throws
 *     {@link BrainSnapshotToolingMissingError} with an actionable
 *     message.
 *
 * No external dependencies. Everything is `node:child_process` +
 * `node:fs` + `node:zlib`, so the cost is one subprocess per archive
 * operation.
 *
 * ## On a switched machine
 *
 * Once this machine is switched to the brain store (design D14 item 9),
 * the store needs no snapshot: its shards are append-only with record
 * sums and partition digests. What a snapshot covers then is this
 * machine's device-local state, which keeps the same `Brain/` layout
 * under its own root (`state/machine-state.ts`). Every public entry point
 * below maps its `vault` argument to that root first, so the archive is
 * of `<device state>/migration/local/Brain/`, it lives in that tree's
 * `.snapshots/`, and a restore replaces that tree. Nothing under the vault
 * is read or written. An unswitched machine maps to the vault itself.
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
import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from "node:child_process";
import { randomBytes } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  closeSync,
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
  type Dirent,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { FileAlreadyExistsError, renameWithRetry, unlinkWithRetry } from "../fs-atomic.ts";
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
import type { WriteLane } from "./freeze-marker.ts";
import { closeDatabase } from "../sqlite-close.ts";
import { machineStateRoot } from "../state/machine-state.ts";

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
   * The write lane the guard checks. Content by default, so a frozen vault
   * refuses a snapshot like any content write. The store migration takes
   * its recovery point after it froze the legacy writers, on the audit
   * lane, because an archive of a tree still being written is not one.
   */
  readonly lane?: WriteLane;
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
  /**
   * ISO-8601 UTC creation time: the `generated_at` the manifest sidecar
   * recorded when the archive was taken, or the archive file's mtime when
   * there is no readable sidecar. The manifest wins because an mtime is a
   * property of the copy, not of the snapshot: `rsync -t`, `cp -p` or a
   * stepped clock rewrite it, and retention orders by this field.
   */
  readonly created_at: string;
  /**
   * Present only when the sidecar's `generated_at` was set aside for the
   * mtime: why it was not believed (later than now, or earlier than the
   * time the run id itself carries). A hand-edited sidecar or a broken
   * clock would otherwise pin one archive as the newest forever, and every
   * prune would then delete the genuinely newest ones.
   */
  readonly created_at_untrusted?: string;
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
   * The retention order was by MTIME when this was added (it is now the
   * manifest's creation time, falling back to mtime for an archive with
   * no readable sidecar), and the caller that most needs this
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
  /** The write lane the prune's guard checks; see {@link CreateSnapshotOptions.lane}. */
  readonly lane?: WriteLane;
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
   * The write lane the restore is guarded on (default: content), as the
   * recovery point taken before it is: a restore that passes `audit` on a
   * frozen vault is not refused after its recovery point was taken.
   */
  readonly lane?: WriteLane;
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
  };
}

/**
 * A filesystem path spelled for a `tar` argument on this host.
 *
 * On Windows two tars answer to the name `tar`: bsdtar in `System32`, and
 * the MSYS GNU tar that Git for Windows puts on PATH - ahead of `System32`
 * inside Git Bash (where hooks run) and on GitHub's Windows runners. GNU
 * tar under MSYS fails to extract into a backslashed `-C C:\...`
 * ("Cannot open: No such file or directory"). Both tars accept the same
 * path with forward slashes, which Windows itself treats as separators, so
 * every path this module hands to tar goes through here. POSIX paths are
 * returned unchanged.
 *
 * Archives are always passed through stdin/stdout (`-f -`), never by name:
 * GNU tar reads the drive colon in `-f C:\...` as a remote host.
 */
export function tarPathArg(path: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? path.replaceAll("\\", "/") : path;
}

// ----- createSnapshot ------------------------------------------------------

/**
 * `rel` (vault-relative, `/`-separated) followed by everything beneath it,
 * depth-first with siblings in byte order. Symlinked directories are listed
 * but not entered - the same as tar's own default. Exported for tests.
 *
 * Names are raw bytes (`Buffer`), not strings: a POSIX file name need not be
 * UTF-8, and a latin1 `caf\xe9.md` decoded to a string comes back as
 * `caf\uFFFD.md` - a name that does not exist, which GNU tar then refuses
 * to archive. Bytes round-trip exactly (on Windows they are the UTF-8 of
 * the UTF-16 name, which is what tar reads the list as).
 *
 * The walk is exhaustive or it fails. tar is told not to recurse, so a
 * directory this walk could not read would be archived EMPTY, and bsdtar
 * (macOS, Windows `tar.exe`) reports success for that - a recovery point
 * silently missing data. An entry that vanished mid-walk (ENOENT) is simply
 * not in the tree any more and is left out; any other error is thrown as a
 * {@link BrainSnapshotError} naming the path.
 */
export function sortedMembers(vault: string, rel: Buffer, runId: string): Buffer[] {
  const abs = Buffer.concat([Buffer.from(vault), SLASH, rel]);
  let entries: Buffer[];
  try {
    if (!lstatSync(abs).isDirectory()) return [rel];
    entries = readdirSync(abs, { encoding: "buffer" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new BrainSnapshotError(
      `cannot read ${rel.toString()} to archive it: ${(err as Error).message ?? String(err)}`,
      runId,
      { cause: err },
    );
  }
  const out = [rel];
  for (const name of entries.toSorted(Buffer.compare)) {
    out.push(...sortedMembers(vault, Buffer.concat([rel, SLASH, name]), runId));
  }
  return out;
}

const SLASH = Buffer.from("/");
const NUL = Buffer.from([0]);

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
  // The log event names the caller's vault; the archive is of the state root.
  const logVault = vault;
  vault = machineStateRoot(vault);
  validateRunId(runId);
  const dirs = brainDirsForWrite(vault, undefined, opts.lane);
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
  const derivedStore = coverDerivedStore(vault, logVault, runId, tools, opts);

  // List top-level entries of Brain/ that we want to capture. Sort the
  // result so the resulting archive's contents are deterministic
  // across filesystems (readdirSync's order is FS-dependent).
  let topEntries: Buffer[];
  try {
    topEntries = readdirSync(dirs.brain, { encoding: "buffer" }).filter(
      (e) => !isSnapshotExcludedEntry(bufferEntryName(e)),
    );
  } catch (err) {
    discardStoreArchive(derivedStore, vault, runId);
    throw new BrainSnapshotError(
      `failed to list Brain/: ${(err as Error).message ?? String(err)}`,
      runId,
    );
  }
  topEntries.sort(Buffer.compare);

  // Paths inside the archive start at `Brain/` — matching the rollback
  // contract that the archive is "the Brain/ tree". Every member is
  // listed explicitly, depth-first in sorted order, and tar is told not
  // to recurse: left to itself tar walks each directory in `readdir`
  // order, which differs between two copies of the same tree (ext4 hash
  // order, NTFS, APFS). The member ORDER is therefore deterministic; the
  // bytes are not (tar headers still carry mtime, owner and mode).
  // The list travels NUL-separated through a file (`--null -T`), which
  // GNU tar and bsdtar (macOS, Windows `tar.exe`) both accept and which
  // survives any character a filename can hold.
  const listDir = mkdtempSync(join(tmpdir(), `o2b-snapshot-list-${runId}-`));
  const listPath = join(listDir, "members");

  try {
    const members = topEntries.flatMap((e) =>
      sortedMembers(vault, Buffer.concat([Buffer.from(`${BRAIN_ROOT_REL}/`), e]), runId),
    );
    writeFileSync(listPath, Buffer.concat(members.flatMap((m) => [m, NUL])));
    const tarArgs = [
      "-c",
      "-f",
      "-",
      "-C",
      tarPathArg(vault),
      "--no-recursion",
      "--null",
      "-T",
      tarPathArg(listPath),
    ];
    // tar writes into a staging file beside the member list rather than
    // into a captured pipe, and the compressor reads that file: neither
    // the tar stream nor the compressed archive ever sits in this
    // process's memory, so the size of `Brain/` sets no ceiling here.
    const tarPath = join(listDir, "brain.tar");
    runArchiveProducer("tar", tarArgs, tarPath, runId);
    compressInto({ kind: "file", path: tarPath }, outPath, tools, runId);
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
  } finally {
    rmSync(listDir, { recursive: true, force: true });
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
      opts.lane,
    );
  } catch (err) {
    process.stderr.write(
      `warning: manifest sidecar write failed for snapshot ` +
        `'${runId}': ${(err as Error).message ?? String(err)}; ` +
        `rollback drift detection will be skipped for this snapshot.\n`,
    );
  }

  logSnapshotEvent(logVault, runId, opts.reason, outPath, opts.now ?? new Date());
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

/**
 * Decode one `readdirSync(..., { encoding: "buffer" })` entry to its UTF-8
 * name.
 *
 * The exclusion below is a string comparison, so it holds only while the
 * entry decodes to its name. Bun and Node document `Buffer` entries, whose
 * `toString()` is the name, but a runtime that hands back a bare
 * `Uint8Array` renders comma-joined byte values (`"46,100,..."`) instead:
 * nothing matches, and `.snapshots` - the archive home - is packed into
 * every archive, so each one carries its predecessors. `Buffer.from`
 * decodes either shape.
 */
export function bufferEntryName(e: Uint8Array | Buffer): string {
  return Buffer.from(e).toString("utf8");
}

/** True for a top-level `Brain/` entry the snapshot family never touches. */
export function isSnapshotExcludedEntry(name: string): boolean {
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
  liveVault: string,
  runId: string,
  tools: ToolAvailability,
  opts: SnapshotStoreOptions,
): BrainManifestDerivedStore {
  // The policy and the live store are the caller's vault's (the search
  // index is keyed by the real vault), never the mapped state root's; the
  // archive lands beside the tree it goes with (`vault`).
  const policy = opts.derivedStore ?? loadSnapshotDerivedStorePolicySafe(liveVault);
  // Resolved through the search layer's resolver, never re-derived here.
  const sourcePath = opts.derivedStorePath ?? liveDerivedStorePath(liveVault);
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
    closeDatabase(db);
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
  try {
    const db = new Database(sourcePath, { readonly: true });
    try {
      db.query("VACUUM INTO ?").run(vacuumed);
    } finally {
      closeDatabase(db);
    }
    compressInto({ kind: "file", path: vacuumed }, archivePath, tools, runId);
  } catch (err) {
    // Nothing to remove here: the compressor wrote a partial file that
    // `compressInto` discards, and the archive name is only ever created by
    // a successful publish. A failure on that name is a peer's archive,
    // which must survive the refusal.
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
 * message. Both compressors then write a partial file, and
 * {@link publishArchive} gives it the final name with an exclusive hard
 * link, which closes the window between the check and the publish that a
 * probe alone would leave open and means a killed compression never
 * leaves a truncated archive under a recovery point's name.
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
  if (existsSync(outPath)) throw archiveCollision(outPath, runId);
  // The compressor writes a partial name beside the archive, and the
  // archive appears under its final name only once the compressor has
  // exited cleanly. A process killed part-way through compression (an
  // operator's kill, a host timeout, a power cut) used to leave a
  // truncated `<run_id>.tar.zst` with no manifest, which the listing,
  // retention and rollback all treat as a recovery point. A partial file
  // never ends in the archive suffix, so nothing lists it.
  const partial = `${outPath}${PARTIAL_ARCHIVE_INFIX}${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    if (tools.zstd) {
      runCompressor("zstd", ["-19", "-q", "-o", partial, payload.path], runId);
    } else {
      // No zstd: gzip in-process. `node:zlib` ships with every runtime this
      // tool supports, so a snapshot never depends on a `gzip` binary -
      // which native Windows does not have. Level 9 matches the `gzip -9`
      // this replaced, byte format included, so older readers restore it
      // unchanged.
      gzipFileExclusive(payload.path, partial, runId);
    }
    publishArchive(partial, outPath, runId);
  } finally {
    discardPartial(partial);
  }
}

/**
 * Remove a partial archive this process wrote. Best-effort and never
 * throwing: it runs in a `finally`, where a throw would replace the real
 * outcome - turning a published archive into a failed snapshot, or hiding
 * the typed collision the run-id allocator ladders on. A partial left
 * behind is never listed, and {@link pruneSnapshots} removes stale ones.
 */
function discardPartial(partial: string): void {
  try {
    unlinkWithRetry(partial);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    process.stderr.write(
      `warning: could not remove the partial snapshot archive ${partial}: ` +
        `${(err as Error).message ?? String(err)}\n`,
    );
  }
}

/** Infix of a partial archive's name: `<archive>.partial-<pid>-<hex>`. */
const PARTIAL_ARCHIVE_INFIX = ".partial-";

/**
 * A partial archive older than this is left over from a process that was
 * killed during compression. Generous against the longest compression a
 * live snapshot could still be running.
 */
const STALE_PARTIAL_MS = 24 * 60 * 60 * 1000;

/**
 * Remove partial archives a killed snapshot left in `.snapshots/`. They are
 * this tool's own unfinished output, never a recovery point (nothing lists
 * them), and each can be as large as the whole Brain tar. Best-effort.
 */
function removeStalePartials(snapshotsDirPath: string, now: number): void {
  let names: string[];
  try {
    names = readdirSync(snapshotsDirPath);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.includes(PARTIAL_ARCHIVE_INFIX)) continue;
    const full = join(snapshotsDirPath, name);
    try {
      const st = lstatSync(full);
      if (!st.isFile() || now - st.mtimeMs < STALE_PARTIAL_MS) continue;
      unlinkWithRetry(full);
    } catch {
      // gone already, or not ours to remove right now; the next prune retries
    }
  }
}

/**
 * The typed "this name is taken" refusal. It carries an EEXIST-shaped
 * cause because the id allocator in `snapshot-gate.ts` ladders past a
 * taken name and needs to recognise this as the collision it is. Without
 * it the allocator sees an opaque snapshot failure, declines to retry, and
 * aborts the destructive operation the snapshot exists to protect.
 */
function archiveCollision(outPath: string, runId: string): BrainSnapshotError {
  return new BrainSnapshotError(`refusing to overwrite an existing archive: ${outPath}`, runId, {
    cause: new FileAlreadyExistsError(outPath, { kind: "snapshot archive" }),
  });
}

/**
 * errno values from the hard link that rule out the rename fallback too: the
 * partial file or the directory is gone, the volume is full or read-only.
 * Every other failure (a filesystem without hard links reports EPERM,
 * ENOTSUP, or on Windows FAT and exFAT an `ERROR_INVALID_FUNCTION` that
 * libuv maps to EISDIR) falls through to the checked rename.
 */
const LINK_FATAL_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOSPC", "EROFS"]);

/**
 * Give the finished `partial` file its final archive name, refusing a name
 * that is already taken.
 *
 * A hard link is an exclusive create of the name with the content already
 * in place: it fails with EEXIST when a peer published first and never
 * replaces anything, on POSIX and on NTFS alike. `rename` would replace an
 * existing archive silently, so it is used only when the link fails for
 * another reason (typically a filesystem without hard links), behind an
 * existence check. That leaves a window between
 * the check and the rename on such a volume; the run id already carries
 * the second it was taken in, and the allocator probes the name first.
 * The partial file itself is removed by the caller.
 */
function publishArchive(partial: string, outPath: string, runId: string): void {
  try {
    linkSync(partial, outPath);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    if (code === "EEXIST") throw archiveCollision(outPath, runId);
    if (LINK_FATAL_CODES.has(code)) {
      throw new BrainSnapshotError(
        `failed to publish ${outPath}: ${(err as Error).message ?? String(err)}`,
        runId,
        { cause: err },
      );
    }
  }
  if (existsSync(outPath)) throw archiveCollision(outPath, runId);
  try {
    renameWithRetry(partial, outPath);
  } catch (err) {
    throw new BrainSnapshotError(
      `failed to publish ${outPath}: ${(err as Error).message ?? String(err)}`,
      runId,
      { cause: err },
    );
  }
}

/**
 * Input read per gzip member by {@link gzipFileExclusive}. Bounds the
 * memory the gzip fallback holds at once, whatever the archive's size.
 */
const GZIP_MEMBER_INPUT_BYTES = 8 * 1024 * 1024;

/**
 * gzip `source` into `outPath` one bounded chunk at a time.
 *
 * `node:zlib` has no synchronous streaming API, and the snapshot path is
 * synchronous by contract (the destructive gate runs it inline before the
 * mutation it protects). So each chunk is compressed on its own and the
 * results are written back to back: a multi-member gzip file (RFC 1952,
 * section 2.2), which `gunzip`, `node:zlib` and every `tar -z` read as the
 * concatenation of the members. The restore path reads it unchanged.
 *
 * The destination is opened `wx`, so the exclusivity {@link compressInto}
 * relies on holds here exactly as it did for the single-buffer write. A
 * file this call created and could not finish is removed: it is ours, and
 * left behind it would read as a recovery point.
 */
function gzipFileExclusive(source: string, outPath: string, runId: string): void {
  let out: number;
  try {
    out = openSync(outPath, "wx");
  } catch (err) {
    throw new BrainSnapshotError(
      `failed to write ${outPath}: ${(err as Error).message ?? String(err)}`,
      runId,
      { cause: err },
    );
  }
  let finished = false;
  try {
    const input = openSync(source, "r");
    try {
      const chunk = Buffer.allocUnsafe(GZIP_MEMBER_INPUT_BYTES);
      let wroteMember = false;
      for (;;) {
        const read = readSync(input, chunk, 0, chunk.length, null);
        if (read === 0) break;
        writeFully(out, gzipSync(chunk.subarray(0, read), { level: 9 }));
        wroteMember = true;
      }
      // An empty source still produces a valid (one-member) gzip file.
      if (!wroteMember) writeFully(out, gzipSync(Buffer.alloc(0), { level: 9 }));
    } finally {
      closeSync(input);
    }
    finished = true;
  } catch (err) {
    throw new BrainSnapshotError(
      `failed to write ${outPath}: ${(err as Error).message ?? String(err)}`,
      runId,
      { cause: err },
    );
  } finally {
    closeSync(out);
    if (!finished) rmSync(outPath, { force: true });
  }
}

/** `writeSync` until every byte of `bytes` is on `fd`. */
function writeFully(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    offset += writeSync(fd, bytes, offset, bytes.length - offset);
  }
}

/**
 * Exclusive create of a decompressed payload. `wx` refuses an existing
 * destination the way `zstd -o` does, so neither decompressor can replace
 * a file it did not create.
 */
function writeArchiveExclusive(outPath: string, bytes: Buffer, runId: string): void {
  try {
    writeFileSync(outPath, bytes, { flag: "wx" });
  } catch (err) {
    throw new BrainSnapshotError(
      `failed to write ${outPath}: ${(err as Error).message ?? String(err)}`,
      runId,
      { cause: err },
    );
  }
}

/**
 * What a compressor reads: a file, handed over by path - the staged tar
 * stream or the vacuumed store copy - so a multi-hundred-megabyte payload
 * never round-trips through memory.
 */
type CompressionSource = { readonly kind: "file"; readonly path: string };

/**
 * Hard ceiling on any single CAPTURED subprocess stream. Only diagnostic
 * output (stderr) is captured on the archive path; archive bytes go
 * through files, so this never bounds the size of a snapshot.
 */
const SUBPROCESS_MAX_BUFFER_BYTES = 256 * 1024 * 1024;

/** Environment variable that overrides {@link SNAPSHOT_TOOL_TIMEOUT_MS}. */
export const SNAPSHOT_TOOL_TIMEOUT_ENV = "OPEN_SECOND_BRAIN_SNAPSHOT_TIMEOUT_MS";

/**
 * How long one `tar` or `zstd` run of a snapshot or a restore may take
 * before it is killed and the snapshot fails.
 *
 * The whole module is synchronous by contract, so a child that never
 * exits used to block the calling process forever: nothing else in the
 * process can run, not even a timer that would notice. Fifteen minutes is
 * far above what `zstd -19` needs for a `Brain/` tree of a few hundred
 * megabytes, and finite, so a wedged tool turns into a named failure
 * instead of a frozen hook, CLI or MCP call.
 */
export const SNAPSHOT_TOOL_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * The tool timeout in force: {@link SNAPSHOT_TOOL_TIMEOUT_ENV} when it is a
 * whole number of milliseconds above zero, {@link SNAPSHOT_TOOL_TIMEOUT_MS}
 * when it is unset or empty. Any other value is an error rather than a
 * silent fallback, so a typo cannot quietly change the bound.
 */
export function resolveSnapshotToolTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[SNAPSHOT_TOOL_TIMEOUT_ENV];
  if (raw === undefined || raw.trim() === "") return SNAPSHOT_TOOL_TIMEOUT_MS;
  const text = raw.trim();
  const parsed = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      `${SNAPSHOT_TOOL_TIMEOUT_ENV}=${raw} is not a timeout; set it to a whole number of ` +
        `milliseconds > 0 (the default is ${SNAPSHOT_TOOL_TIMEOUT_MS}), or unset it`,
    );
  }
  return parsed;
}

/**
 * `spawnSync` with the snapshot tool timeout. A run that hits it is killed
 * (SIGKILL: a tool that ignored its input closing will not honour a polite
 * signal either) and reported as a {@link BrainSnapshotError} that names
 * the tool and the bound. Every other outcome is returned unchanged for
 * the caller's own status handling.
 */
function spawnSnapshotTool(
  cmd: string,
  args: ReadonlyArray<string>,
  options: SpawnSyncOptions,
  runId: string,
): SpawnSyncReturns<Buffer> {
  const timeoutMs = resolveSnapshotToolTimeoutMs();
  const r = spawnSync(cmd, [...args], {
    ...options,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  }) as SpawnSyncReturns<Buffer>;
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
    throw new BrainSnapshotError(
      `${cmd} did not finish within ${timeoutMs} ms and was stopped; ` +
        `no archive was published (raise ${SNAPSHOT_TOOL_TIMEOUT_ENV} for a very large tree)`,
      runId,
      { cause: r.error },
    );
  }
  return r;
}

/**
 * Run one compressor that writes the destination named after its `-o`
 * itself, so only its stderr is captured. Every destination handed to it
 * is a name this process owns: a partial file with a random suffix, or a
 * file in a private temp directory. A collision on the published archive
 * name is detected by {@link publishArchive}, not here.
 */
function runCompressor(cmd: string, args: ReadonlyArray<string>, runId: string): void {
  const r = spawnSnapshotTool(
    cmd,
    args,
    { stdio: ["ignore", "ignore", "pipe"], maxBuffer: SUBPROCESS_MAX_BUFFER_BYTES },
    runId,
  );
  if (r.error) {
    throw new BrainSnapshotError(`${cmd} failed to start: ${r.error.message}`, runId);
  }
  if (r.status !== 0) {
    const stderr = (r.stderr ?? Buffer.from("")).toString("utf8").trim();
    throw new BrainSnapshotError(`${cmd} exited with status ${r.status}: ${stderr}`, runId);
  }
}

/**
 * Run the archive producer with its stdout on `outFile`.
 *
 * No shell pipe (the old `sh -c "tar ... | zstd ..."` broke on quoting of
 * paths with whitespace, and native Windows has no `sh`), and no captured
 * pipe either: tar's stdout is a file descriptor opened here, so the
 * stream goes straight to disk. It used to be captured through
 * `spawnSync` with a 256 MB `maxBuffer`, which a `Brain/` tree past that
 * size overran with `ENOBUFS` after tar had already done all of its work.
 * Only stderr is captured, for the error message.
 *
 * `outFile` is opened `wx`: it lives in a private temp directory, so an
 * existing file there is a bug to surface rather than a file to reuse.
 *
 * Argument quoting: we deliberately do NOT shell-escape paths, because
 * `tar -C <vault>` already roots everything relative to the vault, and
 * the only user-supplied bytes in `tarArgs` are the run id (which
 * `validateRunId` constrains to `[A-Za-z0-9._-]`) and the member list,
 * which travels through a file.
 */
function runArchiveProducer(
  cmd: string,
  args: ReadonlyArray<string>,
  outFile: string,
  runId: string,
): void {
  const fd = openSync(outFile, "wx");
  let r: SpawnSyncReturns<Buffer>;
  try {
    r = spawnSnapshotTool(
      cmd,
      args,
      { maxBuffer: SUBPROCESS_MAX_BUFFER_BYTES, stdio: ["ignore", fd, "pipe"] },
      runId,
    );
  } finally {
    closeSync(fd);
  }
  if (r.error) {
    throw new BrainSnapshotError(`${cmd} failed to start: ${r.error.message}`, runId);
  }
  if (r.status !== 0) {
    const stderr = Buffer.from(r.stderr ?? "")
      .toString("utf8")
      .trim();
    throw new BrainSnapshotError(`${cmd} exited with status ${r.status}: ${stderr}`, runId);
  }
  if (statSync(outFile).size === 0) {
    throw new BrainSnapshotError(`${cmd} produced no stdout`, runId);
  }
}

// ----- listSnapshots / pruneSnapshots --------------------------------------

/**
 * Enumerate `.snapshots/*.tar.zst` in newest-first order (by the
 * manifest's recorded creation time, see {@link SnapshotInfo.created_at}),
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
  vault = machineStateRoot(vault);
  const dirs = brainDirs(vault);
  if (!existsSync(dirs.snapshots)) return { snapshots: [], skipped: [] };
  let entries: string[];
  try {
    entries = readdirSync(dirs.snapshots);
  } catch (err) {
    throw new BrainSnapshotListingError(dirs.snapshots, err);
  }
  const infos: SnapshotInfo[] = [];
  // Archive mtimes, kept beside the rows only to break a creation-time
  // tie: the manifest records whole seconds, so two archives taken in
  // the same second compare equal on `created_at`.
  const mtimes = new Map<string, number>();
  const skipped: SnapshotEntrySkip[] = [];
  const nowMs = Date.now();
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
    mtimes.set(runId, st.mtimeMs);
    const created = snapshotCreatedAt(manifest?.generated_at, st.mtimeMs, runId, nowMs);
    infos.push({
      run_id: runId,
      path: full,
      created_at: created.at,
      ...(created.untrusted !== null ? { created_at_untrusted: created.untrusted } : {}),
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
  // Sort newest-first by recorded creation time, then by mtime within
  // the same second, then by run id so the order is total. We avoid a
  // lexicographic run_id sort as the primary key because manual rollback
  // runs might use a non-timestamped id and we still want them to land
  // where the operator's mental model expects (most recent first).
  infos.sort(
    (a, b) =>
      Date.parse(b.created_at) - Date.parse(a.created_at) ||
      (mtimes.get(b.run_id) ?? 0) - (mtimes.get(a.run_id) ?? 0) ||
      (a.run_id < b.run_id ? 1 : a.run_id > b.run_id ? -1 : 0),
  );
  return { snapshots: infos, skipped };
}

/** How far ahead of now a sidecar stamp may be before it reads as a broken clock or an edit. */
const SNAPSHOT_STAMP_FUTURE_SKEW_MS = 5 * 60 * 1000;

/** Slack below the run id's time: both are whole seconds, and the sidecar is written after. */
const SNAPSHOT_STAMP_RUN_ID_SLACK_MS = 1000;

/**
 * The UTC time a run id carries (`<reason>-YYYY-MM-DD-HHMMSS`, with an
 * optional `-<n>` collision suffix), or `null` for an id without one.
 */
function runIdStampMs(runId: string): number | null {
  const m = /-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})(?:-\d+)?$/.exec(runId);
  if (m === null) return null;
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The creation time retention orders by: the manifest's `generated_at`
 * when it parses as a date and is believable, else the archive's mtime.
 * An unparseable stamp falls back rather than sorting as `NaN`, which
 * would make the comparator inconsistent and the prune order undefined.
 * A stamp later than now (beyond a small skew) or earlier than the run
 * id's own time falls back too, and the reason is returned so the
 * listing can report it.
 */
function snapshotCreatedAt(
  generatedAt: string | undefined,
  mtimeMs: number,
  runId: string,
  nowMs: number,
): { readonly at: string; readonly untrusted: string | null } {
  let untrusted: string | null = null;
  if (generatedAt !== undefined) {
    const ms = Date.parse(generatedAt);
    if (Number.isFinite(ms)) {
      const runMs = runIdStampMs(runId);
      // Quoted as JSON: the stamp is printed, and a parseable one can still
      // carry a newline or a terminal escape inside a `(...)` comment. JSON
      // leaves DEL and the C1 controls (U+009B is a one-character CSI) as
      // they are, so those are escaped too.
      const shown = JSON.stringify(generatedAt).replace(
        /[\u007f-\u009f]/g,
        (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
      );
      if (ms > nowMs + SNAPSHOT_STAMP_FUTURE_SKEW_MS) {
        untrusted = `the manifest's generated_at ${shown} is later than now`;
      } else if (runMs !== null && ms < runMs - SNAPSHOT_STAMP_RUN_ID_SLACK_MS) {
        untrusted =
          `the manifest's generated_at ${shown} is earlier than the run id's own time ` +
          new Date(runMs).toISOString();
      } else {
        return { at: new Date(ms).toISOString(), untrusted: null };
      }
    }
  }
  return { at: new Date(mtimeMs).toISOString(), untrusted };
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
  vault = machineStateRoot(vault);
  // Vault-identity write guard (context-integrity-gates, Unit J). This is
  // the most destructive operation in the module - an `rmSync` over
  // archives - and it was the only one of the three without the guard
  // its `createSnapshot` and `restoreSnapshot` siblings carry.
  assertVaultIdentityForWrite(vault, undefined, opts.lane);
  if (!Number.isInteger(retentionCount)) {
    throw new Error(`pruneSnapshots: retentionCount must be an integer; got ${retentionCount}`);
  }
  removeStalePartials(brainDirs(vault).snapshots, Date.now());
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
  vault = machineStateRoot(vault);
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

    if (decompressor === "zstd") {
      // Decompressed to a staging file OUTSIDE the extraction root, then
      // handed to tar as its stdin descriptor: neither stream is captured
      // in memory, so an archive whose tar stream is larger than any
      // capture buffer restores as well as a small one. Captured through
      // a 256 MB `maxBuffer` before, which such an archive overran.
      const staging = mkdtempSync(join(tmpdir(), `o2b-brain-extract-tar-${runId}-`));
      try {
        const tarball = join(staging, "brain.tar");
        runCompressor("zstd", ["-d", "-q", "-o", tarball, archive], runId);
        const input = openSync(tarball, "r");
        let tar: SpawnSyncReturns<Buffer>;
        try {
          // `-f -` is explicit stdin: GNU tar defaults to stdin without
          // it, but BSD tar and busybox tar do not, so passing the flag
          // keeps the extraction portable across hosts.
          tar = spawnSnapshotTool(
            "tar",
            ["-x", "-f", "-", "-C", tarPathArg(tmp)],
            { stdio: [input, "inherit", "pipe"] },
            runId,
          );
        } finally {
          closeSync(input);
        }
        if (tar.error || tar.status !== 0) {
          const stderr = Buffer.from(tar.stderr ?? "")
            .toString("utf8")
            .trim();
          throw new BrainSnapshotError(
            `tar extract failed: ${tar.error?.message ?? stderr}`,
            runId,
          );
        }
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    } else {
      // gzip is inflated in-process and piped to `tar -f -`, like the zstd
      // branch: no `gzip` binary needed (native Windows has none), and no
      // reliance on `tar -z` spawning one.
      let tarball: Buffer;
      try {
        tarball = gunzipSync(readFileSync(archive));
      } catch (err) {
        throw new BrainSnapshotError(
          `gzip decompress failed: ${(err as Error).message ?? String(err)}`,
          runId,
        );
      }
      const tar = spawnSnapshotTool(
        "tar",
        ["-x", "-f", "-", "-C", tarPathArg(tmp)],
        { input: tarball, stdio: ["pipe", "inherit", "pipe"] },
        runId,
      );
      if (tar.error || tar.status !== 0) {
        const stderr = (tar.stderr ?? Buffer.from("")).toString("utf8").trim();
        throw new BrainSnapshotError(`tar extract failed: ${tar.error?.message ?? stderr}`, runId);
      }
    }

    const extractedBrain = join(tmp, BRAIN_ROOT_REL);
    if (!existsSync(extractedBrain)) {
      throw new BrainSnapshotError(`archive does not contain a ${BRAIN_ROOT_REL}/ root`, runId);
    }
    refuseEscapingSymlinks(extractedBrain, runId);
    return Object.freeze({ tmpRoot: tmp, brainRoot: extractedBrain, cleanup });
  } catch (err) {
    cleanup();
    throw err;
  }
}

/**
 * Refuse an extracted tree that carries a symlink pointing outside it.
 *
 * The archive is vault content - agent-writable, and in a peer-replicated
 * vault writable by every peer - so its members are untrusted input, and
 * the restore step after this sweep copies top-level entries into the
 * live tree with `dereference` off, which would re-plant such a link
 * verbatim into `Brain/`. Symlinks that stay INSIDE the extracted tree
 * are kept: the member walk that builds an archive lists symlinked files
 * and directories as members without following them, so a vault that
 * legitimately uses in-tree links produces archives carrying them, and a
 * restore must not break on its own output.
 *
 * Every link is checked twice. Its recorded target, read with
 * `readlink` and resolved against the link's own directory, must stay
 * inside the tree - this is the only check a DANGLING link can get, and
 * it is the one that matters for it: a link to a file that does not
 * exist yet outside the vault is restored verbatim into `Brain/` and
 * becomes a write-through escape the moment anything creates that file.
 * When the target does resolve, its real path must stay inside too, so
 * a chain through another link cannot leave the tree either.
 *
 * Both comparisons accept the tree under its resolved AND unresolved
 * root: the tmpdir this tree extracts into may itself sit behind a
 * platform symlink (macOS `/var`), and a compare against only one
 * spelling would refuse the tree's own honest links.
 */
function refuseEscapingSymlinks(root: string, runId: string): void {
  const realRoot = realpathSync(root);
  const lexicalRoot = resolve(root);
  const inside = (p: string): boolean =>
    p === realRoot ||
    p.startsWith(realRoot + sep) ||
    p === lexicalRoot ||
    p.startsWith(lexicalRoot + sep);
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      throw new BrainSnapshotError(
        `cannot inspect the extracted tree at ${dir}: ${(err as Error).message ?? String(err)}`,
        runId,
        { cause: err },
      );
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const recorded = resolve(dirname(abs), readlinkSync(abs));
        let target: string | null;
        try {
          target = realpathSync(abs);
        } catch {
          // Dangling (or a loop): only the recorded target can be judged.
          target = null;
        }
        for (const candidate of target === null ? [recorded] : [recorded, target]) {
          if (!inside(candidate)) {
            throw new BrainSnapshotError(
              `snapshot contains a symlink that escapes the extracted tree: ` +
                `${relative(root, abs)} -> ${candidate}`,
              runId,
            );
          }
        }
        continue;
      }
      if (entry.isDirectory()) stack.push(abs);
    }
  }
}

/**
 * Restore the archive identified by `runId` over `Brain/`, and the
 * derived store alongside it when the snapshot recorded one. The current
 * `.snapshots/` directory is preserved verbatim so older rollbacks still
 * have a path back.
 *
 * Every step that can fail for a reason other than the swap itself runs
 * BEFORE anything live changes, so a failed restore leaves `Brain/` and
 * the derived store exactly as they were:
 *
 *   1. Pre-flight the derived-store records: refuse an unreadable record
 *      or a recorded archive that is not on disk.
 *   2. Extract the archive into a private temp dir and verify it has a
 *      `Brain/` root with no symlink escaping it.
 *   3. Stage the extracted top-level entries (minus
 *      {@link BRAIN_SNAPSHOT_EXCLUDED_ENTRIES}) on the live tree's own
 *      filesystem, and verify the staged copy holds every file.
 *   4. When the manifest says the snapshot included the derived store:
 *      check the archive against the recorded digest, decompress it
 *      beside the live store, and run the integrity check on the result.
 *   5. Run {@link RestoreSnapshotOptions.beforeDiscard}, the seam where a
 *      recovery point of the state about to be discarded is taken, then
 *      re-check that the derived-store records did not change under it.
 *   6. Take the derived store's writer lock (when it is being replaced),
 *      so lock contention also refuses before anything is touched.
 *   7. Swap: move each live top-level entry aside and rename the staged
 *      one into place, then rename the staged store over the live one.
 *      Renames only, on one filesystem, so the window is short. If any
 *      rename fails, the renames already done are undone in reverse.
 *   8. Remove the outgoing entries and every staging directory.
 *
 * Step 7 is a data-loss operation with the strongest confirmation ladder
 * in the codebase in front of it and, until step 5 existed, nothing at
 * all behind it: an operator who rolled back to the wrong run id had no
 * way back. Callers that want one use `restoreSnapshotWithRecoveryPoint`
 * in `snapshot-gate.ts`; callers that do not get a `recoverability`
 * verdict saying so rather than silence. When the swap fails AND its undo
 * fails too, the error names what was swapped, where the outgoing entries
 * were left, and the recovery point when one was taken.
 */
export function restoreSnapshot(
  vault: string,
  runId: string,
  opts: RestoreSnapshotOptions = {},
): RestoreSnapshotResult {
  const liveVault = vault;
  vault = machineStateRoot(vault);
  const dirs = brainDirsForWrite(vault, undefined, opts.lane);

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
  let staged: StagedBrainTree | null = null;
  let store: StagedDerivedStore | null = null;
  try {
    // Replace every top-level entry under Brain/, except the entries the
    // snapshot family never touches. The `.snapshots/` exclusion is the
    // load-bearing safety guarantee: rolling back an older state must
    // not erase newer snapshots, otherwise the operator is one click
    // away from losing their forward path. `.artifacts/` is excluded for
    // the opposite reason - it is not in the archive at all, so deleting
    // the live copy would restore nothing over it.
    staged = stageBrainTree(ext.brainRoot, dirs.brain, dirs.snapshots, runId);

    // The derived store is decompressed and verified here, before the
    // recovery point and before the Brain tree is touched. It used to be
    // decompressed only after the tree had been replaced, so a `zstd`
    // timeout, a corrupt payload or a full disk left a rolled-back tree
    // beside the store it was meant to replace.
    const plan = stageDerivedStore(vault, liveVault, runId, opts);
    store = plan.staged;

    // The correct semantics are "live tree == snapshot tree minus the
    // excluded entries". Every live top-level entry except those is moved
    // out, and every staged one moved in. This makes restore
    // deterministic.
    const liveEntries = existsSync(dirs.brain)
      ? readdirSync(dirs.brain).filter((e) => !isSnapshotExcludedEntry(e) && e !== staged!.name)
      : [];

    // The last moment at which the live state still exists. A throw here
    // propagates and nothing has been replaced yet, which is the same
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

    // The writer lock is taken before the first rename, not inside the
    // store swap: an index run holding it is a refusal like any other,
    // and it must arrive while nothing has been replaced yet.
    const release = store === null ? null : acquireStoreLockForRestore(store.target, runId);
    try {
      const swap = swapBrainTree(staged, dirs.brain, liveEntries, runId, evidence);
      if (store !== null) {
        try {
          commitDerivedStoreSwap(store, runId);
        } catch (err) {
          throw swap.fail(`the derived store swap failed (${errorText(err)})`, err, {
            storeIntact: !(err instanceof StoreSwapTornError),
          });
        }
      }
      swap.finish();
    } finally {
      release?.();
    }

    const derivedStore = plan.result;
    return {
      restored_files: staged.files,
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
    store?.discard();
    staged?.cleanup();
    ext.cleanup();
  }
}

/**
 * The extracted `Brain/` entries, copied onto the live tree's filesystem
 * so the swap is a run of renames rather than a delete-and-copy.
 *
 * `root` holds `incoming/` (the staged entries) and, once the swap has
 * started, `outgoing/` (the live entries moved aside). {@link cleanup}
 * removes it best-effort, and keeps it when {@link keep} has been called
 * because the outgoing entries are the only copy left.
 */
interface StagedBrainTree {
  /** Top-level name of {@link root} inside its parent directory. */
  readonly name: string;
  readonly root: string;
  readonly incoming: string;
  readonly entries: ReadonlyArray<string>;
  /** Regular files under {@link incoming}. */
  readonly files: number;
  keep(): void;
  cleanup(): void;
}

/** Prefix of a restore's staging directory, beside the entries it swaps. */
const RESTORE_TREE_STAGING_PREFIX = ".restore-staging-";

/**
 * Copy the extracted tree to a staging directory on the live tree's
 * filesystem and verify the copy.
 *
 * The staging directory goes under `.snapshots/` - excluded from every
 * archive, manifest walk and restore, and never listed as a snapshot
 * since it carries no archive suffix - when that directory shares a
 * device with `Brain/`. When it does not (a separately mounted snapshot
 * directory), a rename from it into `Brain/` would fail mid-swap with
 * EXDEV, so the staging directory goes directly under `Brain/` instead
 * and the swap leaves it alone.
 */
function stageBrainTree(
  extractedBrain: string,
  liveBrain: string,
  snapshotsDirPath: string,
  runId: string,
): StagedBrainTree {
  mkdirSync(liveBrain, { recursive: true });
  const parent = sameDevice(snapshotsDirPath, liveBrain) ? snapshotsDirPath : liveBrain;
  let root: string;
  try {
    root = mkdtempSync(join(parent, `${RESTORE_TREE_STAGING_PREFIX}${runId}-`));
  } catch (err) {
    throw new BrainSnapshotError(
      `cannot create a restore staging directory under ${parent}: ${errorText(err)}`,
      runId,
      { cause: err },
    );
  }
  let kept = false;
  const cleanup = (): void => {
    if (kept) return;
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (err) {
      console.error(
        `warning: could not remove the restore staging directory ${root}: ${errorText(err)}`,
      );
    }
  };
  try {
    const incoming = join(root, "incoming");
    mkdirSync(incoming);
    const entries = readdirSync(extractedBrain).filter((e) => !isSnapshotExcludedEntry(e));
    let files = 0;
    let expected = 0;
    for (const name of entries) {
      // `verbatimSymlinks` is load-bearing: without it `cpSync` rewrites
      // every relative link to the ABSOLUTE path of its target inside the
      // temp extraction, which the cleanup deletes - the in-tree links the
      // containment sweep kept would all restore dangling, pointing outside
      // the vault. A relative link survives the later rename unchanged,
      // because the staged entry sits at the same depth as the live one.
      const from = join(extractedBrain, name);
      const to = join(incoming, name);
      cpSync(from, to, { recursive: true, verbatimSymlinks: true });
      expected += countFiles(from);
      files += countFiles(to);
    }
    if (files !== expected) {
      throw new BrainSnapshotError(
        `the staged Brain tree holds ${files} file(s) but the archive extracted ${expected}; ` +
          "refusing before the Brain tree is touched",
        runId,
      );
    }
    return {
      name: basename(root),
      root,
      incoming,
      entries,
      files,
      keep: () => {
        kept = true;
      },
      cleanup,
    };
  } catch (err) {
    cleanup();
    if (err instanceof BrainSnapshotError) throw err;
    throw new BrainSnapshotError(
      `failed to stage the extracted Brain tree under ${root}: ${errorText(err)}`,
      runId,
      { cause: err },
    );
  }
}

/** Whether two existing paths live on the same device; false when unsure. */
function sameDevice(a: string, b: string): boolean {
  try {
    return statSync(a).dev === statSync(b).dev;
  } catch {
    return false;
  }
}

/** An in-progress Brain swap: {@link finish} it, or {@link fail} it. */
interface BrainSwap {
  /** Remove the outgoing entries; the swap is complete. */
  finish(): void;
  /**
   * Undo the swap and return the error to throw, naming what failed,
   * whether the undo succeeded and how to recover when it did not.
   */
  fail(what: string, cause: unknown, opts?: { readonly storeIntact?: boolean }): BrainSnapshotError;
}

/**
 * Move every live top-level entry into the staging directory's
 * `outgoing/`, then rename every staged entry into `Brain/`.
 *
 * Renames on one filesystem: each one either happens or does not, and
 * the outgoing entries stay on disk until {@link BrainSwap.finish}, so a
 * failure at any point - here, or in the store swap that follows - is
 * undone by renaming everything back in reverse order.
 */
function swapBrainTree(
  staged: StagedBrainTree,
  liveBrain: string,
  liveEntries: ReadonlyArray<string>,
  runId: string,
  recoveryPoint: RecoveryPointEvidence | null,
): BrainSwap {
  const outgoing = join(staged.root, "outgoing");
  const movedOut: string[] = [];
  const movedIn: string[] = [];

  const undo = (): string[] => {
    const failures: string[] = [];
    for (const name of movedIn.toReversed()) {
      try {
        renameWithRetry(join(liveBrain, name), join(staged.incoming, name));
      } catch (err) {
        failures.push(`could not move the restored ${name} back out: ${errorText(err)}`);
      }
    }
    for (const name of movedOut.toReversed()) {
      try {
        renameWithRetry(join(outgoing, name), join(liveBrain, name));
      } catch (err) {
        failures.push(`could not move the live ${name} back: ${errorText(err)}`);
      }
    }
    return failures;
  };

  const fail = (
    what: string,
    cause: unknown,
    opts: { readonly storeIntact?: boolean } = {},
  ): BrainSnapshotError => {
    const storeIntact = opts.storeIntact ?? true;
    const swapped =
      `${movedOut.length} of ${liveEntries.length} live Brain/ top-level entries had been moved ` +
      `aside and ${movedIn.length} of ${staged.entries.length} restored ones moved in`;
    const failures = undo();
    const recovery =
      recoveryPoint === null
        ? "no recovery point was taken for this restore"
        : `the recovery point ${recoveryPoint.runId} (${recoveryPoint.path}) holds the ` +
          `pre-restore state; \`o2b brain rollback ${recoveryPoint.runId}\` puts it back`;
    if (failures.length === 0) {
      const state = storeIntact
        ? "Brain/ and the derived store are as they were before the restore"
        : `Brain/ is as it was before the restore, but the derived store is not (see above); ${recovery}`;
      return new BrainSnapshotError(
        `restore failed during the swap: ${what}. ${swapped}; every Brain/ rename was undone, so ${state}`,
        runId,
        { cause },
      );
    }
    // The outgoing entries are now the only copy of what did not make it
    // back: the staging directory must outlive this restore.
    staged.keep();
    return new BrainSnapshotError(
      `restore failed during the swap: ${what}. ${swapped}; undoing it also failed ` +
        `(${failures.join("; ")}), so Brain/ is a mix of the restored and the pre-restore ` +
        `tree. The pre-restore entries that were moved aside are kept under ${outgoing} and ` +
        `the restored ones not yet moved in under ${staged.incoming}; ${recovery}`,
      runId,
      { cause },
    );
  };

  try {
    mkdirSync(outgoing);
    for (const name of liveEntries) {
      renameWithRetry(join(liveBrain, name), join(outgoing, name));
      movedOut.push(name);
    }
    for (const name of staged.entries) {
      renameWithRetry(join(staged.incoming, name), join(liveBrain, name));
      movedIn.push(name);
    }
  } catch (err) {
    throw fail(`a Brain/ rename failed (${errorText(err)})`, err);
  }

  return {
    finish: () => {
      try {
        rmSync(outgoing, { recursive: true, force: true });
      } catch (err) {
        // The restore itself is complete; what is left is the discarded
        // tree, which the staging cleanup retries.
        console.error(
          `warning: could not remove the pre-restore Brain entries under ${outgoing}: ` +
            errorText(err),
        );
      }
    },
    fail,
  };
}

/** An error's message, or its string form. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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

/** A decompressed and verified store, waiting beside its live target. */
interface StagedDerivedStore {
  /** The live store path the staged file is renamed over. */
  readonly target: string;
  /** The staged file, on the target's filesystem. */
  readonly incoming: string;
  /** Remove the staged file if it is still there. Best-effort. */
  discard(): void;
}

/**
 * Decide what the restore does with the derived store, and when the
 * manifest says the snapshot carried one, decompress and verify it next
 * to the live store - without touching the live store.
 *
 * Three answers, and the caller reports whichever it gets rather than
 * leaving any of them implicit:
 *
 *   - the manifest records inclusion: decompress and verify here, swap
 *     later in {@link commitDerivedStoreSwap};
 *   - the manifest records an exclusion: nothing is touched, and the
 *     named reason travels back;
 *   - there is no record at all: coverage is UNKNOWN, and whether a
 *     sibling archive is on disk travels back with it. A restore must not
 *     guess in either direction here - replacing a live store on a hunch
 *     destroys embeddings the archive never held, and reporting
 *     "excluded" would claim a check that never ran. The archive probe is
 *     what lets the caller say WHY the record is missing instead of
 *     asserting the snapshot is older than the feature.
 *
 * Runs without the writer lock: the staged file has a name of its own
 * beside the store, and the lock is held only across the renames. The
 * recovery point the caller takes after this step snapshots the live
 * store under that same lock, so holding it here would deadlock.
 */
function stageDerivedStore(
  vault: string,
  liveVault: string,
  runId: string,
  opts: SnapshotStoreOptions,
): { readonly result: RestoreDerivedStoreResult; readonly staged: StagedDerivedStore | null } {
  const record = readManifestSidecar(vault, runId)?.derived_store ?? null;
  // Probed once, for every branch, and deliberately independent of the
  // record: it is the only evidence that separates a snapshot with no
  // record from a snapshot whose record was lost after the archive landed.
  const storeArchivePresent = existsSync(snapshotStorePath(vault, runId));
  if (record === null) {
    return {
      result: Object.freeze({
        replaced: false,
        coverage_known: false,
        path: null,
        exclusion_reason: null,
        store_archive_present: storeArchivePresent,
      }),
      staged: null,
    };
  }
  if (!record.included) {
    return {
      result: Object.freeze({
        replaced: false,
        coverage_known: true,
        path: null,
        exclusion_reason: record.exclusion_reason,
        store_archive_present: storeArchivePresent,
      }),
      staged: null,
    };
  }

  const archive = snapshotStorePath(vault, runId);
  if (!existsSync(archive)) {
    // Unreachable through `restoreSnapshot`, which refuses this in its
    // pre-flight. Kept because a store swap must never begin against an
    // archive that is not there.
    throw new BrainSnapshotError(
      `manifest records a derived-store archive but ${archive} is absent`,
      runId,
    );
  }
  if (record.archive_sha256 !== null) {
    const actual = sha256Hex(readFileSync(archive));
    if (actual !== record.archive_sha256) {
      throw new BrainSnapshotError(
        `the derived-store archive ${archive} does not match the digest its manifest recorded ` +
          `(${record.archive_sha256}, found ${actual}); refusing before the Brain tree is touched`,
        runId,
      );
    }
  }
  // The manifest's `source_path` is where the store WAS; the live target
  // is where it is now. They differ when the operator moved the vault or
  // set a `search_db_path` override after the snapshot, and the live
  // answer is the one a restore must write to.
  const target = opts.derivedStorePath ?? liveDerivedStorePath(liveVault);
  mkdirSync(dirname(target), { recursive: true });
  // A name of this process's own: two restores staging at once must not
  // write into one file, and neither is under the lock yet.
  const incoming = `${target}${RESTORE_STAGING_SUFFIX}-${process.pid}-${randomBytes(4).toString("hex")}`;
  const discard = (): void => {
    for (const path of [incoming, ...WAL_SIBLING_SUFFIXES.map((s) => `${incoming}${s}`)]) {
      try {
        rmSync(path, { force: true });
      } catch {
        // best-effort: a leftover staged file is never opened as the store
      }
    }
  };
  try {
    decompressArchiveTo(archive, incoming, runId);
    try {
      assertStoreIsSound(incoming, runId);
    } catch (err) {
      throw new BrainSnapshotError(
        `the archived derived store failed verification after decompression: ${errorText(err)}`,
        runId,
        { cause: err },
      );
    }
    // Opening it for the check must not leave journal siblings to travel
    // with the rename; the decompressed file is complete on its own.
    for (const sidecar of WAL_SIBLING_SUFFIXES) rmSync(`${incoming}${sidecar}`, { force: true });
  } catch (err) {
    discard();
    if (err instanceof BrainSnapshotError || err instanceof BrainSnapshotToolingMissingError) {
      throw err;
    }
    throw new BrainSnapshotError(
      `failed to stage the derived store beside ${target}: ${errorText(err)}`,
      runId,
      { cause: err },
    );
  }
  return {
    result: Object.freeze({
      replaced: true,
      coverage_known: true,
      path: target,
      exclusion_reason: null,
      store_archive_present: true,
    }),
    staged: Object.freeze({ target, incoming, discard }),
  };
}

/**
 * The store's writer lock, taken before the Brain swap starts. Holding it
 * across the renames is what stops an index run from writing into the
 * file being replaced; taking it BEFORE the first rename is what turns
 * contention into a refusal rather than a half-finished restore.
 */
function acquireStoreLockForRestore(target: string, runId: string): () => void {
  try {
    return acquireWriterLockSync(target);
  } catch (err) {
    throw new BrainSnapshotError(
      `cannot take the derived store's writer lock (${errorText(err)}); refusing before the ` +
        "Brain tree is touched",
      runId,
      { cause: err },
    );
  }
}

/**
 * A store swap that failed between its two renames and could not put the
 * outgoing store back: the live path has no store, and the pre-restore
 * one is at the `.bak` path.
 */
class StoreSwapTornError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "StoreSwapTornError";
  }
}

/**
 * Rename the staged store over the live one. The caller holds the writer
 * lock.
 *
 * The same swap discipline `reindexVault` uses: the outgoing file is kept
 * as `.bak`, then a single atomic rename puts the replacement in place.
 * If that second rename fails, the `.bak` is renamed back, so the live
 * store is untouched; a {@link StoreSwapTornError} means even that failed.
 *
 * The WAL siblings of the OUTGOING file are removed after the swap. The
 * decompressed archive came from `VACUUM INTO` and is a complete
 * database on its own; an orphan `-wal` from the file it replaced would
 * make the next open fail with SQLITE_IOERR_SHORT_READ, which is the
 * exact failure `consolidateWal` exists to prevent on the reindex path.
 */
function commitDerivedStoreSwap(store: StagedDerivedStore, runId: string): void {
  const { target, incoming } = store;
  const outgoing = `${target}${RESTORE_BACKUP_SUFFIX}`;
  rmSync(outgoing, { force: true });
  const hadLive = existsSync(target);
  if (hadLive) renameWithRetry(target, outgoing);
  try {
    renameWithRetry(incoming, target);
  } catch (err) {
    if (!hadLive) throw err;
    try {
      renameWithRetry(outgoing, target);
    } catch (backErr) {
      throw new StoreSwapTornError(
        `${errorText(err)}; the pre-restore store could not be renamed back either ` +
          `(${errorText(backErr)}) and is at ${outgoing}, where the next store open restores it`,
        { cause: err },
      );
    }
    throw err;
  }
  for (const sidecar of WAL_SIBLING_SUFFIXES) {
    try {
      rmSync(`${target}${sidecar}`, { force: true });
    } catch (err) {
      console.error(
        `snapshot[${runId}]: warning: could not remove ${target}${sidecar} after the restore: ` +
          errorText(err),
      );
    }
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
  if (compressor === "zstd") {
    // `zstd -o` opens the destination itself and refuses an existing one.
    runCompressor("zstd", ["-d", "-q", "-o", outPath, archive], runId);
    return;
  }
  // gzip is inflated in-process (no `gzip` binary on native Windows);
  // `wx` keeps the destination exclusive.
  let bytes: Buffer;
  try {
    bytes = gunzipSync(readFileSync(archive));
  } catch (err) {
    throw new BrainSnapshotError(
      `gzip decompress failed: ${(err as Error).message ?? String(err)}`,
      runId,
    );
  }
  writeArchiveExclusive(outPath, bytes, runId);
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
