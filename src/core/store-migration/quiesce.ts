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
 * finds the first's gate and is refused. Every release, removal and
 * takeover of the gate runs under the same lock; when it cannot be had
 * within its wait the gate is left as it is and the caller reports busy.
 *
 * What a run decided before it held the gate (the device is not switched,
 * its run state, the vault marker, the done records, the store) another
 * run may have changed by the time it holds it: each run reads those facts
 * again once it holds the gate, and stops before its first write when one
 * changed (`migrate.ts`, `rollback.ts`, `removal.ts`).
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
import { gateHolderLiveness } from "./holder-liveness.ts";
import { processStartIdentity } from "./process-identity.ts";
import { sameVaultPath } from "./removal-marker.ts";

/** The default settle period, in milliseconds. */
export const MIGRATION_SETTLE_MS = 2000;

/**
 * The prefix of a migration run's id (`migrate-<time>`). A rollback's
 * gate (`rollback-<run>`) and a removal's carry their own, so a gate can
 * be told to be a migration's from its run id alone.
 */
export const MIGRATION_RUN_PREFIX = "migrate-";

/** Whether the gate's run is a migration run (not a rollback or a removal). */
export function migrationRunGate(gate: MigrationGate): boolean {
  return gate.run_id.startsWith(MIGRATION_RUN_PREFIX);
}

/**
 * The run id of a migration run's gate on `vault`, whatever its holder,
 * or null (no gate, a damaged or unreadable one, another vault's, or a
 * rollback's or a removal's). The callers that may open such a gate on a
 * machine that has not switched pass it to {@link releaseStoppedRunGate},
 * which opens it only when its holder is gone.
 */
export function migrationGateOn(vault: string): string | null {
  const state = readMigrationGateState();
  if (state.kind !== "held" || !sameVaultPath(state.gate.vault, vault)) return null;
  return migrationRunGate(state.gate) ? state.gate.run_id : null;
}

/** The gate is held by another run; nothing was changed. */
export class MigrationGateBusyError extends Error {
  override readonly name = "MigrationGateBusyError";
}

/**
 * Whether the process that took `gate` may still run: its pid is alive and,
 * when the gate recorded a start identity that can be read again, it is the
 * same process. A pid reused by another process is not the holder.
 */
export function holderMayRun(gate: MigrationGate): boolean {
  return gateHolderLiveness(gate, "exact") !== "dead";
}

/** Whether the process that took `gate` is running: pid alive, same start identity. */
function holderProvablyRuns(gate: MigrationGate): boolean {
  return gateHolderLiveness(gate, "exact") === "alive";
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

/**
 * Open the gate a stopped run left closed: the gate names `vault` and the
 * run `runId`, and its holder is gone. This is the state a run that threw
 * leaves (its own `finally` opens the gate) reached for a run that was
 * killed instead, and it is what every way of going on with such a run
 * does when it ends before it takes the gate over itself: a resume the
 * dry run or a preflight refuses, a refusal of the automatic worker, a
 * manual run told to resume. The machine is then on the legacy layout and
 * writable, its run still `in-progress` for a later resume. The same
 * holds for a run killed after it took the gate and before it put itself
 * on record: nothing names it, and it changed nothing.
 *
 * A live holder, another run or another vault is left alone. Returns
 * whether the gate is gone, read again under the gate lock after the
 * removal: a removal the file system refused (a sharing violation on
 * Windows) answers false, so the caller keeps the cleanup owed.
 */
export function releaseStoppedRunGate(vault: string, runId: string): boolean {
  const state = readMigrationGateState();
  if (state.kind !== "held") return false;
  if (!sameVaultPath(state.gate.vault, vault) || state.gate.run_id !== runId) return false;
  return withGateLock((): boolean => {
    const now = readMigrationGateState();
    if (now.kind !== "held") return false;
    const gate = now.gate;
    if (!sameVaultPath(gate.vault, vault) || gate.run_id !== runId || holderMayRun(gate)) {
      return false;
    }
    releaseMigrationGate(gate.vault, gate.run_id);
    return readMigrationGateState().kind === "none";
  });
}

/**
 * Whether the gate a stopped run left on `vault` is still there: it names
 * `vault` and the run `runId`, and its holder is gone. What a caller asks
 * when {@link releaseStoppedRunGate} answered false, to tell a gate it
 * could not open from one that was not its to open.
 */
export function stoppedRunGateRemains(vault: string, runId: string): boolean {
  const state = readMigrationGateState();
  if (state.kind !== "held") return state.kind === "unreadable";
  const gate = state.gate;
  return sameVaultPath(gate.vault, vault) && gate.run_id === runId && !holderMayRun(gate);
}

/**
 * Open the gate again, when the run `runId` still holds it: the gate names
 * `vault` and the run, and its holder is this process or one that cannot
 * run any more. The check and the removal run under the gate lock, as every
 * release, removal and takeover of the gate does: a dead holder's gate read
 * without it could be the one a resumed run wrote a moment later. When the
 * lock stays busy past its wait the gate is left as it is and this throws
 * {@link MigrationGateBusyError}; the next run that recovers a stopped
 * run's gate opens it (`gate-decision.ts`), or the operator's forced
 * release once this process has ended.
 */
export function releaseGateFor(vault: string, runId: string): void {
  const started = processStartIdentity(process.pid);
  const release = (): void => {
    const state = readMigrationGateState();
    if (state.kind === "damaged") {
      releaseMigrationGate("", "");
      return;
    }
    if (state.kind !== "held") return;
    const gate = state.gate;
    if (!sameVaultPath(gate.vault, vault) || gate.run_id !== runId) return;
    // The vault and the run id are not enough: two processes resume the
    // same run, and the one refused at the gate must not open the other's.
    const ownProcess =
      gate.pid === process.pid && (gate.started === undefined || gate.started === started);
    if (!ownProcess && holderMayRun(gate)) return;
    releaseMigrationGate(gate.vault, gate.run_id);
  };
  try {
    withGateLock(release);
  } catch (error) {
    if (!(error instanceof MigrationGateBusyError)) throw error;
    throw new MigrationGateBusyError(
      `the migration gate of run ${runId} stays closed: another process held its lock past ` +
        "the wait. The next start opens it once this process has ended, or run " +
        "`o2b brain migrate-store --force-release-gate` then",
    );
  }
}

/**
 * The release at the end of a run that held the gate ({@link releaseGateFor}):
 * a release the gate lock refuses never hides why the run stopped. With
 * `failure` (the run is throwing) the busy release is added to that error's
 * message and the run's own error goes on; without it (the run ended) the
 * busy release is the run's answer, so its caller reports busy instead of a
 * finished run whose gate stayed closed.
 */
export function releaseGateAfter(
  vault: string,
  runId: string,
  failure: { readonly error: unknown } | null,
): void {
  try {
    releaseGateFor(vault, runId);
  } catch (cleanup) {
    if (failure === null) throw cleanup;
    if (failure.error instanceof Error) failure.error.message += `; ${(cleanup as Error).message}`;
  }
}

/** Close the gate on `vault` for the run `runId`, then wait `settleMs`. */
export function quiesceLegacyWriters(vault: string, runId: string, settleMs: number): void {
  holdGateFor(vault, runId);
  if (settleMs > 0) sleepSync(settleMs);
}

/** Open the gate the run `runId` holds ({@link releaseGateFor}). */
export function liftQuiesce(vault: string, runId: string): void {
  releaseGateFor(vault, runId);
}
