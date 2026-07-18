/**
 * Snapshot-before-destructive-write gate (D1 / t_7965b04b).
 *
 * A thin wrapper over the existing `snapshot.ts` engine that makes one
 * guarantee: no destructive brain mutation runs without a recovery
 * point on disk first. The wrapper mints a validated, unique run id,
 * calls {@link createSnapshot} BEFORE the operation, runs the
 * operation, then prunes to the configured retention.
 *
 * Failure semantics (the reason this is a gate and not a helper):
 *
 *   - If the snapshot cannot be written, the typed snapshot error
 *     propagates and `op` NEVER runs - a destructive operation that
 *     cannot be protected must abort, never proceed unprotected.
 *   - If `op` throws, the error propagates but the snapshot STAYS on
 *     disk - it is precisely the recovery point the caller needs. We
 *     therefore skip the post-run prune on the throwing path.
 *
 * The engine module (656 lines) stays untouched; this sibling only
 * composes its public functions.
 */

import { existsSync } from "node:fs";

import { loadSnapshotRetentionSafe } from "./policy.ts";
import { snapshotPath, validateRunId } from "./paths.ts";
import { createSnapshot, pruneSnapshots } from "./snapshot.ts";
import { compactRunStamp } from "./time.ts";

/** The recovery point minted for a destructive operation. */
export interface DestructiveSnapshot {
  /** Validated run id of the archive (`<label>-<stamp>`). */
  readonly runId: string;
  /** Absolute path of the snapshot archive. */
  readonly path: string;
}

export interface WithDestructiveSnapshotResult<T> {
  readonly snapshot: DestructiveSnapshot;
  readonly result: T;
}

export interface WithDestructiveSnapshotOptions {
  /** Injected clock so callers can mint deterministic run ids in tests. */
  readonly now?: Date;
}

/** Upper bound on run-id collision retries before giving up. */
const MAX_SNAPSHOT_ID_ATTEMPTS = 64;

/**
 * Create the recovery snapshot behind a unique run id. Selection and
 * creation are fused so a concurrent process cannot win the id between an
 * availability probe and the write: we start from `<label>-<compactStamp>`,
 * append `-2`, `-3`, ... on collision, and RETRY `createSnapshot` when the
 * write fails because the archive now exists (a racing process claimed it).
 * Any other create failure (missing tooling, unwritable archive) propagates
 * on the first attempt. Mirrors the collision strategy `nextAvailableDreamRunId`
 * uses in `dream.ts`, but closes the check-then-write race window.
 */
function createUniqueSnapshot(
  vault: string,
  baseRunId: string,
): { runId: string; snapshot: ReturnType<typeof createSnapshot> } {
  for (let n = 1; n <= MAX_SNAPSHOT_ID_ATTEMPTS; n++) {
    const candidate = n === 1 ? baseRunId : `${baseRunId}-${n}`;
    if (existsSync(snapshotPath(vault, candidate))) continue;
    try {
      return { runId: candidate, snapshot: createSnapshot(vault, candidate) };
    } catch (err) {
      // A concurrent op may have created this archive between our probe and
      // the write; createSnapshot refuses to overwrite. Retry the next id
      // only for that collision - any other failure is a real error.
      if (!existsSync(snapshotPath(vault, candidate))) throw err;
    }
  }
  throw new Error(
    `could not reserve a unique snapshot run id from "${baseRunId}" after ${MAX_SNAPSHOT_ID_ATTEMPTS} attempts`,
  );
}

/**
 * Run `op` behind a pre-operation snapshot. Returns the recovery point
 * alongside the operation's result. See the module header for the
 * abort / retain failure semantics.
 */
export function withDestructiveSnapshot<T>(
  vault: string,
  label: string,
  op: () => T,
  opts: WithDestructiveSnapshotOptions = {},
): WithDestructiveSnapshotResult<T> {
  // validateRunId rejects a label that would form a filesystem-unsafe
  // id (separators, traversal, Windows-reserved) - a typed error before
  // any snapshot or mutation is attempted.
  const baseRunId = validateRunId(`${label}-${compactRunStamp(opts.now ?? new Date())}`);

  // Snapshot FIRST, behind a collision-safe unique id. A throw here (missing
  // tooling, unwritable archive) aborts before `op` runs - the destructive
  // work never happens.
  const { runId, snapshot: snap } = createUniqueSnapshot(vault, baseRunId);

  // Run the destructive operation. If it throws, we deliberately do NOT
  // prune: the archive we just wrote is the recovery point, and letting
  // the error propagate keeps it in place.
  const result = op();

  // Prune is best-effort: the destructive op has already committed, so a
  // prune failure must NOT surface as an operation failure (that could
  // trigger an unsafe retry of committed work). Retention is a cleanup
  // concern, not a correctness one - warn and keep the successful result.
  try {
    pruneSnapshots(vault, loadSnapshotRetentionSafe(vault));
  } catch (err) {
    process.stderr.write(
      `warning: snapshot prune after ${runId} failed (operation already committed): ${
        (err as Error).message ?? String(err)
      }\n`,
    );
  }

  return { snapshot: { runId, path: snap.path }, result };
}
