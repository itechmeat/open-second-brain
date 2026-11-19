/**
 * Doctor finding: a migration into the brain store is available on this
 * machine (design D11, task 2.12, spec "Upgrade on a legacy install").
 *
 * The answer is `store/migration-availability.ts`, the same one the
 * `store` status block gives: the vault still holds the legacy `Brain/`
 * tree and the store holds no `device-switched` record of this device.
 * The finding names the commands to run, in order (`o2b store init` first
 * when there is no store yet), and says that nothing moves until the user
 * runs the migration. Silent once this device has switched, and on a vault
 * with no legacy tree. Read-only.
 *
 * The migration ships, so the finding shows on every legacy vault that
 * has not switched and holds something to move, whether or not this
 * machine uses the store yet; a freshly bootstrapped tree (its settings,
 * manual, identity marker and Bases views only) has nothing to migrate and
 * stays silent. It is advice: it goes to the doctor's non-counting
 * channel (`uncertain`, which the report prints and `--strict` and the
 * trust verdict do not count), never to the warnings.
 *
 * The same check reports the transition (task 2.12, design D11a): on a
 * switched machine, each cohort device as switched, pending with its last
 * evidence, or retired by silence with the date and the threshold (change
 * stale-device-retirement, `store-migration/cohort-status.ts`); while one
 * is pending the advice names it, and once none is the advice says the
 * legacy tree can leave the vault and names the command (both in the same
 * channel); and a legacy directory that is back in the vault after the
 * tree was removed (a warning, with the writer its files name).
 *
 * Once this device switched, one advice names the sync conflict copies
 * its migration kept in the backup and did not import (change
 * migration-sync-conflict-copies): versions of a record or of a single
 * document that differ from the original, which the person may want to
 * look at. It never stops anything, and it goes away once the person
 * removes the list the migration wrote.
 */

import { closeSync, existsSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";

import {
  legacyTreeRemovedRecords,
  standingDoneRecords,
} from "../../store-migration/migration-records.ts";
import { readRemovalMarker } from "../../store-migration/removal-marker.ts";
import { cohortStatusHere, migrationStoreHere } from "../../store-migration/cohort-here.ts";
import type { CohortStatus } from "../../store-migration/cohort-status.ts";
import { legacyDeviceEvidence } from "../../store-migration/device-evidence.ts";
import type { StoreHandle } from "../../store/store-open.ts";
import { deviceSwitchedHere } from "../../store/store-only.ts";
import { withholdsPrivate } from "./store-check.ts";
import { readSyncCopiesArchive, syncCopiesListPath } from "../../store-migration/backup.ts";
import { migrationDir } from "../../store-migration/journal.ts";
import { readVaultIdentity } from "../vault-identity.ts";

import {
  MIGRATE_STORE_COMMAND,
  migrationAvailability,
} from "../../store/migration-availability.ts";
import { interruptedSwitch, ownMigrationRunRead } from "../../store-migration/auto-probe.ts";
import {
  AUTO_MIGRATION_STATE,
  autoMigrationReport,
  type AutoMigrationReport,
} from "../../store-migration/auto-report.ts";
import { BRAIN_ROOT_REL } from "../path-constants.ts";
import type { DoctorCheck, DoctorCheckContext, DoctorFindings } from "./check.ts";
import { withoutSeenRecording } from "../../store/seen-shards.ts";

/** The legacy tree is in the vault and this device has not switched to the store. */
export const MIGRATION_AVAILABLE_CODE = "migration-available";

/** This device switched, and devices of the cohort still write the legacy tree (D11a). */
export const LEGACY_DEVICES_PENDING_CODE = "legacy-devices-pending";

/** This device switched and no cohort device is pending: the legacy tree can leave the vault. */
export const LEGACY_TREE_CAN_LEAVE_CODE = "legacy-tree-can-leave";

/** The command that moves the legacy tree out of the vault. */
export const REMOVE_LEGACY_COMMAND = "o2b brain migrate-store --remove-legacy";

/** A legacy directory is back in the vault after the legacy tree was removed. */
export const LEGACY_TREE_REAPPEARED_CODE = "legacy-tree-reappeared";

/** The last automatic store migration attempt on this machine failed (change auto-store-migration). */
export const STORE_MIGRATION_FAILED_CODE = "store-migration-failed";

/** The migration kept sync conflict copies in its backup, not imported (advice). */
export const SYNC_COPIES_KEPT_CODE = "sync-conflict-copies-kept";

/** Two devices each ran the first migration of this vault (D11: one first machine). */
export const MIGRATION_DONE_TWICE_CODE = "migration-done-twice";

const AGENT_RE = /(?:^|\n)agent:\s*"?([^"\n]+)"?|"agent"\s*:\s*"([^"]+)"/;

/** The first agent name a file below `dir` carries, scanning at most `budget` files. */
function writerIn(dir: string, budget = 200): string | null {
  let left = budget;
  const walk = (current: string): string | null => {
    let names: string[];
    try {
      names = readdirSync(current).toSorted();
    } catch {
      return null;
    }
    for (const name of names) {
      if (left <= 0) return null;
      const path = join(current, name);
      let isDir = false;
      try {
        isDir = lstatSync(path).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        const found = walk(path);
        if (found !== null) return found;
        continue;
      }
      left -= 1;
      try {
        const match = AGENT_RE.exec(headOf(path, 4096));
        const agent = (match?.[1] ?? match?.[2])?.trim();
        if (agent !== undefined && agent !== "") return agent;
      } catch {
        // unreadable: try the next file
      }
    }
    return null;
  };
  return walk(dir);
}

/** The first bytes of a file, without reading the rest of it. */
function headOf(path: string, bytes: number): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * More than one device recorded `migration-done` for this vault: each
 * imported the legacy tree as the first machine, because neither saw the
 * other's completion record before it started (the sync window).
 */
function doubleFirstFinding(ctx: DoctorCheckContext, out: DoctorFindings): void {
  const store = migrationStoreHere(ctx.configPath);
  if (store === null) return;
  const vaultId = readVaultIdentity(ctx.vault)?.vault_id ?? null;
  // Only completions still standing (a run a later rollback of its device
  // undid duplicated nothing) and only this vault's: a record names its
  // vault by id, and a vault with no identity marker matches only the
  // records that named none, never another vault's, as the removal
  // finding below matches only this vault's records.
  const devices = [
    ...new Set(
      standingDoneRecords(store)
        .filter((r) => (r.body["vault_id"] ?? null) === vaultId)
        .map((r) => r.device),
    ),
  ].toSorted();
  if (devices.length < 2) return;
  out.issues.push({
    severity: "warning",
    code: MIGRATION_DONE_TWICE_CODE,
    path: join(ctx.vault, BRAIN_ROOT_REL),
    message:
      `${devices.join(" and ")} each recorded the first migration of this vault, so the legacy ` +
      "items both imported before either saw the other's completion record are in the store " +
      "twice (nothing was lost; duplicated log events and ledger rows show twice). Keep both " +
      "records; for every other machine, run the first migration on one machine and wait for " +
      "its completion record to sync before migrating the others.",
  });
}

/** The advice on the conflict copies this device's migration kept, once it switched. */
function keptCopiesFinding(ctx: DoctorCheckContext, out: DoctorFindings): void {
  const store = migrationStoreHere(ctx.configPath);
  if (store === null || !deviceSwitchedHere(store, store.device)) return;
  const dir = migrationDir(store);
  const kept = readSyncCopiesArchive(dir);
  if (kept === null) return;
  // Below local reach a copy's path can name a private page, and the count
  // and the device-local archive say what the caller cannot read: the
  // advice keeps its code and points at this machine's own doctor.
  if (withholdsPrivate(ctx)) {
    out.uncertain.push({
      code: SYNC_COPIES_KEPT_CODE,
      message:
        "the migration to the brain store kept sync conflict copies that differ from their " +
        "originals and imported none of them. Run `o2b brain doctor` on this machine to see " +
        "which and where they are kept; nothing is waiting on them.",
    });
    return;
  }
  const n = kept.copies.length;
  const named = kept.copies
    .slice(0, 5)
    .map((c) => c.path)
    .join(", ");
  out.uncertain.push({
    code: SYNC_COPIES_KEPT_CODE,
    path: kept.dir,
    message:
      `the migration to the brain store kept ${n} sync conflict ${n === 1 ? "copy" : "copies"} ` +
      `that ${n === 1 ? "differs" : "differ"} from ${n === 1 ? "its original" : "their originals"} ` +
      `and imported none of them (${named}${n > 5 ? ", ..." : ""}): another version of a record ` +
      `or of a single document such as the pinned context. They are kept in ${kept.dir}; look at ` +
      "them and copy what you want into the brain. Nothing is waiting on them; remove " +
      `${syncCopiesListPath(dir)} once you have looked, and this advice goes away.`,
  });
}

/** The two transition findings: devices still on the legacy layout, and a tree that came back. */
function transitionFindings(ctx: DoctorCheckContext, out: DoctorFindings): void {
  const store = migrationStoreHere(ctx.configPath);
  if (store === null) return;
  const brain = join(ctx.vault, BRAIN_ROOT_REL);
  if (!existsSync(brain)) return;
  const vaultId = readVaultIdentity(ctx.vault)?.vault_id ?? null;
  const removedHere = readRemovalMarker(store, ctx.vault) !== null;
  // A record of another vault's removal must not match a tree with no
  // identity marker (the marker sat in the removed tree): with no id, only
  // this vault's own removal marker counts.
  const removedAnywhere =
    vaultId !== null && legacyTreeRemovedRecords(store).some((r) => r.body["vault_id"] === vaultId);
  if (removedHere || removedAnywhere) {
    const returning = retiredBySilenceWriting(ctx.vault, store, vaultId);
    if (returning !== null) {
      out.issues.push({
        severity: "warning",
        code: LEGACY_TREE_REAPPEARED_CODE,
        path: brain,
        message: returningMessage(returning),
      });
      return;
    }
    const writer = writerIn(brain);
    out.issues.push({
      severity: "warning",
      code: LEGACY_TREE_REAPPEARED_CODE,
      path: brain,
      message:
        "the legacy Brain/ tree was removed from this vault after the migration to the brain " +
        "store, and a Brain/ directory is back" +
        (writer !== null ? `; its files name the writer ${writer}` : "; no file names its writer") +
        ". An agent or tool still follows instructions that write the legacy layout; nothing " +
        "reads these files, so stop that writer and move the directory out of the vault.",
    });
    return;
  }
  // The devices the legacy shards name, as the transition pass counts
  // them, beside the cohort record: a device that joined after it still
  // writes the tree. Retired by silence is derived here, never recorded.
  const cohort = cohortStatusHere(ctx.vault, ctx.configPath, ctx.now);
  if (cohort === null) return;
  const states = cohortStates(cohort);
  if (cohort.pending.length > 0) {
    const pending = cohort.pending.map((d) => d.device);
    out.uncertain.push({
      code: LEGACY_DEVICES_PENDING_CODE,
      path: brain,
      message:
        `this machine switched to the brain store; ${pending.join(", ")} still ` +
        `${pending.length === 1 ? "writes" : "write"} the legacy Brain/ tree, so it stays in the ` +
        `vault and their writes are imported as they arrive. Cohort devices: ${states}. Upgrade ` +
        "and migrate each pending one, or retire the ones that are gone with " +
        "`o2b store device retire <device-id>`.",
    });
    return;
  }
  // No cohort at all (no migration recorded one, no device shard names a
  // device): nothing to say about it.
  if (cohort.devices.length === 0) return;
  out.uncertain.push({
    code: LEGACY_TREE_CAN_LEAVE_CODE,
    path: brain,
    message:
      "every device of the migration cohort switched to the brain store or is retired " +
      `(${states}), so the legacy Brain/ tree can leave the vault: run ` +
      `\`${REMOVE_LEGACY_COMMAND}\`. Nothing is removed until you run it.`,
  });
}

/** Devices retired by silence when the tree left that write the reappeared tree, with the threshold. */
interface Returning {
  readonly devices: ReadonlyArray<string>;
  readonly thresholdDays: number | null;
}

/**
 * The devices the reappeared tree's shards name that a removal of this
 * vault retired by silence (the `legacy-tree-removed` records, or this
 * machine's removal marker), or null when none.
 */
function retiredBySilenceWriting(
  vault: string,
  store: StoreHandle,
  vaultId: string | null,
): Returning | null {
  const retired = new Map<string, number | null>();
  const note = (list: unknown, days: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      const device = (entry as { device?: unknown } | null)?.device;
      if (typeof device === "string") retired.set(device, typeof days === "number" ? days : null);
    }
  };
  if (vaultId !== null) {
    for (const r of legacyTreeRemovedRecords(store)) {
      if (r.body["vault_id"] === vaultId) {
        note(r.body["retired_by_silence"], r.body["silence_threshold_days"]);
      }
    }
  }
  note(readRemovalMarker(store, vault)?.retired_by_silence, null);
  const writing = [...legacyDeviceEvidence(vault).keys()].filter((d) => retired.has(d)).toSorted();
  if (writing.length === 0) return null;
  return { devices: writing, thresholdDays: retired.get(writing[0]!) ?? null };
}

function returningMessage(r: Returning): string {
  const names = r.devices.join(", ");
  const one = r.devices.length === 1;
  const days = r.thresholdDays !== null ? ` for more than ${r.thresholdDays} days` : "";
  return (
    "the legacy Brain/ tree was removed from this vault after the migration to the brain " +
    `store, and a Brain/ directory is back: its files are written by ${names}, which ` +
    `${one ? "was" : "were"} retired by silence when the tree left (no evidence of life${days}). ` +
    `${one ? "That machine still runs" : "Those machines still run"} a release that writes the ` +
    `legacy layout: update Open Second Brain on that machine; its migration then imports its ` +
    "legacy records into the brain store as a later machine (switched machines import what it " +
    "writes here meanwhile). Once it has switched, remove the tree again with " +
    `\`${REMOVE_LEGACY_COMMAND}\`.`
  );
}

/** A date of a finding, as a day. */
function dayOf(iso: string | null): string {
  return iso === null ? "none" : iso.slice(0, 10);
}

/** Each cohort device and its state, for a finding. */
function cohortStates(cohort: CohortStatus): string {
  return cohort.devices
    .map((d) => {
      switch (d.state) {
        case "switched":
          return `${d.device} switched`;
        case "retired":
          return `${d.device} retired`;
        case "pending":
          return `${d.device} pending (last evidence ${dayOf(d.last_evidence)})`;
        case "silent":
          return (
            `${d.device} retired by silence (last evidence ${dayOf(d.last_evidence)}, more than ` +
            `${cohort.threshold_days} days before ${dayOf(cohort.as_of)})`
          );
      }
    })
    .join("; ");
}

/**
 * The doctor's finding for a report: a failure (a refusal, a stopped
 * gate, a failed attempt) is a warning that counts; nothing to migrate or
 * a finished switch is no finding; anything else is advice.
 */
export function migrationFindingKind(report: AutoMigrationReport): "warning" | "advice" | null {
  if (report.state === AUTO_MIGRATION_STATE.failed) return "warning";
  if (
    report.state === AUTO_MIGRATION_STATE.notNeeded ||
    report.state === AUTO_MIGRATION_STATE.done
  ) {
    return null;
  }
  return "advice";
}

export const migrationCheck: DoctorCheck = {
  failSoft: true,
  run(ctx: DoctorCheckContext, out: DoctorFindings): void {
    // Read-only: no shard is recorded as seen (`seen-shards.ts`).
    withoutSeenRecording(() => {
      doubleFirstFinding(ctx, out);
      transitionFindings(ctx, out);
      keptCopiesFinding(ctx, out);
    });
    const m = migrationAvailability({ vault: ctx.vault, configPath: ctx.configPath });
    const unreadable =
      m.error !== null
        ? ` The store could not be read (${m.error}), so a switch may be missed.`
        : "";
    const brain = join(ctx.vault, BRAIN_ROOT_REL);
    // The automatic migration's state words the rest (change
    // auto-store-migration, design D6): the same report the status block
    // and `o2b brain upgrade --dry-run` carry, the gate decision's answer.
    // It is read first, whatever is left to migrate: a stopped run's gate
    // closes the vault with nothing left to move, and a switch an attempt
    // did not finish is reported as that, bound or not, before anything
    // below would call it an unimported vault.
    const auto = autoMigrationReport({
      vault: ctx.vault,
      configPath: ctx.configPath,
      availability: m,
      now: ctx.now,
    });
    if (migrationFindingKind(auto) === "warning") {
      // A failure is something to act on, so it counts.
      out.issues.push({
        severity: "warning",
        code: STORE_MIGRATION_FAILED_CODE,
        path: brain,
        message: `${auto.message}.${unreadable}`,
      });
      return;
    }
    if (!m.available) return;
    const steps = m.nextCommands.map((command) => `\`${command}\``).join(", then ");
    if (m.switched) {
      if (interruptedSwitch(ownMigrationRunRead(ctx.configPath))) {
        out.uncertain.push({
          code: MIGRATION_AVAILABLE_CODE,
          path: brain,
          message:
            `${auto.message[0]!.toUpperCase()}${auto.message.slice(1)}; the next start ` +
            `${auto.nextStart}, or run \`${auto.manualCommand ?? MIGRATE_STORE_COMMAND}\`.`,
        });
        return;
      }
      if (m.nextCommands.length === 0) {
        // The vault binding cannot be read: the repair, not an import.
        out.uncertain.push({
          code: MIGRATION_AVAILABLE_CODE,
          path: brain,
          message: `${auto.message[0]!.toUpperCase()}${auto.message.slice(1)}.`,
        });
        return;
      }
      out.uncertain.push({
        code: MIGRATION_AVAILABLE_CODE,
        path: brain,
        message:
          "this machine writes to the brain store, but this vault's legacy Brain/ tree was " +
          "never imported (the vault was configured after the switch), so a migration is " +
          `available. Run ${steps} to import it; nothing moves until you run it.${unreadable}`,
      });
      return;
    }
    const lead =
      "this machine still keeps its brain in the legacy Brain/ tree of the vault and has " +
      "not switched to the brain store, so a migration is available.";
    let tail: string;
    if (
      auto.state === AUTO_MIGRATION_STATE.running ||
      auto.state === AUTO_MIGRATION_STATE.waiting
    ) {
      tail = ` ${auto.message[0]!.toUpperCase()}${auto.message.slice(1)}.`;
    } else if (auto.state === AUTO_MIGRATION_STATE.rolledBack) {
      tail =
        " This machine was rolled back to the legacy layout, and the automatic migration " +
        `does not redo a rollback. Run ${steps} to see what it would move, then run the ` +
        "migration itself when you want the brain store again.";
    } else if (auto.automatic) {
      tail =
        ` Open Second Brain migrates it on its own: the next start ${auto.nextStart} ` +
        "(to stop that, set `auto_store_migration: false` in the machine config). Run " +
        `${steps} to see what it would move.`;
    } else {
      tail =
        ` Run ${steps} to see what it would move; nothing moves until you run the migration ` +
        "itself (the automatic migration is off on this machine" +
        (auto.settingProblem !== null ? `: ${auto.settingProblem}` : "") +
        ").";
    }
    // Reported, never counted: an available migration is advice, so it
    // neither fails `--strict` nor moves the trust verdict on its own.
    out.uncertain.push({
      code: MIGRATION_AVAILABLE_CODE,
      path: brain,
      message: `${lead}${tail}${unreadable}`,
    });
  },
};
