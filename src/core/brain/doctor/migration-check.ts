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
 * switched machine, the cohort devices still on the legacy layout (advice,
 * in the same channel), and a legacy directory that is back in the vault
 * after the tree was removed (a warning, with the writer its files name).
 */

import { closeSync, existsSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";

import { readDeviceId } from "../../config.ts";
import { deviceSwitchedHere } from "../../store/store-only.ts";
import { inspectStore, type StoreHandle } from "../../store/store-open.ts";
import { deviceStateDirFor, resolveConfiguredStoreRoot } from "../../store/store-paths.ts";
import {
  legacyDevices,
  legacyTreeRemovedRecords,
  standingDoneRecords,
} from "../../store-migration/migration-records.ts";
import { readRemovalMarker } from "../../store-migration/removal-marker.ts";
import { listLogShardFiles } from "../log-jsonl.ts";
import { readVaultIdentity } from "../vault-identity.ts";

import { migrationAvailability } from "../../store/migration-availability.ts";
import { BRAIN_ROOT_REL } from "../path-constants.ts";
import type { DoctorCheck, DoctorCheckContext, DoctorFindings } from "./check.ts";
import { withoutSeenRecording } from "../../store/seen-shards.ts";

/** The legacy tree is in the vault and this device has not switched to the store. */
export const MIGRATION_AVAILABLE_CODE = "migration-available";

/** This device switched, and devices of the cohort still write the legacy tree (D11a). */
export const LEGACY_DEVICES_PENDING_CODE = "legacy-devices-pending";

/** A legacy directory is back in the vault after the legacy tree was removed. */
export const LEGACY_TREE_REAPPEARED_CODE = "legacy-tree-reappeared";

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

/** Device ids the legacy log shard names carry (read-only). */
function legacyShardDevices(vault: string): string[] {
  try {
    return [...new Set(listLogShardFiles(vault).map((f) => f.shardId))].filter((d) => d !== "");
  } catch {
    return [];
  }
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

/** This machine's store as the migration readers take it, or null. */
function storeHere(configPath: string | undefined): StoreHandle | null {
  try {
    const inspection = inspectStore(resolveConfiguredStoreRoot(configPath).root);
    const device = readDeviceId(configPath);
    if (inspection === null || device === null) return null;
    return { ...inspection, device, deviceStateDir: deviceStateDirFor(inspection.storeId) };
  } catch {
    return null;
  }
}

/**
 * More than one device recorded `migration-done` for this vault: each
 * imported the legacy tree as the first machine, because neither saw the
 * other's completion record before it started (the sync window).
 */
function doubleFirstFinding(ctx: DoctorCheckContext, out: DoctorFindings): void {
  const store = storeHere(ctx.configPath);
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

/** The two transition findings: devices still on the legacy layout, and a tree that came back. */
function transitionFindings(ctx: DoctorCheckContext, out: DoctorFindings): void {
  const store = storeHere(ctx.configPath);
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
  if (!deviceSwitchedHere(store, store.device)) return;
  // The devices the legacy log shards name, as the transition pass counts
  // them, beside the cohort record: a device that joined after it still
  // writes the tree.
  const pending = legacyDevices(store, legacyShardDevices(ctx.vault));
  if (pending.length === 0) return;
  out.uncertain.push({
    code: LEGACY_DEVICES_PENDING_CODE,
    path: brain,
    message:
      `this machine switched to the brain store; ${pending.join(", ")} still ` +
      `${pending.length === 1 ? "writes" : "write"} the legacy Brain/ tree, so it stays in the ` +
      "vault and their writes are imported as they arrive. Upgrade and migrate each of them, " +
      "or retire the ones that are gone with `o2b store device retire <device-id>`.",
  });
}

export const migrationCheck: DoctorCheck = {
  failSoft: true,
  run(ctx: DoctorCheckContext, out: DoctorFindings): void {
    // Read-only: no shard is recorded as seen (`seen-shards.ts`).
    withoutSeenRecording(() => {
      doubleFirstFinding(ctx, out);
      transitionFindings(ctx, out);
    });
    const m = migrationAvailability({ vault: ctx.vault, configPath: ctx.configPath });
    if (!m.available) return;
    const steps = m.nextCommands.map((command) => `\`${command}\``).join(", then ");
    const unreadable =
      m.error !== null
        ? ` The store could not be read (${m.error}), so a switch may be missed.`
        : "";
    // Reported, never counted: an available migration is advice, so it
    // neither fails `--strict` nor moves the trust verdict on its own.
    out.uncertain.push({
      code: MIGRATION_AVAILABLE_CODE,
      path: join(ctx.vault, BRAIN_ROOT_REL),
      message: m.switched
        ? "this machine writes to the brain store, but this vault's legacy Brain/ tree was " +
          "never imported (the vault was configured after the switch), so a migration is " +
          `available. Run ${steps} to import it; nothing moves until you run it.${unreadable}`
        : "this machine still keeps its brain in the legacy Brain/ tree of the vault and has " +
          `not switched to the brain store, so a migration is available. Run ${steps} to see ` +
          `what it would move; nothing moves until you run the migration itself.${unreadable}`,
    });
  },
};
