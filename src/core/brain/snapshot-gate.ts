/**
 * Snapshot-before-destructive-write gate (D1 / t_7965b04b).
 *
 * A thin wrapper over the existing `snapshot.ts` engine that makes one
 * guarantee: no destructive brain mutation runs without a recovery
 * point on disk first. The wrapper mints a validated, unique run id,
 * calls {@link createSnapshot} BEFORE the operation, runs the
 * operation, then returns the recovery point alongside its result.
 *
 * Failure semantics (the reason this is a gate and not a helper):
 *
 *   - If the snapshot cannot be written, the typed snapshot error
 *     propagates and `op` NEVER runs - a destructive operation that
 *     cannot be protected must abort, never proceed unprotected.
 *   - If `op` throws, the error propagates but the snapshot STAYS on
 *     disk - it is precisely the recovery point the caller needs.
 *
 * ## One entry point, two callers
 *
 * {@link takeSnapshot} is the whole snapshot-and-prune path, exported so
 * that a caller wanting a recovery point with NO operation behind it has
 * somewhere to go. {@link withDestructiveSnapshot} calls it and then runs
 * the operation, which is what keeps the id minting, the collision
 * resolution and the retention pass in exactly one place: a second path
 * would be a second set of rules for the archives an operator later has
 * to reason about as one family.
 *
 * ## The snapshot is not the verdict
 *
 * A recovery point covers the top-level entries under `Brain/` and, on
 * request, the derived store. It has never covered anything else, so an
 * operation reaching past that is protected for part of what it destroys
 * and reported as if it were protected for all of it. Every result here
 * therefore carries a {@link RecoverabilityVerdict} beside the archive:
 * the archive says what was taken, the verdict says what it is worth.
 * See `gates/recoverability.ts`.
 *
 * The engine module stays untouched; this sibling only composes its
 * public functions.
 */

import { existsSync } from "node:fs";

import { loadSnapshotRetentionSafe } from "./policy.ts";
import { isFileAlreadyExists } from "../fs-atomic.ts";
import {
  classifyRecoverability,
  DEFAULT_DESTRUCTIVE_BLAST_RADIUS,
  type DestructiveBlastRadius,
  type RecoverabilityVerdict,
} from "./gates/recoverability.ts";
import { collisionCandidateName, snapshotPath, validateRunId } from "./paths.ts";
import {
  BrainSnapshotError,
  createSnapshot,
  pruneSnapshots,
  restoreSnapshot,
  type PruneSnapshotsResult,
  type RecoveryPointEvidence,
  type RestoreSnapshotOptions,
  type RestoreSnapshotResult,
} from "./snapshot.ts";
import { compactRunStamp } from "./time.ts";
import { BRAIN_SNAPSHOT_REASON, type BrainSnapshotReason } from "./types.ts";

/** The recovery point minted for a destructive operation. */
export interface DestructiveSnapshot {
  /** Validated run id of the archive (`<reason>-<stamp>`). */
  readonly runId: string;
  /** Absolute path of the snapshot archive. */
  readonly path: string;
  /**
   * What the retention pass behind this snapshot removed, or `null` when
   * the pass itself failed (the warning on stderr is the other half of
   * that answer).
   *
   * Carried rather than discarded because retention is the one
   * destructive operation nobody authorises: it runs on every snapshot
   * and every dream, and it used to trim archives - the operator's only
   * way back - with no report of any kind.
   */
  readonly prune: PruneSnapshotsResult | null;
}

export interface WithDestructiveSnapshotResult<T> {
  readonly snapshot: DestructiveSnapshot;
  readonly result: T;
  /**
   * What the recovery point above is actually worth for THIS operation.
   *
   * The snapshot alone was never the answer: it covers the top-level
   * entries under `Brain/` and, on request, the derived store, and an
   * operation whose blast radius leaves that is protected for part of
   * what it destroys and nothing else. Reporting the archive path with no
   * verdict beside it reads as full coverage to every caller, which is
   * the misleading success this gate exists to prevent.
   */
  readonly recoverability: RecoverabilityVerdict;
}

/** Options of both entry points here, since both mint one run id. */
export interface WithDestructiveSnapshotOptions {
  /**
   * Injected clock. It decides the run-id stamp AND the `snapshot` audit
   * line's timestamp, so a caller whose output is byte-reproducible given
   * its own clock stays that way across the recovery point it takes.
   */
  readonly now?: Date;
  /**
   * What the operation is about to destroy. Absent means
   * {@link DEFAULT_DESTRUCTIVE_BLAST_RADIUS} - the Brain tree - because
   * that is the premise of being behind this gate at all. A caller that
   * reaches further declares it and gets a qualified verdict instead of a
   * clean one.
   */
  readonly blastRadius?: DestructiveBlastRadius;
  /**
   * True when this snapshot carried the derived SQLite store. Absent
   * means it did not: `snapshots.include_derived_store` is opt-in, so the
   * default install archives the Markdown tree only, and assuming
   * otherwise would claim coverage over an index no archive holds.
   */
  readonly derivedStoreArchived?: boolean;
  /**
   * An EXTRA availability test the reserved run id must also pass.
   *
   * The dream pass names its workrun after the same id as its archive,
   * so a candidate free in `.snapshots/` is not necessarily free for it.
   * That used to be a second collision ladder in `dream.ts` with its own
   * bound and its own error message, laddering the same
   * {@link collisionCandidateName} sequence as this one - two rules for
   * one id. Absent means the archive directory is the only claim on the
   * name.
   */
  readonly available?: (runId: string) => boolean;
  /**
   * Archives the retention pass behind this snapshot must not remove, on
   * top of the snapshot itself (which is always protected).
   *
   * One caller needs it: the rollback takes its recovery point in the
   * middle of a restore, and the archive being restored is still being
   * read - its manifest sidecar, its derived-store archive - after that
   * point lands. At the default retention of 10 the target is evicted
   * whenever it is the 10th-oldest or older.
   */
  readonly protectRunIds?: ReadonlyArray<string>;
}

/** Upper bound on distinct run ids tried before giving up. */
const MAX_SNAPSHOT_ID_ATTEMPTS = 64;

/**
 * Create the recovery snapshot behind a unique run id. Selection and
 * creation are fused so a concurrent process cannot win the id between an
 * availability probe and the write: we start from `<reason>-<compactStamp>`,
 * ladder through `-2`, `-3`, ... via the shared
 * {@link collisionCandidateName}, and retry when the create reports that
 * the name was already taken.
 *
 * The retry is keyed on the TYPED collision predicate. It used to be keyed
 * on re-running `existsSync` after the throw, which answered a different
 * question than the one being asked: any failure that happened to leave
 * bytes at the path - a compressor that died part-way through its output -
 * read as a collision, was retried up to the bound, and was finally
 * reported as an id exhaustion naming neither the real failure nor its
 * cause. Only "the name was taken" retries now; everything else propagates
 * from the attempt that raised it.
 *
 * `create` is injected for the same reason `allocateAndCreate` takes one:
 * it is the seam that makes the lost-race behaviour testable as a
 * deterministic replay rather than as two processes that may or may not
 * overlap. {@link takeSnapshot} passes the real {@link createSnapshot}.
 *
 * `available` is the caller's EXTRA claim on the name, for a run id that
 * has to be free somewhere else too. It exists so there is one ladder
 * rather than two: the dream pass had its own copy, over the same
 * candidate sequence, with a different bound.
 *
 * Caveat worth stating rather than hiding: `createSnapshot` today flattens
 * its own "refusing to overwrite an existing archive" into an untyped
 * `BrainSnapshotError`, so a genuinely lost race reaches the operator as
 * that loud, accurate error instead of being retried here. Making it
 * retryable is a one-line change in `snapshot.ts` (carry the collision as
 * `cause`), deliberately left outside this unit's file scope. Loud and
 * correct beats silently retried and mislabelled.
 */
export function createUniqueSnapshot(
  vault: string,
  baseRunId: string,
  create: (runId: string) => string,
  maxAttempts: number = MAX_SNAPSHOT_ID_ATTEMPTS,
  available: (runId: string) => boolean = () => true,
): DestructiveSnapshot {
  let lostRace: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const candidate = collisionCandidateName(baseRunId, attempt);
    if (existsSync(snapshotPath(vault, candidate))) continue;
    if (!available(candidate)) continue;
    try {
      return { runId: candidate, path: create(candidate), prune: null };
    } catch (err) {
      if (!isFileAlreadyExists(err)) throw err;
      lostRace = err;
    }
  }
  // Deliberately untyped, and the reason is worth stating because every
  // other failure out of this module carries a `BrainSnapshotError` with
  // a run id on it. A typed snapshot error IDENTIFIES an archive - that
  // is what its `runId` field is for, and what a caller narrows on to
  // report or retry against one. This failure is precisely the case where
  // no run id was reserved, so the typed shape could only be filled with
  // a candidate that does not exist and never will. There is also no
  // caller branch to enable: after `maxAttempts` laddered candidates the
  // remedy is the same one an unwritable archive gets - abort, and let the
  // operator look at `.snapshots/`. A distinguishable type buys nothing
  // and would have to lie about a run id to exist at all.
  throw new Error(
    `could not reserve a unique snapshot run id from "${baseRunId}" after ${maxAttempts} ` +
      "attempts; every candidate was already claimed, in Brain/.snapshots/ or by the caller's " +
      "own claim on the name - prune the archive directory, or check that it is readable",
    lostRace === undefined ? undefined : { cause: lostRace },
  );
}

/**
 * Write one recovery point for `reason` and enforce retention around it.
 *
 * The reason is required and doubles as the run-id label, so the archive's
 * filename and its recorded provenance can never disagree. It is also
 * what a later reader filters the revertible history by, which is why it
 * is a member of a closed vocabulary rather than a free label: five call
 * sites used to spell their labels three different ways and nothing
 * parsed any of them back.
 *
 * Retention runs here rather than after the caller's operation, and the
 * point it just made survives it for two reasons that are checked rather
 * than assumed. It used to be neither: the claim was that the archive is
 * "the newest in the directory" so the prune cannot reach it, but
 * {@link listSnapshots} orders by MTIME. One archive whose mtime is ahead
 * of the clock - `rsync -t`, `cp -p`, NFS skew, a stepped clock - and at
 * retention 1 the prune evicted this very archive, while the gate
 * reported `covered` and ran the caller's operation over nothing.
 *
 * So: the run id is PROTECTED in the prune call
 * ({@link PruneSnapshotsOptions.protectRunIds}), which makes the survival
 * structural rather than dependent on a sort; and
 * {@link assertRecoveryPointOnDisk} then confirms the archive is really
 * there, which is what covers the removals this module does not perform -
 * a peer process, an operator, a half-finished mount.
 *
 * A prune failure is a warning, never a throw - the recovery point exists,
 * and refusing the caller's operation because a cleanup pass could not run
 * would trade a real guarantee for a tidy directory. A MISSING recovery
 * point is the opposite and throws: from there on, every promise this
 * module makes about the caller's operation would be false.
 *
 * What the prune DID travels back on the result, and a refusal is
 * announced on stderr rather than absorbed. A retention that silently
 * declined to run - or that removed nine archives - is the same silence
 * whether it came from a bad configuration or a permission error, and
 * neither used to reach anyone.
 */
export function takeSnapshot(
  vault: string,
  reason: BrainSnapshotReason,
  opts: WithDestructiveSnapshotOptions = {},
): DestructiveSnapshot {
  // Resolved once and used for both the run id and the audit line, so the
  // two can never name different instants.
  const now = opts.now ?? new Date();

  // validateRunId rejects a reason + stamp that would form a
  // filesystem-unsafe id (separators, traversal, Windows-reserved) - a
  // typed error before any snapshot or mutation is attempted.
  const baseRunId = validateRunId(`${reason}-${compactRunStamp(now)}`);

  // Snapshot behind a collision-safe unique id. A throw here (missing
  // tooling, unwritable archive, refused derived-store coverage) reaches
  // the caller with nothing left on disk.
  // The clock that minted the id also stamps the audit line, so a caller
  // with an injected clock stays byte-reproducible across its snapshot.
  const snapshot = createUniqueSnapshot(
    vault,
    baseRunId,
    (runId) => createSnapshot(vault, runId, { reason, now }).path,
    MAX_SNAPSHOT_ID_ATTEMPTS,
    opts.available,
  );

  let prune: PruneSnapshotsResult | null = null;
  try {
    prune = pruneSnapshots(vault, loadSnapshotRetentionSafe(vault), {
      // This archive, plus whatever else the caller is standing on: the
      // rollback is mid-restore and still reading the archive it is
      // restoring out of the same directory.
      protectRunIds: [snapshot.runId, ...(opts.protectRunIds ?? [])],
    });
    if (prune.refusal !== null) {
      process.stderr.write(
        `warning: snapshot retention after ${snapshot.runId} declined to run ` +
          `(${prune.refusal}); ${prune.retained} archive(s) kept\n`,
      );
    }
    for (const path of prune.failed) {
      process.stderr.write(
        `warning: snapshot retention after ${snapshot.runId} could not remove ${path}\n`,
      );
    }
  } catch (err) {
    process.stderr.write(
      `warning: snapshot prune after ${snapshot.runId} failed: ${
        (err as Error).message ?? String(err)
      }\n`,
    );
  }

  // Whether the recovery point is intact is now ANSWERED rather than
  // asserted in the warning above.
  assertRecoveryPointOnDisk(snapshot.runId, snapshot.path);

  return { ...snapshot, prune };
}

/**
 * Confirm the recovery point is on disk, and throw loudly when it is not.
 *
 * The one check that turns this module's promise into a fact. Everything
 * downstream - the caller's destructive operation, the `covered` verdict,
 * the archive path in the result - is conditional on an archive existing,
 * and until this ran nothing ever looked: the gate reported the path it
 * had asked for rather than the file that was there.
 *
 * A throw rather than a downgraded verdict, and the reason is the same
 * one the module header gives for a snapshot that cannot be written: an
 * operation that cannot be protected must abort. Downgrading to
 * `unproven` would let `dream`, `deleteBySource --confirm` and the note
 * delete run unprotected behind a warning nobody reads.
 */
export function assertRecoveryPointOnDisk(runId: string, path: string): void {
  if (existsSync(path)) return;
  throw new BrainSnapshotError(
    `the recovery point ${path} is not on disk after the retention pass behind it; refusing to ` +
      "run a destructive operation that has nothing to fall back to - check Brain/.snapshots/ " +
      "and snapshots.retention_count",
    runId,
  );
}

/**
 * Run `op` behind a pre-operation snapshot. Returns the recovery point,
 * the operation's result, and the verdict saying what that recovery point
 * is worth for this particular blast radius. See the module header for
 * the abort / retain failure semantics.
 *
 * `op` receives the recovery point it is protected by, so an operation
 * that needs the reserved run id - to name a workrun, a log file, or a
 * staged bundle after the same id - does not have to mint a second one
 * and hope the two agree.
 */
export function withDestructiveSnapshot<T>(
  vault: string,
  reason: BrainSnapshotReason,
  op: (snapshot: DestructiveSnapshot) => T,
  opts: WithDestructiveSnapshotOptions = {},
): WithDestructiveSnapshotResult<T> {
  // The one snapshot path, shared with the standalone entry point. A
  // throw here aborts before `op` runs - the destructive work never
  // happens.
  const snapshot = takeSnapshot(vault, reason, opts);

  // Run the destructive operation. If it throws, the error propagates and
  // the archive above stays exactly where it is: it is the recovery point
  // the caller now needs.
  const result = op(snapshot);

  return { snapshot, result, recoverability: recoverabilityOf(opts) };
}

/**
 * The verdict for a snapshot that WAS taken. Split out because both
 * entry points need it and because a caller reaching past this module -
 * an operation that cannot be gated at all, such as the prune that
 * destroys recovery points - has to be able to build the same verdict
 * with `recoveryPoint: false` from the same vocabulary.
 */
function recoverabilityOf(opts: WithDestructiveSnapshotOptions): RecoverabilityVerdict {
  return classifyRecoverability({
    recoveryPoint: true,
    blastRadius: opts.blastRadius ?? DEFAULT_DESTRUCTIVE_BLAST_RADIUS,
    derivedStoreArchived: opts.derivedStoreArchived === true,
  });
}

/** What a gated restore returns: the restore, plus what it saved first. */
export interface RestoreWithRecoveryPointResult extends RestoreSnapshotResult {
  /** The archive of the live tree, taken immediately before it was discarded. */
  readonly recoveryPoint: DestructiveSnapshot;
}

/**
 * Restore an archive over `Brain/`, having first archived the live tree
 * the restore is about to discard.
 *
 * A rollback deletes every live top-level entry under `Brain/`. The
 * ladder in front of it is the strongest in this codebase - a manifest
 * drift refusal, `--yes` in non-interactive mode, a `--force-rollback`
 * recorded in the log - and behind it there was nothing at all: an
 * operator who picked the wrong run id had no way back.
 *
 * The recovery point is minted with {@link BRAIN_SNAPSHOT_REASON.manual},
 * which was declared as "an operator asking for a recovery point with no
 * operation behind it" and had no producer since it was written. That is
 * exactly this: the operation behind it belongs to the archive being
 * restored, not to the tree being saved.
 *
 * Three facts about the ordering are load-bearing and none is
 * incidental. The point is taken AFTER extraction, so a corrupt or
 * missing archive leaves no archive of a tree the restore never touched.
 * The point lands in `.snapshots/`, which the restore's own deletion
 * excludes - that exclusion is what makes this recoverable rather than a
 * snapshot the next step erases. And the archive BEING RESTORED is named
 * in `protectRunIds`, because extraction is not the end of the restore's
 * reading: the manifest sidecar and the derived-store archive are still
 * read out of `.snapshots/` afterwards, and the retention pass behind
 * this recovery point used to remove them mid-restore - at the default
 * retention of 10, whenever the target was the 10th-oldest or older. With
 * `include_derived_store` on, that turned a covered store into "coverage
 * unknown, nothing restored", silently.
 *
 * The recovery point is also what the restore's verdict is derived from:
 * it hands the archive back as {@link RecoveryPointEvidence}, and
 * `restoreSnapshot` probes that path rather than reading `covered` off
 * the fact that a callback was supplied.
 */
export function restoreSnapshotWithRecoveryPoint(
  vault: string,
  runId: string,
  opts: RestoreSnapshotOptions & WithDestructiveSnapshotOptions = {},
): RestoreWithRecoveryPointResult {
  let recoveryPoint: DestructiveSnapshot | null = null;
  const result = restoreSnapshot(vault, runId, {
    ...opts,
    beforeDiscard: (): RecoveryPointEvidence => {
      const point = takeSnapshot(vault, BRAIN_SNAPSHOT_REASON.manual, {
        ...opts,
        protectRunIds: [runId, ...(opts.protectRunIds ?? [])],
      });
      recoveryPoint = point;
      return { runId: point.runId, path: point.path };
    },
  });
  if (recoveryPoint === null) {
    // Unreachable while `restoreSnapshot` honours its own contract, and
    // a throw rather than a fabricated value because the alternative is
    // reporting a recovery point that does not exist - which is the
    // failure this whole unit is about.
    throw new Error(
      `restoreSnapshotWithRecoveryPoint: restore of "${runId}" completed without taking the ` +
        "recovery point it was asked for",
    );
  }
  return { ...result, recoveryPoint };
}
