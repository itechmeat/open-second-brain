/**
 * `o2b brain migrate-store [--dry-run | --resume] [--json]` - move this
 * vault's legacy brain into the brain store (tasks 2.2 and 2.3, design
 * D11).
 *
 *  - `--dry-run` prints the plan (`core/store-migration/dry-run.ts`) and
 *    writes nothing anywhere.
 *  - With no flag it runs the migration on this machine
 *    (`core/store-migration/migrate.ts`); `--resume` continues one that
 *    was interrupted.
 *  - `--remove-legacy [--force]` moves the legacy tree out of the vault
 *    once the cohort allows, and `--rollback` takes this machine back to
 *    the legacy layout (`migrate-store-forms.ts`).
 *  - `--force-release-gate` releases a migration gate a run that is gone
 *    left on this machine, unless its holder is provably still running.
 *
 * Exit codes: 0 when the plan maps every entry or the migration finished,
 * 1 when the plan lists unmapped entries, the migration refused to start,
 * failed or found a verification gap, 2 for a usage error.
 */

import { PERMISSIONS_DOCUMENT_REL } from "../../../core/brain/permissions/document.ts";
import {
  planMigrationDryRun,
  type MigrationDryRun,
  type SurfaceReport,
} from "../../../core/store-migration/dry-run.ts";
import {
  MigrationRefusedError,
  type MigrationResult,
} from "../../../core/store-migration/migrate.ts";
import { migrateStore, type MigrateStoreOutcome } from "../../../core/store-migration/outcome.ts";
import { brainVerbContext, failWith, parse, usageError, writeJson } from "../helpers.ts";
import { runForceReleaseGate, runRemoveLegacy, runRollback } from "./migrate-store-forms.ts";

/** The usage error of two forms given together. */
export const MIGRATE_STORE_ONE_FORM =
  "pick one of --dry-run, --resume, --rollback, --remove-legacy and --force-release-gate";

export async function cmdBrainMigrateStore(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    "dry-run": { type: "boolean" },
    resume: { type: "boolean" },
    rollback: { type: "boolean" },
    "remove-legacy": { type: "boolean" },
    "force-release-gate": { type: "boolean" },
    force: { type: "boolean" },
    wait: { type: "string" },
    json: { type: "boolean" },
  });
  const forms = ["dry-run", "resume", "rollback", "remove-legacy", "force-release-gate"].filter(
    (f) => flags[f] === true,
  );
  if (forms.length > 1) return usageError(MIGRATE_STORE_ONE_FORM);
  if (flags["force"] === true && flags["remove-legacy"] !== true) {
    return usageError("--force goes with --remove-legacy");
  }
  const waitRaw = flags["wait"] as string | undefined;
  if (waitRaw !== undefined && !/^\d+$/.test(waitRaw)) {
    return usageError("--wait takes a whole number of seconds");
  }
  if (waitRaw !== undefined && forms.some((f) => f !== "resume")) {
    return usageError("--wait goes with the migration itself (no flag, or --resume)");
  }
  // The gate is this machine's, not a vault's: no vault is needed.
  if (flags["force-release-gate"] === true) return runForceReleaseGate(flags["json"] === true);
  const { vault, config } = brainVerbContext(flags);
  const json = flags["json"] === true;
  if (flags["rollback"] === true) return runRollback(vault, config, json);
  if (flags["remove-legacy"] === true) {
    return runRemoveLegacy(vault, config, flags["force"] === true, json);
  }
  if (flags["dry-run"] !== true) {
    const waitMs = waitRaw === undefined ? 0 : Number(waitRaw) * 1000;
    return migrate(vault, config, flags["resume"] === true, waitMs, json);
  }

  let plan: MigrationDryRun;
  try {
    plan = planMigrationDryRun(vault);
  } catch (exc) {
    return failWith("plan the brain store migration", exc);
  }

  if (json) writeJson(plan);
  else process.stdout.write(renderDryRun(plan));
  return plan.ok ? 0 : 1;
}

function migrate(
  vault: string,
  configPath: string,
  resume: boolean,
  waitMs: number,
  json: boolean,
): number {
  let outcome: MigrateStoreOutcome;
  try {
    outcome = migrateStore(vault, { resume, configPath, waitMs });
  } catch (exc) {
    if (exc instanceof MigrationRefusedError) {
      process.stderr.write(`error: ${exc.message}\n`);
      return 1;
    }
    return failWith("migrate the brain into the store", exc);
  }
  if (json) writeJson(outcome);
  else process.stdout.write(renderOutcome(outcome));
  return outcome.ok ? 0 : 1;
}

/** Any outcome as text. */
export function renderOutcome(outcome: MigrateStoreOutcome): string {
  if (outcome.mode === "migration") return renderMigration(outcome);
  if (outcome.mode === "waiting") {
    const { wait } = outcome;
    if (wait.marker === true) {
      return (
        [
          `Device ${outcome.device} waits for the vault identity marker the first migration ` +
            `(${wait.firstMachines.join(", ")}) gave this vault; nothing was written.`,
          "Run the migration again once sync delivers it. If this vault is not the one those " +
            "devices migrated, give it its own marker with `o2b brain init` first.",
        ].join("\n") + "\n"
      );
    }
    const lines = [
      `Device ${outcome.device} waits for the brain store files of the first migration ` +
        `(${wait.firstMachines.join(", ")}); nothing was written.`,
      `missing or short shards (${wait.missing.length}):`,
      ...wait.missing.map((m) => `  ${m}`),
    ];
    if (wait.skipped.length > 0) {
      lines.push(`partitions this machine does not hold, skipped: ${wait.skipped.join(", ")}`);
    }
    lines.push("Run the migration again once sync delivers them, or pass --wait <seconds>.");
    return lines.join("\n") + "\n";
  }
  const lines = [
    `Device ${outcome.device} already switched to the brain store; imported late legacy writes.`,
    `imported: ${outcome.imported} item(s) in ${outcome.passes} pass(es)`,
    `devices still on the legacy layout: ${outcome.legacy_devices.join(", ") || "none"}`,
  ];
  if (outcome.settings !== null) {
    lines.push(
      `vault settings: ${outcome.settings.written.length} recorded, ` +
        `${outcome.settings.unchanged.length} already held by the store`,
    );
    const config = outcome.device_config;
    if (config !== null && config.written.length > 0) {
      lines.push(`device settings written to ${config.path}:`);
      for (const line of config.written) lines.push(`  ${line}`);
    }
  }
  if (outcome.held_back > 0) {
    lines.push(
      `${outcome.held_back} item(s) belong to a store partition this machine does not hold; ` +
        "run the command again once that partition is here",
    );
  }
  if (outcome.unseen_shards.length > 0) {
    lines.push(
      `${outcome.unseen_shards.length} store shard(s) cannot be read in full ` +
        `(${outcome.unseen_shards.slice(0, 5).join(", ")}); a record of this vault may be in ` +
        "one, so the vault is not bound. Let sync finish or fix their permissions, then run " +
        "the command again",
    );
  }
  if (outcome.permissions_conflict) {
    lines.push(
      `${PERMISSIONS_DOCUMENT_REL} of this vault holds deny rules the stored permissions document ` +
        "does not; the stored document stays and the vault is not bound. Reconcile them " +
        "(o2b brain permissions show, o2b brain settings set permissions.document) and run " +
        "the command again",
    );
  }
  if (outcome.settings !== null) {
    lines.push(
      outcome.bound
        ? "this vault is now the vault bound to the brain store"
        : "this vault is not bound to the brain store yet",
    );
  }
  return lines.join("\n") + "\n";
}

/** The migration result as text. */
export function renderMigration(result: MigrationResult): string {
  const out = [
    result.ok
      ? `Brain store migration done on device ${result.device} (run ${result.run_id}).`
      : `Brain store migration did not finish on device ${result.device} (run ${result.run_id}).`,
    `store: ${result.store_root}`,
    `role: ${result.role === "first" ? "first machine" : "later machine"}`,
    `imported: ${result.imported} item(s) in ${result.passes} pass(es)`,
    `device-local state copied: ${result.device_local.length} file(s)`,
    `devices in the legacy tree: ${result.cohort.join(", ") || "none"}`,
  ];
  if (result.backup !== null) {
    out.push(
      `backup: ${result.backup.dir} (snapshot ${result.backup.snapshot ?? "none"}, ` +
        `${result.backup.files.length} file(s) copied and verified)`,
    );
  }
  out.push(
    `unparseable items kept in the backup: ${result.unparseable} (${result.unparseable_archive})`,
  );
  if (result.gaps.length > 0) {
    out.push(`items not in the store (${result.gaps.length}); the legacy tree is untouched:`);
    for (const gap of result.gaps) out.push(`  ${gap.key}: ${gap.reason}`);
  } else {
    out.push(
      `recorded migration-done ${result.migration_done} and device-switched ${result.device_switched}`,
      `view writer: ${result.view_writer ?? "none"}`,
    );
    if (result.device_tokens !== null && result.device_tokens.status !== "none") {
      out.push(
        `MCP tokens in device config: ${result.device_tokens.status} (${result.device_tokens.path})`,
      );
    }
    const settings = result.settings;
    if (settings !== null) {
      out.push(
        `_brain.yaml: ${settings.written.length} changed shared setting(s) recorded, ` +
          `${settings.unchanged.length} already held`,
      );
      const config = result.device_config;
      if (config !== null && config.written.length > 0) {
        out.push(`device settings written to ${config.path}:`);
        for (const line of config.written) out.push(`  ${line}`);
      }
      if (config !== null && config.kept.length > 0) {
        out.push(
          `device settings this machine's config already sets, kept: ${config.kept.join(", ")}`,
        );
      }
      if (settings.unknown.length > 0) {
        out.push(
          `_brain.yaml keys with no classification, not imported: ${settings.unknown.join(", ")}`,
        );
      }
    }
  }
  return out.join("\n") + "\n";
}

function itemsLine(s: SurfaceReport): string {
  const parts = [`${s.items} item(s) in ${s.files} file(s), ${s.bytes} bytes`];
  if (s.partitions !== null) {
    const p = s.partitions;
    parts.push(
      `shared ${p.shared}, private ${p.private}, private when held ${p["private-when-held"]}`,
    );
  }
  if (s.unparseable > 0) parts.push(`${s.unparseable} unparseable`);
  return parts.join("; ");
}

/** The dry run as text. */
export function renderDryRun(plan: MigrationDryRun): string {
  const out: string[] = [
    "Brain store migration, dry run: nothing was written.",
    `vault: ${plan.vault}`,
    "",
  ];
  const { cohort, roster, roster_window_days: days, unsharded_files: unsharded } = plan.devices;
  out.push(
    `Devices in the legacy tree: ${cohort.length} (roster of the last ${days} days: ${roster.length})`,
  );
  for (const d of cohort) {
    const where = d.in_roster ? "roster" : `not seen in ${days} days`;
    out.push(
      `  ${d.device}: ${d.items} item(s) in ${d.files} shard(s), last seen ${d.last_seen} (${where})`,
    );
  }
  out.push(`  legacy files without a device id: ${unsharded}`, "");

  const present = plan.surfaces.filter((s) => s.present);
  const absent = plan.surfaces.filter((s) => !s.present);
  out.push(`Surfaces with data: ${present.length}`);
  for (const s of present) {
    out.push(`  ${s.id} (${s.path}): ${itemsLine(s)}`, `    -> ${s.planned}`);
  }
  if (absent.length > 0) {
    out.push(`Surfaces with no data here: ${absent.map((s) => s.id).join(", ")}`);
  }
  out.push("");

  out.push(`Unparseable items: ${plan.totals.unparseable}`);
  for (const p of plan.unparseable) {
    out.push(`  ${p.path}${p.line === null ? "" : `:${p.line}`} (${p.surface}): ${p.reason}`);
  }
  if (plan.unparseable_not_listed > 0) {
    out.push(`  and ${plan.unparseable_not_listed} more not listed`);
  }
  out.push("");

  out.push(`Unmapped entries: ${plan.totals.unmapped}`);
  for (const u of plan.unmapped) out.push(`  ${u.path}${u.type === "directory" ? "/" : ""}`);
  out.push(
    "",
    plan.ok
      ? "Every legacy entry has a destination."
      : "The migration cannot run until every unmapped entry has a destination.",
  );
  return out.join("\n") + "\n";
}
