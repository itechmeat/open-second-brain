/**
 * Every write the automatic migration worker makes outside the migration
 * gate (change auto-store-migration, design D2), each made only while
 * the worker still holds its claim on the worker lock.
 *
 * What guards what:
 *
 *  - The migration itself (the store's records, the legacy tree, the
 *    switch) runs inside the migration gate, which `migrateStore` closes
 *    for its whole run and which no automatic path takes over from a
 *    holder that may still run (`gate-decision.ts`, rule 1). Two
 *    migrations of one vault never overlap, whatever the claim says.
 *  - The managed-file upgrade runs under the upgrade worker's own lock.
 *  - Everything else the worker writes (its attempt record and what
 *    replaces it, the waiting state, the success outputs and their marks,
 *    the one-time notice, the metrics row, the brain log line, the store
 *    it creates) is guarded by the worker claim alone. A claim can be
 *    taken over while its holder still runs: the exact judge replaces a
 *    holder whose identity cannot be told after an hour. So each of these
 *    writes is made under the claim's mutex, after checking that the
 *    claim is still this worker's ({@link underOwnAutoMigrationClaim}).
 *    Every claim and takeover takes the same mutex, so once a claim is
 *    taken over its old holder writes nothing more: each write throws
 *    {@link AutoMigrationClaimLostError} instead.
 *
 * The worker gets these writes only once it holds a claim, so its
 * decision before the claim cannot write anything: this module is the
 * only place it reaches the writers from (a guard test checks its
 * imports).
 */

import { mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

import { ensureBrainStore } from "../brain/init-store.ts";
import { appendLogEvent, type BrainLogEntry } from "../brain/log.ts";
import { appendMetric, type AppendMetricInput } from "../brain/metrics.ts";
import { atomicWriteFileSync } from "../fs-atomic.ts";
import {
  autoMigrationStatePath,
  clearAutoMigrationState,
  dropShownAutoMigrationNotice,
  markAutoMigrationSuccessWritten,
  recordAutoMigrationAttempt,
  recordAutoMigrationFailure,
  recordAutoMigrationGateOwed,
  recordAutoMigrationNotice,
  recordAutoMigrationUnfinishedSwitch,
  recordAutoMigrationWaiting,
  settleAutoMigrationGateOwed,
  underOwnAutoMigrationClaim,
  type AutoMigrationFailure,
  type AutoMigrationSuccessOutput,
  type AutoMigrationWaiting,
} from "./auto-state.ts";

export { AutoMigrationClaimLostError } from "./auto-state.ts";

/** The worker's writes, each made only while it holds the claim `token`. */
export interface ClaimedWrites {
  attempt(now: Date): AutoMigrationFailure;
  failure(error: string, opts: { manualCommand: string; now: Date }): AutoMigrationFailure;
  waiting(
    wait: {
      missing: ReadonlyArray<string>;
      firstMachines: ReadonlyArray<string>;
      reason?: string | null;
      awaitsStore?: boolean;
    },
    now: Date,
  ): AutoMigrationWaiting;
  unfinishedSwitch(reason: string, now: Date): AutoMigrationFailure;
  gateOwed(runId: string, reason: string, now: Date): AutoMigrationFailure;
  settleGateOwed(runId: string): void;
  markWritten(output: AutoMigrationSuccessOutput): void;
  clear(): void;
  /** Put the state file back as it was (`raw`, or none). */
  restore(raw: string | null): void;
  notice(notice: { snapshot: string | null; runId?: string | null }, now: Date): void;
  dropShownNotice(): void;
  metric(input: AppendMetricInput): void;
  logEvent(event: BrainLogEntry): void;
  createStore(cfg: { configPath?: string }): void;
}

/** The writes of the worker holding the claim `token` on `vault`'s worker lock. */
export function claimedWrites(vault: string, token: string): ClaimedWrites {
  const owned = <T>(write: () => T): T => underOwnAutoMigrationClaim(vault, token, write);
  return {
    attempt: (now) => owned(() => recordAutoMigrationAttempt(vault, now)),
    failure: (error, opts) => owned(() => recordAutoMigrationFailure(vault, error, opts)),
    waiting: (wait, now) => owned(() => recordAutoMigrationWaiting(vault, wait, now)),
    unfinishedSwitch: (reason, now) =>
      owned(() => recordAutoMigrationUnfinishedSwitch(vault, reason, now)),
    gateOwed: (runId, reason, now) =>
      owned(() => recordAutoMigrationGateOwed(vault, runId, reason, now)),
    settleGateOwed: (runId) => owned(() => settleAutoMigrationGateOwed(vault, runId)),
    markWritten: (output) => owned(() => markAutoMigrationSuccessWritten(vault, output)),
    clear: () => owned(() => clearAutoMigrationState(vault)),
    restore: (raw) =>
      owned(() => {
        const path = autoMigrationStatePath(vault);
        if (raw === null) {
          try {
            unlinkSync(path);
          } catch {
            // already gone
          }
          return;
        }
        mkdirSync(dirname(path), { recursive: true });
        atomicWriteFileSync(path, raw);
      }),
    notice: (notice, now) => owned(() => recordAutoMigrationNotice(vault, notice, now)),
    dropShownNotice: () => owned(() => dropShownAutoMigrationNotice(vault)),
    metric: (input) => owned(() => appendMetric(vault, input)),
    logEvent: (event) => owned(() => void appendLogEvent(vault, event)),
    createStore: (cfg) => owned(() => void ensureBrainStore(cfg)),
  };
}
