/**
 * The `--remove-legacy [--force]`, `--rollback` and `--force-release-gate`
 * forms of `o2b brain migrate-store` (tasks 2.5 and 2.6), kept apart from
 * the migration and dry-run forms in `migrate-store.ts`.
 *
 * Exit codes: 0 when the tree was removed, the rollback finished or the
 * gate is open, 1 when the cohort keeps the tree in place, the rollback is
 * refused or the gate's holder is still running.
 */

import { removeLegacy, rollback } from "../../../core/store-migration/outcome.ts";
import { forceReleaseGate, MigrationGateBusyError } from "../../../core/store-migration/quiesce.ts";
import type { SilenceReport } from "../../../core/store-migration/removal.ts";
import { describeBytes } from "../../../core/store-migration/sizes.ts";
import { RollbackRefusedError } from "../../../core/store-migration/rollback.ts";
import { failWith, writeJson } from "../helpers.ts";

/** Release a migration gate a run that is gone left on this machine. */
export function runForceReleaseGate(json: boolean): number {
  let result;
  try {
    result = forceReleaseGate();
  } catch (exc) {
    if (exc instanceof MigrationGateBusyError) {
      process.stderr.write(`error: ${exc.message}\n`);
      return 1;
    }
    return failWith("release the migration gate", exc);
  }
  if (json) {
    writeJson(result);
    return 0;
  }
  if (result.kind === "none") {
    process.stdout.write("No migration gate is held on this machine; nothing was changed.\n");
  } else if (result.kind === "damaged") {
    process.stdout.write("Removed a damaged migration gate file; content writers write again.\n");
  } else {
    const { gate } = result;
    process.stdout.write(
      `Released the migration gate of run ${gate.run_id} (process ${gate.pid}) on ${gate.vault}; ` +
        "content writers on this machine write again. Run the migration again with `--resume` " +
        "to finish the interrupted run, or with `--rollback` to undo it.\n",
    );
  }
  return 0;
}

export function runRemoveLegacy(
  vault: string,
  configPath: string,
  force: boolean,
  json: boolean,
): number {
  let result;
  try {
    result = removeLegacy(vault, { configPath, force });
  } catch (exc) {
    return failWith("remove the legacy tree", exc);
  }
  // Nothing of the tree is left to remove: the state the command exists
  // for holds, so it succeeds, and names the cohort as a removal does.
  if (json) {
    writeJson(result);
    return result.removed || result.reason === "no-legacy-tree" ? 0 : 1;
  }
  if (!result.removed && result.reason === "no-legacy-tree") {
    process.stdout.write(
      [
        "The legacy tree is not in this vault and this machine left no legacy files in it; " +
          "nothing was moved.",
        ...cohortLines(result),
      ].join("\n") + "\n",
    );
    return 0;
  }
  if (!result.removed) {
    const cohort = result.reason === "cohort-pending" ? cohortLines(result) : [];
    process.stdout.write(
      [`The legacy tree stays in the vault: ${keptBecause(result)}.`, ...cohort].join("\n") + "\n",
    );
    return 1;
  }
  process.stdout.write(`${removedLines(result).join("\n")}\n`);
  return 0;
}

/** A date of the report, as a day. */
function dayOf(iso: string | null): string {
  return iso === null ? "none" : iso.slice(0, 10);
}

/**
 * The devices that switched (every one with a switch record, a later
 * machine's too), those retired by hand, and those retired by silence.
 */
export function cohortLines(
  result: Pick<
    SilenceReport,
    "switched" | "retired" | "retired_by_silence" | "silence_threshold_days" | "as_of"
  >,
): string[] {
  const lines: string[] = [];
  if (result.switched.length > 0) lines.push(`switched: ${result.switched.join(", ")}`);
  if (result.retired.length > 0) lines.push(`retired by hand: ${result.retired.join(", ")}`);
  if (result.retired_by_silence.length > 0) {
    const listed = result.retired_by_silence
      .map((d) => `${d.device} (last evidence ${dayOf(d.last_evidence)})`)
      .join(", ");
    lines.push(
      `retired by silence (no evidence of life for more than ${result.silence_threshold_days} ` +
        `days before ${dayOf(result.as_of)}): ${listed}`,
    );
  }
  return lines;
}

/** The warning line for ledger rows the legacy ledgers do not get back, or none. */
function ledgerWarning(kept: Readonly<Record<string, number>>): string[] {
  const entries = Object.entries(kept);
  if (entries.length === 0) return [];
  const listed = entries.map(([ledger, n]) => `${ledger} ${n}`).join(", ");
  return [
    `warning: ledger rows written after the switch stay in the brain store only, and the ` +
      `legacy release does not see them: ${listed}`,
  ];
}

type KeptResult = Extract<ReturnType<typeof removeLegacy>, { readonly removed: false }>;

/** Why the legacy tree stayed, one sentence per reason; a new reason fails the type check. */
function keptBecause(result: KeptResult): string {
  switch (result.reason) {
    case "cohort-pending": {
      const verb = result.pending.length === 1 ? "writes" : "write";
      const dated =
        result.pending_evidence.length === 1
          ? dayOf(result.pending_evidence[0]!.last_evidence)
          : result.pending_evidence.map((d) => `${d.device} ${dayOf(d.last_evidence)}`).join(", ");
      return (
        `${result.pending.join(", ")} still ${verb} the legacy layout (last evidence ${dated}); ` +
        "upgrade and migrate each one, retire the ones that are gone with " +
        "`o2b store device retire <device-id>`, or pass --force"
      );
    }
    case "held-back":
      return (
        `${result.held_back} legacy item(s) belong to the ${result.missing.join(", ")} ` +
        "partition of the brain store, which this machine does not hold, and the legacy tree " +
        "is their only copy; nothing was moved, even with --force. Bring that partition here, " +
        "or remove the tree on a machine that holds it"
      );
    case "not-switched":
      return "this machine has not switched to the brain store; run the migration first";
    case "no-legacy-tree":
      return "nothing of the legacy tree is in the vault";
    default: {
      const unknown: never = result;
      return String((unknown as KeptResult).reason);
    }
  }
}

export function runRollback(vault: string, configPath: string, json: boolean): number {
  let result;
  try {
    result = rollback(vault, { configPath });
  } catch (exc) {
    if (exc instanceof RollbackRefusedError) {
      process.stderr.write(`error: ${exc.message}\n`);
      return 1;
    }
    return failWith("roll back the brain store migration", exc);
  }
  if (json) {
    writeJson(result);
    return 0;
  }
  const kept = Object.entries(result.no_legacy_form)
    .map(([kind, n]) => `${kind} ${n}`)
    .join(", ");
  process.stdout.write(
    [
      `Device ${result.device} is back on the legacy layout.`,
      `restored: ${result.restored_files} Brain entr(ies) from the migration snapshot, ${result.restored_backups} backed-up file(s)`,
      `written back into the legacy tree: ${result.replayed.length} record(s), in fold order`,
      `kept in the store only (no legacy form): ${kept || "none"}`,
      `refused (a path that leaves the brain tree): ${result.refused.length} record(s)`,
      ...result.refused.map((r) => `  ${r.id} ${r.kind}: ${r.reason}`),
      ...ledgerWarning(result.ledger_rows_kept),
    ].join("\n") + "\n",
  );
  return 0;
}

/** How many entries a long list names before it counts the rest. */
const LIST_SHOWN = 5;

/** A list as "a, b, c, d, e and N more" (`--json` carries every entry). */
export function summariseList(items: ReadonlyArray<string>, shown: number = LIST_SHOWN): string {
  if (items.length <= shown) return items.join(", ");
  return `${items.slice(0, shown).join(", ")} and ${items.length - shown} more`;
}

type RemovedResult = Extract<ReturnType<typeof removeLegacy>, { readonly removed: true }>;

/** The text report of a removal that moved the tree, one line per fact. */
export function removedLines(result: RemovedResult): string[] {
  const dropped = result.skipped_sizes;
  const lines = [
    result.tree_already_left
      ? `The legacy tree had already left the vault; moved this machine's leftover ` +
        `${result.moved.join(", ")} out of the vault into ${result.archive}.`
      : `Moved ${result.moved.join(", ")} out of the vault into ${result.archive}.`,
    dropped.length > 0
      ? `Deleted ${dropped.length} rebuildable file(s) instead of archiving them (index, caches, ` +
        `generated pages; ${describeBytes(result.skipped_bytes)}, recreated by a rebuild): ` +
        `${summariseList(dropped.map((d) => `${d.path} (${describeBytes(d.bytes)})`))}. ` +
        "Everything else was moved into the archive, not deleted."
      : "Nothing was deleted: everything was moved into the archive.",
    `late legacy writes imported first: ${result.imported}`,
  ];
  lines.push(...cohortLines(result));
  if (result.forced && result.stopped.length > 0) {
    lines.push(
      `forced: ${result.stopped.join(", ")} will no longer reach the brain store until migrated`,
    );
  }
  return lines;
}
