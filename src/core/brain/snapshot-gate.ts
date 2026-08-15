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
 * The engine module stays untouched; this sibling only composes its
 * public functions.
 */

import { existsSync } from "node:fs";

import { loadSnapshotRetentionSafe } from "./policy.ts";
import { isFileAlreadyExists } from "../fs-atomic.ts";
import { collisionCandidateName, snapshotPath, validateRunId } from "./paths.ts";
import { createSnapshot, pruneSnapshots } from "./snapshot.ts";
import { compactRunStamp } from "./time.ts";
import type { BrainSnapshotReason } from "./types.ts";

/** The recovery point minted for a destructive operation. */
export interface DestructiveSnapshot {
  /** Validated run id of the archive (`<reason>-<stamp>`). */
  readonly runId: string;
  /** Absolute path of the snapshot archive. */
  readonly path: string;
}

export interface WithDestructiveSnapshotResult<T> {
  readonly snapshot: DestructiveSnapshot;
  readonly result: T;
}

/** Options of both entry points here, since both mint one run id. */
export interface WithDestructiveSnapshotOptions {
  /**
   * Injected clock. It decides the run-id stamp AND the `snapshot` audit
   * line's timestamp, so a caller whose output is byte-reproducible given
   * its own clock stays that way across the recovery point it takes.
   */
  readonly now?: Date;
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
): DestructiveSnapshot {
  let lostRace: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const candidate = collisionCandidateName(baseRunId, attempt);
    if (existsSync(snapshotPath(vault, candidate))) continue;
    try {
      return { runId: candidate, path: create(candidate) };
    } catch (err) {
      if (!isFileAlreadyExists(err)) throw err;
      lostRace = err;
    }
  }
  throw new Error(
    `could not reserve a unique snapshot run id from "${baseRunId}" after ${maxAttempts} attempts`,
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
 * Retention runs here rather than after the caller's operation, and that
 * is safe by arithmetic rather than by luck: the configured
 * `retention_count` is a positive integer and this archive is the newest
 * in the directory, so the prune can never evict the point it just made.
 * A prune failure is a warning, never a throw - the recovery point exists,
 * and refusing the caller's operation because a cleanup pass could not run
 * would trade a real guarantee for a tidy directory.
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
  );

  try {
    pruneSnapshots(vault, loadSnapshotRetentionSafe(vault));
  } catch (err) {
    process.stderr.write(
      `warning: snapshot prune after ${snapshot.runId} failed (the recovery point is intact): ${
        (err as Error).message ?? String(err)
      }\n`,
    );
  }

  return snapshot;
}

/**
 * Run `op` behind a pre-operation snapshot. Returns the recovery point
 * alongside the operation's result. See the module header for the
 * abort / retain failure semantics.
 */
export function withDestructiveSnapshot<T>(
  vault: string,
  reason: BrainSnapshotReason,
  op: () => T,
  opts: WithDestructiveSnapshotOptions = {},
): WithDestructiveSnapshotResult<T> {
  // The one snapshot path, shared with the standalone entry point. A
  // throw here aborts before `op` runs - the destructive work never
  // happens.
  const snapshot = takeSnapshot(vault, reason, opts);

  // Run the destructive operation. If it throws, the error propagates and
  // the archive above stays exactly where it is: it is the recovery point
  // the caller now needs.
  const result = op();

  return { snapshot, result };
}
