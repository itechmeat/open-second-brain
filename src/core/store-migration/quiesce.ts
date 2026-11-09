/**
 * Quiescing this machine's legacy writers for a migration (design D11
 * step 2): the migration holds the device-local migration gate
 * (`migration-gate.ts`), so every content writer on this machine
 * refuses with a migration-in-progress message, then waits a settle
 * period for writes that passed the gate before it closed. The final delta
 * pass imports whatever those in-flight writes left.
 *
 * The gate never syncs: other machines keep writing during the run, and
 * their writes reach the store through the delta pass and the transition
 * import (`transition.ts`). A resumed run re-holds the gate an
 * interrupted run left.
 *
 * The gate is one file per machine, so a run never takes it from another:
 * a gate naming another vault is refused (that vault's interrupted run
 * still needs its writers stopped), and so is one naming the same vault
 * whose process is still alive (another run, or a second invocation of
 * the same run). A damaged gate file is replaced, and one that cannot be
 * read at all is refused until it can. A run opens only the gate it holds.
 *
 * The gate records its holder's pid and start identity
 * (`process-identity.ts`). A live pid whose start identity differs from
 * the recorded one belongs to an unrelated process that reused the pid of
 * a crashed run, so the gate is stale. When the identity cannot be told
 * (a gate from an older release, a query that failed) a live pid counts
 * as the holder, and the operator's remedy is {@link forceReleaseGate}
 * (`o2b brain migrate-store --force-release-gate`), which refuses only
 * while the recorded holder is provably alive.
 *
 * Reading the gate, judging its holder and writing the new gate happen
 * under a device-local lock beside the gate file, so two runs that ask at
 * the same moment cannot both find it free and both hold it: the second
 * finds the first's gate and is refused.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { resolveLockWaitBudgetMs } from "../brain/sync-lockfile.ts";
import { sleepSync } from "../fs-atomic.ts";
import {
  holdMigrationGate,
  type MigrationGate,
  migrationGatePath,
  readMigrationGateState,
  releaseMigrationGate,
} from "../migration-gate.ts";
import { acquireDirLock, STORE_LOCK_STALE_MS } from "../store/local-lock.ts";
import { processStartIdentity } from "./process-identity.ts";
import { sameVaultPath } from "./removal-marker.ts";

/** The default settle period, in milliseconds. */
export const MIGRATION_SETTLE_MS = 2000;

/** The gate is held by another run; nothing was changed. */
export class MigrationGateBusyError extends Error {
  override readonly name = "MigrationGateBusyError";
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Whether the process that took `gate` may still run: its pid is alive and,
 * when the gate recorded a start identity that can be read again, it is the
 * same process. A pid reused by another process is not the holder.
 */
function holderMayRun(gate: MigrationGate): boolean {
  if (!processAlive(gate.pid)) return false;
  if (gate.started === undefined) return true;
  const now = processStartIdentity(gate.pid);
  return now === null || now === gate.started;
}

/** Whether the process that took `gate` is running: pid alive, same start identity. */
function holderProvablyRuns(gate: MigrationGate): boolean {
  return (
    gate.started !== undefined &&
    processAlive(gate.pid) &&
    processStartIdentity(gate.pid) === gate.started
  );
}

/** How {@link holdGateFor} treats a same-vault gate whose holder has died. */
export interface HoldGateOptions {
  /**
   * Whether a dead run's gate on this vault may be taken over: a resume or
   * a rollback takes over what the interrupted run left (the default). A
   * removal passes a predicate, so it never lifts a gate an interrupted
   * migration or rollback still relies on.
   */
  readonly takeOver?: (gateRunId: string) => boolean;
}

/**
 * Hold the gate on `vault` for the run `runId`, unless another run holds
 * it (see the module header); re-holding this run's own gate in the same
 * process is a no-op.
 */
export function holdGateFor(vault: string, runId: string, options: HoldGateOptions = {}): void {
  // Read before the lock: on Windows it is a PowerShell query.
  const started = processStartIdentity(process.pid);
  withGateLock(() => holdUnderLock(vault, runId, started, options));
}

/** Run `fn` holding the lock that makes a gate's check and write one step. */
function withGateLock<T>(fn: () => T): T {
  const target = migrationGatePath();
  mkdirSync(dirname(target), { recursive: true });
  let release: () => void;
  try {
    release = acquireDirLock(target, {
      staleMs: STORE_LOCK_STALE_MS,
      budgetMs: resolveLockWaitBudgetMs(),
      label: "migration gate lock",
      remedy: "another run is taking the migration gate of this machine; try again in a moment",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
    throw new MigrationGateBusyError(`${(error as Error).message}; nothing was changed`);
  }
  try {
    return fn();
  } finally {
    release();
  }
}

function holdUnderLock(
  vault: string,
  runId: string,
  started: string | null,
  options: HoldGateOptions,
): void {
  const state = readMigrationGateState();
  if (state.kind === "unreadable") {
    throw new MigrationGateBusyError(
      `the migration gate of this machine cannot be read (${state.code}); nothing was changed. ` +
        "Try again in a moment",
    );
  }
  if (state.kind === "held") {
    const gate = state.gate;
    if (!sameVaultPath(gate.vault, vault)) {
      throw new MigrationGateBusyError(
        `the migration gate of this machine is held by run ${gate.run_id} of another vault; ` +
          "finish or resume that run first",
      );
    }
    const ownProcess =
      gate.run_id === runId &&
      gate.pid === process.pid &&
      (gate.started === undefined || gate.started === started);
    if (!ownProcess && holderMayRun(gate)) {
      throw new MigrationGateBusyError(
        `run ${gate.run_id} (process ${gate.pid}) holds the migration gate of this vault; ` +
          "wait for it to finish",
      );
    }
    if (gate.run_id !== runId && options.takeOver?.(gate.run_id) === false) {
      throw new MigrationGateBusyError(
        `the interrupted run ${gate.run_id} still holds the migration gate of this vault; ` +
          "resume or roll it back first",
      );
    }
  }
  holdMigrationGate(vault, runId, started);
}

/** What {@link forceReleaseGate} found and did. */
export type ForcedGateRelease =
  | { readonly kind: "none" }
  | { readonly kind: "damaged" }
  | { readonly kind: "released"; readonly gate: MigrationGate };

/**
 * The operator's remedy for a gate left by a run that is gone: release it
 * whatever run or vault it names, unless its recorded holder is provably
 * still running (same pid, same start identity). A gate whose holder
 * cannot be told apart from a reused pid (no recorded identity, or a
 * query that failed) is released: the operator vouches the run is gone.
 * The interrupted run itself still needs `--resume` or `--rollback`.
 */
export function forceReleaseGate(): ForcedGateRelease {
  return withGateLock((): ForcedGateRelease => {
    const state = readMigrationGateState();
    if (state.kind === "none") return { kind: "none" };
    if (state.kind === "unreadable") {
      throw new MigrationGateBusyError(
        `the migration gate of this machine cannot be read (${state.code}); nothing was ` +
          "changed. Try again in a moment",
      );
    }
    if (state.kind === "damaged") {
      releaseMigrationGate("", "");
      return { kind: "damaged" };
    }
    const gate = state.gate;
    if (holderProvablyRuns(gate)) {
      throw new MigrationGateBusyError(
        `run ${gate.run_id} (process ${gate.pid}) is still running and holds the migration ` +
          `gate of ${gate.vault}; nothing was changed. Let it finish`,
      );
    }
    releaseMigrationGate(gate.vault, gate.run_id);
    return { kind: "released", gate };
  });
}

/** Open the gate again, when the run `runId` still holds it. */
export function releaseGateFor(vault: string, runId: string): void {
  releaseMigrationGate(vault, runId);
}

/** Close the gate on `vault` for the run `runId`, then wait `settleMs`. */
export function quiesceLegacyWriters(vault: string, runId: string, settleMs: number): void {
  holdGateFor(vault, runId);
  if (settleMs > 0) sleepSync(settleMs);
}

/** Open the gate the run `runId` holds. */
export function liftQuiesce(vault: string, runId: string): void {
  releaseGateFor(vault, runId);
}
