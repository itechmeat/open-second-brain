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
  if (json) {
    writeJson(result);
    return result.removed ? 0 : 1;
  }
  if (!result.removed) {
    process.stdout.write(`The legacy tree stays in the vault: ${keptBecause(result)}.\n`);
    return 1;
  }
  const lines = [
    `Moved ${result.moved.join(", ")} out of the vault into ${result.archive}; nothing was deleted.`,
    `late legacy writes imported first: ${result.imported}`,
    `left out of the archive as rebuildable (index, caches, generated pages): ${
      result.skipped.length > 0 ? result.skipped.join(", ") : "none"
    }`,
  ];
  if (result.forced && result.stopped.length > 0) {
    lines.push(
      `forced: ${result.stopped.join(", ")} will no longer reach the brain store until migrated`,
    );
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
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
      return (
        `${result.pending.join(", ")} still ${verb} the legacy layout; ` +
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
      return "the vault holds no legacy tree";
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
