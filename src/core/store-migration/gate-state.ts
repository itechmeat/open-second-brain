/**
 * Gathers the state {@link decideGate} decides on (change
 * auto-store-migration): the reads, in the order of their cost, for each
 * asker. A start judges a holder by its pid alone and reads its expensive
 * fields (the legacy tree walk, the run state) only when the cheap ones do
 * not decide; the worker, `o2b update` and the reports judge exactly.
 */

import { autoStoreMigrationSetting } from "../config.ts";
import { type MigrationGateState, readMigrationGateState } from "../migration-gate.ts";
import {
  migrationAvailability,
  type MigrationAvailability,
} from "../store/migration-availability.ts";
import { ownMigrationRunRead, type OwnMigrationRunRead } from "./auto-probe.ts";
import {
  AUTO_MIGRATION_LIVE_PID_CEILING_MS,
  autoMigrationBackoffActive,
  autoMigrationWaitStillFresh,
  readAutoMigrationFailure,
  readAutoMigrationWaiting,
} from "./auto-state.ts";
import {
  decideGate,
  switchProvenFinished,
  type AttemptSeen,
  type GateAsker,
  type GateDecision,
  type GateSeen,
  type GateState,
  type RollbackSeen,
  type RunSeen,
} from "./gate-decision.ts";
import { gateHolderLiveness, type HolderJudge } from "./holder-liveness.ts";
import { MIGRATION_RUN_PREFIX } from "./quiesce.ts";
import { sameVaultPath } from "./removal-marker.ts";

/** The prefix of a rollback's gate run id. */
export const ROLLBACK_RUN_PREFIX = "rollback-";

/** How a holder is judged: the pid alone, or its start identity too. */
export type GateJudge = HolderJudge;

/** The judgement an asker uses: a start never queries an identity. */
export function judgeOf(asker: GateAsker): GateJudge {
  return asker === "start" ? "cheap" : "exact";
}

/** The gate as `judge` sees it on `vault` ({@link GateSeen}). */
export function gateSeen(
  state: MigrationGateState,
  vault: string,
  judge: GateJudge,
  now: Date,
): GateSeen {
  if (state.kind !== "held") return { kind: state.kind };
  const gate = state.gate;
  const run = gate.run_id.startsWith(MIGRATION_RUN_PREFIX)
    ? "migration"
    : gate.run_id.startsWith(ROLLBACK_RUN_PREFIX)
      ? "rollback"
      : "removal";
  const holder = gateHolderLiveness(gate, judge);
  const since = Date.parse(gate.since);
  const aged =
    !Number.isFinite(since) || now.getTime() - since > AUTO_MIGRATION_LIVE_PID_CEILING_MS;
  return {
    kind: "held",
    vault: gate.vault,
    ours: sameVaultPath(gate.vault, vault),
    run,
    runId: gate.run_id,
    holder,
    aged,
  };
}

/**
 * The attempt record as read. A waiting state counts only while it is
 * fresh and the store it waits for has not arrived (`storeAbsent`).
 */
export function attemptSeen(vault: string, now: Date, storeAbsent: boolean): AttemptSeen {
  const failure = readAutoMigrationFailure(vault);
  if (failure !== null) {
    return {
      kind: failure.attempt ? "attempt" : "failure",
      cooling: autoMigrationBackoffActive(failure, now),
      owed: failure.gateOwed !== null,
    };
  }
  const waiting = readAutoMigrationWaiting(vault);
  const fresh = waiting !== null && storeAbsent && autoMigrationWaitStillFresh(waiting, now);
  return { kind: fresh ? "waiting" : "none", cooling: false, owed: false };
}

/**
 * Whether the run state just read proves this device's switch finished
 * ({@link switchProvenFinished}, on the device's own switched bit).
 */
export function switchProvenRead(read: OwnMigrationRunRead): boolean {
  return read.kind === "run" && switchProvenFinished(read.run.switched, runSeen(read));
}

/** This device's run state as read: a read that fails is `unreadable`, never `none`. */
export function runSeen(read: OwnMigrationRunRead): RunSeen {
  if (read.kind === "absent") return { phase: "none" };
  if (read.kind === "unreadable" || read.run.state.kind === "unreadable") {
    return { phase: "unreadable" };
  }
  if (read.run.state.kind === "absent") return { phase: "none" };
  const state = read.run.state.state;
  switch (state.phase) {
    case "in-progress":
      return { phase: "in-progress", runId: state.run_id };
    case "failed":
    case "done":
    case "rolled-back":
      return { phase: state.phase };
    default:
      return { phase: "unreadable" };
  }
}

/**
 * This machine's rollback record as read with the run state: a read of
 * the record that fails is `unreadable`, never none. A store that cannot
 * be inspected reads no record at all; its run state reads unreadable,
 * which no automatic attempt migrates over, so that answer stands for both.
 */
export function rollbackSeen(read: OwnMigrationRunRead): RollbackSeen {
  if (read.kind !== "run") return "none";
  switch (read.run.rollback) {
    case "absent":
      return "none";
    case "there":
      return "unfinished";
    case "unreadable":
      return "unreadable";
  }
}

/** What a gathered decision also read, for the caller that acts on it. */
export interface GateContext {
  readonly gate: MigrationGateState;
  readonly availability: MigrationAvailability | null;
  readonly own: OwnMigrationRunRead;
}

export interface GatheredGate {
  readonly state: GateState;
  readonly decision: GateDecision;
  readonly context: GateContext;
}

export interface GatherGateOptions {
  readonly vault: string;
  readonly configPath?: string | undefined;
  readonly asker: GateAsker;
  readonly now: Date;
  /**
   * Whether the machine switched, when the caller knows it (a start knows
   * it from its store-only answer): no tree walk is needed to tell.
   */
  readonly switched?: boolean;
  /** How the holder is judged; the asker's own judgement ({@link judgeOf}) by default. */
  readonly judge?: GateJudge;
  /** The caller's own availability answer, so the probe is paid once. */
  readonly availability?: MigrationAvailability;
}

/**
 * Read the state for `opts.asker`, cheap reads first, and decide. The
 * legacy tree walk and the run state are read only when the cheap reads do
 * not decide (a start), or always (every other asker, which also needs
 * them to act).
 */
export function gatherGate(opts: GatherGateOptions): GatheredGate {
  const { vault, configPath, asker, now } = opts;
  const cfg = configPath !== undefined ? { configPath } : {};
  const setting = autoStoreMigrationSetting(configPath).enabled;
  const gateState = readMigrationGateState();
  const gate = gateSeen(gateState, vault, opts.judge ?? judgeOf(asker), now);
  const cheapOnly = asker === "start" && opts.switched !== undefined;
  if (cheapOnly) {
    const own: OwnMigrationRunRead =
      opts.switched === true ? ownMigrationRunRead(configPath) : { kind: "absent" };
    const state: GateState = {
      asker,
      setting,
      switched: opts.switched === true,
      gate,
      // A switched machine's store is there, so a wait for a store to
      // arrive is moot to it, as to the full reads; an unswitched one's
      // wait is told apart once the store side is read.
      record: attemptSeen(vault, now, opts.switched !== true),
      run: opts.switched === true ? runSeen(own) : null,
      rollback: opts.switched === true ? rollbackSeen(own) : null,
      payload: null,
    };
    const decision = decideGate(state);
    if (decision.act !== "gather") {
      return { state, decision, context: { gate: gateState, availability: null, own } };
    }
  }
  const availability = opts.availability ?? migrationAvailability({ vault, ...cfg });
  // The run is read unless the store is known to be absent: when the
  // store side could not be answered, the run read itself tells a store
  // that cannot be read (an unreadable run, never no run: it could be one
  // the operator rolled back) from one that is not there.
  const own: OwnMigrationRunRead =
    availability.storeExists === false && !availability.switched
      ? { kind: "absent" }
      : ownMigrationRunRead(configPath);
  const switched =
    opts.switched ?? (availability.switched || (own.kind === "run" && own.run.switched));
  const state: GateState = {
    asker,
    setting,
    switched,
    gate,
    record: attemptSeen(vault, now, availability.storeExists === false),
    run: runSeen(own),
    rollback: rollbackSeen(own),
    payload: availability.available,
  };
  return { state, decision: decideGate(state), context: { gate: gateState, availability, own } };
}

/**
 * The stopped migration run's gate on this vault the gathered state saw
 * (its holder is gone): `own-run` when this device's run in progress is
 * the gate's, `other` otherwise; null when there is none.
 */
export function stoppedGateOf(g: GatheredGate): "own-run" | "other" | null {
  const gate = g.state.gate;
  if (gate?.kind !== "held" || !gate.ours || gate.run !== "migration" || gate.holder !== "dead") {
    return null;
  }
  const run = g.state.run;
  return run?.phase === "in-progress" && run.runId === gate.runId ? "own-run" : "other";
}

/**
 * The run id of the gate an "open" decision opens: this vault's gate whose
 * holder is gone, a stopped migration run's or a finished rollback's
 * (gate decision rule 11); null when the gathered state saw none.
 */
export function openableGateRun(g: GatheredGate): string | null {
  const gate = g.state.gate;
  if (gate?.kind !== "held" || !gate.ours || gate.holder !== "dead" || gate.run === "removal") {
    return null;
  }
  return gate.runId;
}
