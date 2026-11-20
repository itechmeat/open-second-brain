/**
 * What this machine's automatic store migration stands at (change
 * auto-store-migration, design D6): one state, with what the next start
 * will do and what the operator can run. The store status block, the
 * doctor's migration finding, `o2b brain upgrade --dry-run` and the
 * session start notices word their answer from it, so they never
 * disagree.
 *
 * Read-only and cheap: the availability probe the status block already
 * pays (`migrationAvailability`), the opt-out, and the three device-local
 * files of `auto-state.ts`. It never claims, writes or clears anything.
 */

import {
  describeSelfHealUpgradeLock,
  readSelfHealUpgradeLock,
} from "../maintenance/self-heal-upgrade-state.ts";
import { autoStoreMigrationSetting, describeAutoStoreMigrationProblem } from "../config.ts";
import {
  MIGRATE_STORE_COMMAND,
  type MigrationAvailability,
} from "../store/migration-availability.ts";
import {
  switchProvenFinished,
  type GateDecision,
  type GateNone,
  type GateRefusal,
} from "./gate-decision.ts";
import { gatherGate, stoppedGateOf } from "./gate-state.ts";
import type { OwnMigrationRunRead } from "./auto-probe.ts";
import {
  describeMigrationGateProgress,
  readMigrationGateProgress,
  type MigrationGateProgress,
} from "../migration-gate.ts";
import {
  AUTO_MIGRATION_ROLLBACK_COMMAND,
  type AutoMigrationFailure,
  type AutoMigrationRunning,
  autoMigrationBackoffActive,
  describeAutoMigrationFailure,
  printable,
  readAutoMigrationFailure,
  readAutoMigrationRunning,
  describeAutoMigrationRunning,
  describeLostAutoMigrationWorker,
  readAutoMigrationWaiting,
  readLostAutoMigrationWorker,
  reportableText,
  type AutoMigrationWaiting,
  AUTO_MIGRATION_LOCK_JUDGE,
  AUTO_MIGRATION_WAIT_RECHECK_MS,
  autoMigrationWaitStillFresh,
} from "./auto-state.ts";

/** The doctor, the status block and the upgrade plan can afford the exact check. */
const EXACT = { judge: AUTO_MIGRATION_LOCK_JUDGE.exact };

/** The states of the report. */
export const AUTO_MIGRATION_STATE = Object.freeze({
  /** No legacy data on this machine: nothing to migrate. */
  notNeeded: "not_needed",
  /** A migration is available; the next start runs it unless the machine opted out. */
  pending: "pending",
  /** The automatic worker runs now. */
  running: "running",
  /** A later machine waits for another device's cut to arrive by sync. */
  waiting: "waiting",
  /** The last automatic attempt failed. */
  failed: "failed",
  /** This machine switched to the brain store. */
  done: "done",
  /**
   * The operator rolled this machine back to the legacy layout: the
   * automatic migration never redoes that on its own, whatever the setting.
   */
  rolledBack: "rolled_back",
} as const);

export type AutoMigrationState = (typeof AUTO_MIGRATION_STATE)[keyof typeof AUTO_MIGRATION_STATE];

export interface AutoMigrationReport {
  readonly state: AutoMigrationState;
  /** The next start runs the migration on its own (not opted out, not switched). */
  readonly automatic: boolean;
  /** One operator sentence about the state. */
  readonly message: string;
  /** What the next session start or server start will do about it. */
  readonly nextStart: string;
  /** What the operator can run by hand, or `null`. */
  readonly manualCommand: string | null;
  /** `running`: the worker's process and claim time. */
  readonly pid: number | null;
  readonly since: string | null;
  /** `failed`: the reason and when the next automatic attempt is due. */
  readonly error: string | null;
  readonly retryAfter: string | null;
  /** `waiting`: the devices whose cut this machine waits for. */
  readonly firstMachines: ReadonlyArray<string>;
  /** `running`: how far the run's import is, when the run has recorded it. */
  readonly progress: { readonly journaled: number; readonly planned: number } | null;
  /**
   * Why the opt-out reads as off without a plain off value (an
   * unrecognised value, an unreadable machine config), or `null`.
   */
  readonly settingProblem: string | null;
}

export interface AutoMigrationReportSource {
  readonly vault: string;
  readonly configPath?: string | undefined;
  /** The caller's own availability answer, so the probe is paid once. */
  readonly availability?: MigrationAvailability;
  /** Clock for the lock staleness and the cooldown; defaults to wall clock. */
  readonly now?: Date;
}

function report(
  state: AutoMigrationState,
  fields: Partial<AutoMigrationReport> & Pick<AutoMigrationReport, "message" | "nextStart">,
): AutoMigrationReport {
  return Object.freeze({
    state,
    automatic: false,
    manualCommand: null,
    pid: null,
    since: null,
    error: null,
    retryAfter: null,
    firstMachines: [],
    progress: null,
    settingProblem: null,
    ...fields,
  });
}

/** What repairs a vault binding file that cannot be read. */
export const VAULT_BINDING_REPAIR_COMMAND = "o2b init --vault";

/** What a report is worded from besides the decision: plain data, read by {@link autoMigrationReport}. */
export interface ReportFacts {
  readonly now: Date;
  /** This device writes to the store only. */
  readonly switched: boolean;
  /** Switched, and the run that switched it is still `in-progress`. */
  readonly interrupted: boolean;
  /** This device's run state says the operator rolled it back. */
  readonly runRolledBack: boolean;
  readonly legacyDataPresent: boolean;
  readonly available: boolean;
  readonly nextCommands: ReadonlyArray<string>;
  /** Why the store or the vault binding could not be read, or null. */
  readonly error: string | null;
  /** The store is known to be absent. */
  readonly storeAbsent: boolean;
  /** The worker claim, when a worker runs. */
  readonly running: AutoMigrationRunning | null;
  /**
   * The worker a start spawned and handed its claim to exited before it
   * confirmed it ({@link describeLostAutoMigrationWorker}), as one
   * sentence; absent or null when there is none. The next start records it
   * as a failure.
   */
  readonly lostWorker?: string | null;
  readonly failure: AutoMigrationFailure | null;
  readonly waiting: AutoMigrationWaiting | null;
  readonly settingProblem: string | null;
  /**
   * A stopped migration run's gate on this vault (its holder is gone):
   * `own-run` when this device's run in progress is the gate's, `other`
   * otherwise; null when there is none.
   */
  readonly stoppedGate: "own-run" | "other" | null;
  /**
   * The switch is proven finished ({@link switchProvenFinished}): only then
   * is an automatic attempt's switch reported done.
   */
  readonly switchFinished: boolean;
  /**
   * A rollback of this vault began and did not finish (`unfinished`), or
   * its record cannot be read (`unreadable`); null when there is none or
   * the run state reads rolled back (gate decision rule 10).
   */
  readonly rollbackPending: "unfinished" | "unreadable" | null;
  /** How far this device's run in progress is (the gate's progress file, `migration-gate.ts`), or null. */
  readonly progress?: MigrationGateProgress | null;
  /**
   * A live managed-file upgrade of this machine holds its lock, which keeps
   * the migration worker from starting the migration (it runs the upgrade
   * first), as one sentence; absent or null otherwise. A claim another
   * machine's sync brought here holds nothing (`self-heal-upgrade-state.ts`).
   */
  readonly upgradeLock?: string | null;
}

/** The report for `vault` on this machine. Never throws on a missing file. */
export function autoMigrationReport(source: AutoMigrationReportSource): AutoMigrationReport {
  const now = source.now ?? new Date();
  const g = gatherGate({
    vault: source.vault,
    configPath: source.configPath,
    asker: "worker",
    now,
    ...(source.availability !== undefined ? { availability: source.availability } : {}),
  });
  const availability = g.context.availability!;
  return reportOf(g.decision, {
    now,
    switched: g.state.switched,
    interrupted: g.state.switched && g.state.run?.phase === "in-progress",
    runRolledBack: g.state.run?.phase === "rolled-back",
    legacyDataPresent: availability.legacyDataPresent,
    available: availability.available,
    nextCommands: availability.nextCommands,
    error: availability.error,
    storeAbsent: availability.storeExists === false,
    running: readAutoMigrationRunning(source.vault, now, EXACT),
    lostWorker: lostWorkerText(source.vault, now),
    failure: readAutoMigrationFailure(source.vault),
    waiting: readAutoMigrationWaiting(source.vault),
    settingProblem: describeAutoStoreMigrationProblem(autoStoreMigrationSetting(source.configPath)),
    stoppedGate: stoppedGateOf(g),
    switchFinished: switchProvenFinished(g.state.switched, g.state.run),
    rollbackPending:
      g.state.rollback === null ||
      g.state.rollback === "none" ||
      g.state.run?.phase === "rolled-back"
        ? null
        : g.state.rollback,
    progress: runProgress(g.context.own),
    upgradeLock: upgradeLockText(source.vault, now),
  });
}

/** The live upgrade holding the migration off on `vault`, as one sentence, or null. */
function upgradeLockText(vault: string, now: Date): string | null {
  try {
    const holder = readSelfHealUpgradeLock(vault, now);
    return holder.kind === "here" ? describeSelfHealUpgradeLock(holder) : null;
  } catch {
    return null;
  }
}

/** The lost worker's sentence for `vault`, or null (read judged exactly). */
function lostWorkerText(vault: string, now: Date): string | null {
  const lost = readLostAutoMigrationWorker(vault, now, EXACT);
  return lost === null ? null : describeLostAutoMigrationWorker(vault, lost, null);
}

/** A worker that exited before it started, before any start recorded it. */
function lostWorkerReport(text: string): AutoMigrationReport {
  return report(AUTO_MIGRATION_STATE.failed, {
    automatic: true,
    message: `${reportableText(text)}; run \`${MIGRATE_STORE_COMMAND}\` to run it yourself`,
    nextStart: "records this as a failed attempt and starts nothing until its cooldown has run out",
    manualCommand: MIGRATE_STORE_COMMAND,
    error: reportableText(text),
  });
}

/** The progress file of this device's run in progress, or null. */
function runProgress(own: OwnMigrationRunRead): MigrationGateProgress | null {
  if (own.kind !== "run" || own.run.state.kind !== "state") return null;
  const state = own.run.state.state;
  if (state.phase !== "in-progress") return null;
  return readMigrationGateProgress(state.run_id);
}

/** A path as one shell argument: quoted when it holds a space or a shell character. */
function shellArg(path: string): string {
  return /^[\w@%+=:,./\\-]+$/.test(path) ? path : `"${path.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** The refusal a gate decision names, as one operator sentence and the command that clears it. */
export function refusalReason(d: Extract<GateDecision, { act: "refuse" }>): {
  readonly text: string;
  readonly command: string;
  /**
   * What ends the refusal the other way, as a clause naming its command:
   * on a switched machine the plain migrate-store stays on the store and
   * ends an unfinished rollback. Null when only `command` ends it.
   */
  readonly stay: string | null;
} {
  const why: GateRefusal = d.why;
  if (why === "other-vault-gate" && d.holder !== null) {
    // Recovered from the vault that holds the gate: run from this vault,
    // the command would target this one, and the gate refuses it. It
    // finishes the run that stopped: a resume over a stopped rollback's
    // gate would migrate that vault again.
    const [what, finish] =
      d.holderRun === "rollback"
        ? ["rollback", "--rollback"]
        : d.holderRun === "removal"
          ? ["legacy tree removal", "--remove-legacy"]
          : ["migration", "--resume"];
    return {
      text: `a stopped ${what} of the vault ${printable(d.holder)} holds this machine's migration gate`,
      command: `${MIGRATE_STORE_COMMAND} --vault ${shellArg(d.holder)} ${finish}`,
      stay: null,
    };
  }
  switch (why) {
    case "interrupted-rollback":
      return {
        text: "an interrupted rollback still holds this vault's migration gate",
        command: AUTO_MIGRATION_ROLLBACK_COMMAND,
        stay: null,
      };
    case "interrupted-removal":
      return {
        text: "an interrupted legacy tree removal still holds this vault's migration gate",
        command: `${MIGRATE_STORE_COMMAND} --remove-legacy`,
        stay: null,
      };
    case "other-vault-gate":
      return {
        text: "a stopped migration of another vault holds this machine's migration gate",
        command: MIGRATE_STORE_COMMAND,
        stay: null,
      };
    case "unfinished-rollback":
    case "rollback-unreadable":
      return {
        text: why === "unfinished-rollback" ? UNFINISHED_ROLLBACK : UNREADABLE_ROLLBACK,
        command: AUTO_MIGRATION_ROLLBACK_COMMAND,
        // The rollback did not clear the switch: the operator may finish
        // it, or stay on the store, which ends it.
        stay: d.switched === true ? STAY_ON_STORE : null,
      };
  }
}

/** How a switched machine's surfaces name the command that stays on the store. */
const STAY_ON_STORE = `\`${MIGRATE_STORE_COMMAND}\` to end it and stay on the brain store`;

/**
 * What a refusal asks of the operator, as the clause after its reason:
 * finish what holds the gate, or, where the plain migrate-store ends it
 * too, either command.
 */
export function refusalAsk(refusal: ReturnType<typeof refusalReason>): string {
  return refusal.stay === null
    ? "finish it first"
    : `finish it with \`${refusal.command}\`, or run ${refusal.stay}`;
}

/** A rollback of this vault that began and did not finish, as every surface names it. */
const UNFINISHED_ROLLBACK = "a rollback of this vault began and did not finish";
/** A rollback record that cannot be read, as every surface names it. */
const UNREADABLE_ROLLBACK =
  "this machine's rollback record cannot be read, so a rollback of this vault may not have " +
  "finished; make the record readable";

/** The report of a rollback that began and did not finish, while the automatic migration is off. */
function pendingRollbackReport(
  pending: "unfinished" | "unreadable",
  f: ReportFacts,
): AutoMigrationReport {
  const text = pending === "unfinished" ? UNFINISHED_ROLLBACK : UNREADABLE_ROLLBACK;
  return report(AUTO_MIGRATION_STATE.failed, {
    message: `${text}; finish it with \`${AUTO_MIGRATION_ROLLBACK_COMMAND}\``,
    nextStart:
      "nothing: the automatic migration never migrates over a rollback, and it is off on this " +
      "machine",
    manualCommand: AUTO_MIGRATION_ROLLBACK_COMMAND,
    settingProblem: f.settingProblem,
  });
}

/**
 * A gate the next start opens on a machine the operator rolled back, or
 * began to roll back: nothing is migrated, and no command offered
 * migrates (gate decision rules 10 and 11).
 */
function rolledBackGate(f: ReportFacts): AutoMigrationReport {
  const closed =
    "content writes are refused until the gate is opened, which the next start does in the " +
    "background";
  if (f.rollbackPending !== null) {
    const text = f.rollbackPending === "unfinished" ? UNFINISHED_ROLLBACK : UNREADABLE_ROLLBACK;
    return report(AUTO_MIGRATION_STATE.failed, {
      automatic: true,
      message:
        `${text}, and a stopped run left this vault's migration gate closed; ${closed}; then ` +
        `finish the rollback with \`${AUTO_MIGRATION_ROLLBACK_COMMAND}\``,
      nextStart: "opens the stopped run's gate in the background, and migrates nothing",
      manualCommand: AUTO_MIGRATION_ROLLBACK_COMMAND,
    });
  }
  return report(AUTO_MIGRATION_STATE.failed, {
    automatic: true,
    message:
      "this machine was rolled back to the legacy layout, and a stopped run left this vault's " +
      `migration gate closed; ${closed} (or run \`${FORCE_RELEASE_GATE_COMMAND}\`)`,
    nextStart: "opens the stopped run's gate in the background, and migrates nothing",
    manualCommand: FORCE_RELEASE_GATE_COMMAND,
  });
}

/** What releases a gate whose run is gone, by hand. */
const FORCE_RELEASE_GATE_COMMAND = `${MIGRATE_STORE_COMMAND} --force-release-gate`;

/** A stopped migration run's gate on this vault: content writes are refused until the next start acts. */
function stoppedGate(nextStart: string, message: string): AutoMigrationReport {
  return report(AUTO_MIGRATION_STATE.failed, {
    automatic: true,
    message,
    nextStart,
    manualCommand: MIGRATE_STORE_COMMAND,
  });
}

function notNeeded(): AutoMigrationReport {
  return report(AUTO_MIGRATION_STATE.notNeeded, {
    message: "no legacy brain data on this machine; nothing to migrate",
    nextStart: "nothing",
  });
}

/** The failure, with when the next attempt is due. */
function failedReport(
  f: ReportFacts,
  failure: AutoMigrationFailure,
  automatic: boolean,
  nextStart?: string,
): AutoMigrationReport {
  return report(AUTO_MIGRATION_STATE.failed, {
    automatic,
    message: describeAutoMigrationFailure(failure),
    nextStart:
      nextStart ??
      (autoMigrationBackoffActive(failure, f.now)
        ? `nothing until ${failure.retryAfter}, then it tries again`
        : "tries again"),
    manualCommand: failure.manualCommand,
    error: failure.error,
    retryAfter: failure.retryAfter,
  });
}

/**
 * The report for the gate decision `d` (the worker's, judged exactly),
 * worded with the facts `f`: the state and what the next start does come
 * from the decision's answer and its reason alone, the facts only fill in
 * the details (the failure, the wait, the worker's process). Pure.
 */
export function reportOf(d: GateDecision, f: ReportFacts): AutoMigrationReport {
  const r = decisionReport(d, f);
  if (r.state !== AUTO_MIGRATION_STATE.running || f.progress == null) return r;
  // The run's one progress file: its step, and its counts once known.
  const { journaled, planned } = f.progress;
  return Object.freeze({
    ...r,
    message: `${r.message}; ${describeMigrationGateProgress(f.progress)}`,
    ...(journaled !== undefined && planned !== undefined
      ? { progress: { journaled, planned: Math.max(planned, journaled) } }
      : {}),
  });
}

function decisionReport(d: GateDecision, f: ReportFacts): AutoMigrationReport {
  const manual = f.nextCommands.join(", then ") || null;
  // The claim's answer first: a worker that runs is what happens now,
  // unless there is nothing to migrate or finish at all.
  const moot = d.act === "none" && (d.why === "not-available" || d.why === "nothing-left");
  if (f.running !== null && !moot) return noneReport("running", f, manual);
  const gateClosed =
    "a migration run stopped with this vault's migration gate closed; content writes are " +
    "refused until ";
  switch (d.act) {
    case "open":
      if (d.why === "rolled-back") return rolledBackGate(f);
      return stoppedGate(
        "opens the stopped run's gate in the background",
        `${gateClosed}the gate is opened, which the next start does in the background (or run ` +
          `\`${MIGRATE_STORE_COMMAND}\` to go on with the migration)`,
      );
    case "refuse": {
      const refusal = refusalReason(d);
      const or = refusal.stay === null ? "" : `, or ${refusal.stay}`;
      return report(AUTO_MIGRATION_STATE.failed, {
        automatic: true,
        message: `the automatic store migration is refused: ${refusal.text}; ${refusalAsk(refusal)}`,
        nextStart: `refuses again until it is finished: run \`${refusal.command}\`${or}`,
        manualCommand: refusal.command,
        ...(f.failure !== null ? { error: f.failure.error } : {}),
      });
    }
    case "migrate":
      if (f.stoppedGate === "own-run") {
        return stoppedGate(
          "finishes the stopped run in the background",
          `${gateClosed}that run is finished, which the next start does in the background (or ` +
            `run \`${MIGRATE_STORE_COMMAND}\`)`,
        );
      }
      if (f.stoppedGate === "other") {
        return stoppedGate(
          "goes on with the migration in the background",
          `${gateClosed}the migration goes on, which the next start does in the background (or ` +
            `run \`${MIGRATE_STORE_COMMAND}\`)`,
        );
      }
      if (f.waiting !== null) return waitingReport(f, f.waiting, "tries again");
      if (f.failure !== null) return failedReport(f, f.failure, true, "tries again");
      if (f.lostWorker != null) return lostWorkerReport(f.lostWorker);
      if (f.upgradeLock != null) {
        return report(AUTO_MIGRATION_STATE.pending, {
          automatic: true,
          message:
            "a migration into the brain store is available on this machine, and waits for " +
            `this machine's managed-file upgrade to end: ${reportableText(f.upgradeLock)}`,
          nextStart:
            "runs the migration in the background once that upgrade has ended (a claim older " +
            "than an hour is taken over)",
          manualCommand: manual,
        });
      }
      return report(AUTO_MIGRATION_STATE.pending, {
        automatic: true,
        message: "a migration into the brain store is available on this machine",
        nextStart: "runs the migration in the background",
        manualCommand: manual,
      });
    case "finish":
      if (f.stoppedGate !== null && !f.interrupted) {
        return stoppedGate(
          "opens the stopped run's gate in the background",
          `${gateClosed}the gate is opened, which the next start does in the background`,
        );
      }
      // Only a failure of the finishing itself is one; a record left from
      // before the switch is moot, and the next start clears it.
      if (f.interrupted && f.failure !== null && !f.failure.attempt) {
        return failedReport(f, f.failure, true);
      }
      if (f.interrupted) {
        return report(AUTO_MIGRATION_STATE.pending, {
          automatic: true,
          message:
            "this machine switched to the brain store, but the run that switched it did not " +
            "finish its last steps",
          nextStart: "finishes the switch in the background",
          manualCommand: MIGRATE_STORE_COMMAND,
        });
      }
      if (!f.switchFinished) {
        return report(AUTO_MIGRATION_STATE.pending, {
          automatic: true,
          message:
            "this machine switched to the brain store, but its migration run state does not " +
            "read back as done yet",
          nextStart: "finishes what is left in the background once it does",
          manualCommand: MIGRATE_STORE_COMMAND,
        });
      }
      return report(AUTO_MIGRATION_STATE.done, {
        message: "this machine switched to the brain store",
        nextStart:
          f.failure?.attempt === true
            ? "writes the automatic migration's last records in the background"
            : "clears what an earlier attempt left, in the background",
      });
    case "none":
      return noneReport(d.why, f, manual);
    default:
      // A start's answers (spawn, gather) are never the worker's.
      return report(AUTO_MIGRATION_STATE.pending, {
        automatic: true,
        message: "a migration into the brain store is available on this machine",
        nextStart: "runs the migration in the background",
        manualCommand: manual,
      });
  }
}

function waitingReport(
  f: ReportFacts,
  waiting: AutoMigrationWaiting,
  nextStart?: string,
): AutoMigrationReport {
  return report(AUTO_MIGRATION_STATE.waiting, {
    automatic: true,
    message:
      waiting.reason !== null
        ? `the automatic store migration waits: ${printable(waiting.reason)}`
        : waitingForCut(waiting),
    ...(waiting.reason === null ? { manualCommand: MIGRATE_STORE_COMMAND } : {}),
    nextStart:
      nextStart ??
      (f.storeAbsent && autoMigrationWaitStillFresh(waiting, f.now)
        ? "nothing until that store arrives by sync, or until " +
          `${new Date(Date.parse(waiting.since) + AUTO_MIGRATION_WAIT_RECHECK_MS).toISOString()}, ` +
          "when it looks at the synced log again"
        : "tries again"),
    since: waiting.since,
    firstMachines: waiting.firstMachines,
  });
}

function noneReport(why: GateNone, f: ReportFacts, manual: string | null): AutoMigrationReport {
  switch (why) {
    case "switch-unproven":
      // Nothing proves this switch finished, and nothing will on its own:
      // never reported done, and no start works on it again.
      return report(AUTO_MIGRATION_STATE.pending, {
        message:
          "this machine switched to the brain store, but its migration run state does not " +
          "record that the switch finished, so the automatic migration finishes and " +
          "announces nothing more",
        nextStart: `nothing: run \`${MIGRATE_STORE_COMMAND}\` to finish it by hand`,
        manualCommand: MIGRATE_STORE_COMMAND,
      });
    case "not-available":
      return notNeeded();
    case "nothing-left":
      if (!f.switched) return notNeeded();
      if (f.available && f.nextCommands.length === 0) {
        // The binding file cannot be read: it says nothing about the
        // vault, so the repair is what to report, not an import to offer.
        return report(AUTO_MIGRATION_STATE.pending, {
          message: `this machine switched to the brain store, but ${f.error ?? "its vault binding cannot be read"}`,
          nextStart: "nothing: the vault binding is repaired by hand",
          manualCommand: VAULT_BINDING_REPAIR_COMMAND,
        });
      }
      if (f.available) {
        // A vault configured after the switch: the transition import is
        // the operator's to run; the automatic path covers unswitched machines.
        return report(AUTO_MIGRATION_STATE.pending, {
          message:
            "this machine switched to the brain store, but this vault's legacy tree was never " +
            "imported",
          nextStart:
            "nothing: the automatic migration runs only on a machine that has not switched",
          manualCommand: manual,
        });
      }
      return report(AUTO_MIGRATION_STATE.done, {
        message: "this machine switched to the brain store",
        nextStart: "nothing",
      });
    case "disabled":
    case "skipped": {
      // The opt-out is read before the legacy tree and the run: an
      // opted-out machine with nothing to migrate has nothing to report
      // either, and a rolled-back one is reported as rolled back, never as
      // opted out (both start nothing).
      if (f.rollbackPending !== null) return pendingRollbackReport(f.rollbackPending, f);
      if (!f.legacyDataPresent) return notNeeded();
      if (f.runRolledBack) return noneReport("rolled-back", f, manual);
      const off =
        f.settingProblem !== null
          ? "nothing: the automatic migration is off on this machine; run it by hand"
          : "nothing: the automatic migration is off on this machine (auto_store_migration: " +
            "false); run it by hand";
      // A failure recorded before the opt-out stays reported: no start
      // retries it any more, and the manual command is what is left.
      if (f.failure !== null) {
        return report(AUTO_MIGRATION_STATE.failed, {
          message: describeAutoMigrationFailure(f.failure, { retries: false }),
          nextStart: off,
          manualCommand: f.failure.manualCommand,
          error: f.failure.error,
          settingProblem: f.settingProblem,
        });
      }
      // A worker lost before the opt-out: no start records or retries it
      // any more, so it is named here, with the command that is left.
      if (f.lostWorker != null) {
        return report(AUTO_MIGRATION_STATE.failed, {
          message:
            `${reportableText(f.lostWorker)}; no start runs the migration again while the ` +
            `automatic migration is off: run \`${MIGRATE_STORE_COMMAND}\` to run it yourself`,
          nextStart: off,
          manualCommand: MIGRATE_STORE_COMMAND,
          error: reportableText(f.lostWorker),
          settingProblem: f.settingProblem,
        });
      }
      return report(AUTO_MIGRATION_STATE.pending, {
        message:
          "a migration into the brain store is available on this machine" +
          (f.settingProblem !== null ? `; ${f.settingProblem}` : ""),
        nextStart: off,
        manualCommand: manual,
        settingProblem: f.settingProblem,
      });
    }
    case "rolled-back":
      return report(AUTO_MIGRATION_STATE.rolledBack, {
        message:
          "a migration into the brain store is available on this machine; this machine was " +
          "rolled back to the legacy layout",
        nextStart:
          "nothing: the automatic migration does not redo a rollback; run the migration by " +
          "hand when you want the brain store again",
        manualCommand: manual,
      });
    case "run-unreadable":
      if (f.switched) {
        // No proven switch: the automatic attempt's outputs, and any
        // record it left, wait until the state can be read.
        return report(AUTO_MIGRATION_STATE.waiting, {
          automatic: true,
          message:
            "this machine switched to the brain store, but its migration run state cannot be " +
            "read right now, so whether its switch finished is not known",
          nextStart: "nothing until this machine's migration run state can be read",
          manualCommand: MIGRATE_STORE_COMMAND,
        });
      }
      return report(AUTO_MIGRATION_STATE.waiting, {
        automatic: true,
        message:
          "the automatic store migration waits: this machine's migration run state cannot be " +
          "read right now, so it cannot tell whether a run was rolled back",
        nextStart: "nothing until this machine's migration run state can be read",
        manualCommand: MIGRATE_STORE_COMMAND,
      });
    case "waiting":
      return f.waiting !== null
        ? waitingReport(f, f.waiting)
        : report(AUTO_MIGRATION_STATE.waiting, {
            automatic: true,
            message: "the automatic store migration waits for a store to arrive by sync",
            nextStart: "nothing until that store arrives by sync",
          });
    case "backoff":
      return f.failure !== null
        ? failedReport(f, f.failure, true)
        : report(AUTO_MIGRATION_STATE.failed, {
            automatic: true,
            message: "the last automatic store migration attempt failed",
            nextStart: "tries again",
            manualCommand: MIGRATE_STORE_COMMAND,
          });
    case "running":
    case "other-vault-running": {
      const what =
        why === "other-vault-running"
          ? "a migration of another vault holds this machine's migration gate; this vault's " +
            "migration waits for it"
          : f.running !== null
            ? `the automatic store migration is ${f.interrupted ? "finishing the switch" : "running"} (${describeAutoMigrationRunning(f.running)})`
            : "a migration of this vault runs now and holds its migration gate";
      return report(AUTO_MIGRATION_STATE.running, {
        automatic: true,
        message: what,
        nextStart: "nothing: it leaves the running migration alone",
        pid: f.running?.pid ?? null,
        since: f.running?.since ?? null,
      });
    }
  }
}

/** The snake_case form for the JSON surfaces (status block, upgrade plan). */
export function autoMigrationReportJson(r: AutoMigrationReport): Record<string, unknown> {
  return {
    state: r.state,
    automatic: r.automatic,
    message: r.message,
    next_start: r.nextStart,
    manual_command: r.manualCommand,
    ...(r.pid !== null ? { pid: r.pid } : {}),
    ...(r.since !== null ? { since: r.since } : {}),
    ...(r.progress !== null ? { progress: r.progress } : {}),
    ...(r.error !== null ? { error: r.error } : {}),
    ...(r.retryAfter !== null ? { retry_after: r.retryAfter } : {}),
    ...(r.firstMachines.length > 0 ? { first_machines: r.firstMachines } : {}),
    ...(r.settingProblem !== null ? { setting_problem: r.settingProblem } : {}),
  };
}

/** How many missing shards a waiting report names. */
const MISSING_SHARDS_SHOWN = 5;

/**
 * The waiting report of a later machine whose first machine's cut has not
 * arrived: which store shards are missing, and what to do when they will
 * not arrive by themselves.
 */
function waitingForCut(waiting: AutoMigrationWaiting): string {
  const from = printable(waiting.firstMachines.join(", ")) || "another device";
  let text = `the automatic store migration waits for the first migration of ${from} to arrive by sync`;
  if (waiting.missing.length > 0) {
    const shown = waiting.missing.slice(0, MISSING_SHARDS_SHOWN).map(printable).join(", ");
    const more =
      waiting.missing.length > MISSING_SHARDS_SHOWN
        ? ` and ${waiting.missing.length - MISSING_SHARDS_SHOWN} more`
        : "";
    text +=
      `; this machine's store still lacks ${shown}${more}. If they do not arrive, check that ` +
      `the store root syncs from ${from} (or restore them there), then run ` +
      `\`${MIGRATE_STORE_COMMAND}\``;
  }
  return text;
}
