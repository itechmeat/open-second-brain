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

/**
 * Resolve a unique run id: start from `<label>-<compactStamp>` and, if
 * an archive already exists at that id (two destructive ops in the same
 * second), append `-2`, `-3`, ... until free. Mirrors the collision
 * strategy `nextAvailableDreamRunId` uses in `dream.ts`, but probes only
 * the snapshot archive since this gate has no separate workrun artifact.
 */
function nextAvailableSnapshotRunId(vault: string, baseRunId: string): string {
  let candidate = baseRunId;
  for (let n = 2; existsSync(snapshotPath(vault, candidate)); n++) {
    candidate = `${baseRunId}-${n}`;
  }
  return candidate;
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
  const runId = nextAvailableSnapshotRunId(vault, baseRunId);

  // Snapshot FIRST. A throw here (missing tooling, unwritable archive)
  // aborts before `op` runs - the destructive work never happens.
  const snap = createSnapshot(vault, runId);

  // Run the destructive operation. If it throws, we deliberately do NOT
  // prune: the archive we just wrote is the recovery point, and letting
  // the error propagate keeps it in place.
  const result = op();

  pruneSnapshots(vault, loadSnapshotRetentionSafe(vault));

  return { snapshot: { runId, path: snap.path }, result };
}
