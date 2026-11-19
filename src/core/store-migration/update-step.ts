/**
 * The store migration step of `o2b update` (change auto-store-migration,
 * design D4): after the product is updated, the same check the start
 * runs, and with a migration available the same worker logic, in the
 * foreground with progress for the caller's stderr.
 *
 * The step never fails the update: every way it ends is an outcome the
 * update names in its text and `--json` output. With the opt-out on, the
 * migration is offered (the commands to run by hand) and never run; with
 * `skip`, it is skipped once; in a dry run, a pending migration is named
 * and nothing runs.
 */

import { refusalReason } from "./auto-report.ts";
import { AUTO_MIGRATION_OUTCOME, noneOutcome, runAutoStoreMigration } from "./auto-worker.ts";
import type { GateDecision } from "./gate-decision.ts";
import { gatherGate } from "./gate-state.ts";

/** How the update's migration step ended, as the update reports it. */
export const UPDATE_STORE_MIGRATION = Object.freeze({
  ...AUTO_MIGRATION_OUTCOME,
  /** `--skip-store-migration`: nothing was checked or run. */
  skipped: "skipped",
  /** A dry run found a migration the update would run. */
  pending: "pending",
} as const);

export type UpdateStoreMigrationOutcome =
  (typeof UPDATE_STORE_MIGRATION)[keyof typeof UPDATE_STORE_MIGRATION];

/** The `store_migration` field of `o2b update --json`. */
export interface UpdateStoreMigration {
  readonly outcome: UpdateStoreMigrationOutcome;
  /** The failure; set when the migration was refused or failed. */
  readonly error: string | null;
  /**
   * What to run by hand: the command after a failure, the commands of the
   * offer on an opted-out machine. `null` otherwise.
   */
  readonly manual_command: string | null;
}

export interface UpdateStoreMigrationOptions {
  readonly configPath?: string;
  /** `--skip-store-migration`. */
  readonly skip: boolean;
  /** `--dry-run`: name a pending migration, run nothing. */
  readonly dryRun: boolean;
  /** One-line progress for the caller's stderr. */
  readonly progress?: (line: string) => void;
}

function result(
  outcome: UpdateStoreMigrationOutcome,
  error: string | null = null,
  manualCommand: string | null = null,
): UpdateStoreMigration {
  return Object.freeze({ outcome, error, manual_command: manualCommand });
}

/** The update's store migration step for `vault`. Never throws. */
export function updateStoreMigration(
  vault: string,
  opts: UpdateStoreMigrationOptions,
): UpdateStoreMigration {
  if (opts.skip) return result(UPDATE_STORE_MIGRATION.skipped);
  const configOpts = opts.configPath !== undefined ? { configPath: opts.configPath } : {};
  try {
    // The decision is the gate decision a start and the worker take
    // (`gate-decision.ts`): the opt-out governs starting a migration, and
    // an automatic attempt's stopped run is gone on with (or its gate
    // opened) whatever it says. A dry run stays read-only.
    const { decision, context } = gatherGate({
      vault,
      configPath: opts.configPath,
      asker: "update",
      now: new Date(),
    });
    if (decision.act === "none" && decision.why === "disabled") {
      return result(
        UPDATE_STORE_MIGRATION.disabled,
        null,
        context.availability?.nextCommands.join(", then ") ?? null,
      );
    }
    if (opts.dryRun) return dryRunOf(decision, context.availability?.nextCommands ?? []);
    if (decision.act === "none" && decision.why === "nothing-left") {
      return result(UPDATE_STORE_MIGRATION.notNeeded);
    }
    // Every other way the worker answers for itself, with the same state
    // read again under its claim.
    const run = runAutoStoreMigration(vault, {
      ...configOpts,
      asker: "update",
      ...(opts.progress !== undefined ? { progress: opts.progress } : {}),
    });
    return result(run.outcome, run.error, run.manualCommand);
  } catch (err) {
    return result(
      UPDATE_STORE_MIGRATION.failed,
      err instanceof Error ? err.message : String(err),
      null,
    );
  }
}

/**
 * What a dry run reports for the gate decision `d` of `o2b update`: what
 * the real update would do, from the decision's answer alone. Anything
 * the update would act on (migrate, finish a switch, open a stopped run's
 * gate) is pending; a refusal is reported with its reason and the command
 * that clears it, and nothing is recorded; "nothing" is the outcome the
 * worker answers for its reason. `not_needed` is kept for no work at all.
 */
export function dryRunOf(
  d: GateDecision,
  nextCommands: ReadonlyArray<string>,
): UpdateStoreMigration {
  switch (d.act) {
    case "migrate":
    case "finish":
    case "open":
      return result(UPDATE_STORE_MIGRATION.pending);
    case "refuse": {
      const refusal = refusalReason(d);
      // The command field names one; the other way out goes in the reason.
      const text = refusal.stay === null ? refusal.text : `${refusal.text}; or run ${refusal.stay}`;
      return result(UPDATE_STORE_MIGRATION.refused, text, refusal.command);
    }
    case "none": {
      const outcome = noneOutcome(d.why);
      return outcome === UPDATE_STORE_MIGRATION.disabled
        ? result(outcome, null, nextCommands.join(", then ") || null)
        : result(outcome);
    }
    default:
      return result(UPDATE_STORE_MIGRATION.notNeeded);
  }
}

/** The update's one text line about the step. */
export function describeUpdateStoreMigration(step: UpdateStoreMigration): string {
  let line = `store migration: ${step.outcome.replaceAll("_", " ")}`;
  if (step.error !== null) line += ` (${step.error})`;
  if (step.outcome === UPDATE_STORE_MIGRATION.disabled && step.manual_command !== null) {
    line += `; this machine opted out, run it by hand: ${step.manual_command}`;
  } else if (step.outcome === UPDATE_STORE_MIGRATION.pending) {
    line += "; the update runs it";
  } else if (step.manual_command !== null) {
    line += `; run \`${step.manual_command}\` to retry by hand`;
  }
  return line;
}
