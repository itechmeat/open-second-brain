/**
 * `o2b brain migrate-store` on the first machine (task 2.3, design D11):
 * move this vault's legacy brain into the brain store.
 *
 *  1. Preflight: a store exists and its root is outside the vault, this
 *     device has an id and has not switched yet, every legacy entry has a
 *     mapping (the dry run passes), there is room on disk, and no
 *     interrupted run is waiting for `--resume`.
 *  2. Quiesce: the device-local migration gate stops this machine's legacy
 *     content writers, then a settle period lets in-flight writes finish
 *     (`quiesce.ts`); other machines keep writing.
 *  3. Back up: a `Brain/` snapshot and explicit copies of the backup-class
 *     surfaces, each verified by a test restore (`backup.ts`). A failure
 *     stops the run before anything is imported.
 *  4. Record the migration cohort, then convert: pass after pass over the
 *     catalogue, journaled per item and per line, until a pass imports
 *     nothing (the final delta pass, `convert.ts`).
 *  5. Archive every unparseable item into the backup with its path and line.
 *  6. Verify every legacy item against the journal and the store. A gap
 *     fails the run: the legacy tree stays as it was and the report names
 *     each missing item.
 *  7. Record `migration-done` with the cut of each held partition, then
 *     this device's `device-switched`, and lift the freeze.
 *
 * The legacy tree is never modified beyond what the freeze, its log
 * events and the snapshot write, and the migration does not move this
 * machine's writers to the store: the store-only write path reads
 * `device-switched` (`deviceSwitchedHere`, which also reads the sticky
 * device-local marker the switch writes).
 *
 * A run that stops part way (killed, or a failed append) stays
 * `in-progress`; only `--resume` continues it, and it imports nothing
 * twice (`journal.ts`).
 */

import { existsSync, statfsSync } from "node:fs";
import { dirname } from "node:path";

import { resolveAgentName } from "../config.ts";
import { resolveAppendShardId } from "../brain/ledger-shards.ts";
import { readVaultIdentity, writeVaultIdentity } from "../brain/vault-identity.ts";
import { readMigrationGate } from "../migration-gate.ts";
import { appendRecord } from "../store/appender.ts";
import { bindVaultToStore } from "../vault-adapter/vault-binding.ts";
import { claimViewWriter, readViewWriter } from "../view/writer.ts";
import { computeCut, cutHash, readPartition } from "../store/state-digest.ts";
import { deviceSwitchedHere, recordSwitchMarker } from "../store/store-only.ts";
import { openStore, type StoreHandle } from "../store/store-open.ts";
import {
  isPathInsideResolved,
  partitionDir,
  resolveConfiguredStoreRoot,
  StoreRootInsideVaultError,
} from "../store/store-paths.ts";
import type { StorePartition } from "../store/constants.ts";
import {
  archiveUnparseable,
  backupVaultMismatch,
  journalScopeFor,
  readMigrationBackup,
  takeMigrationBackups,
  takeMigrationSnapshot,
  type MigrationBackup,
} from "./backup.ts";
import { importBrainSettings, type BrainSettingsImport } from "./brain-settings.ts";
import { migrationCatalogue } from "./catalogue.ts";
import {
  placeDeviceTokens,
  writeDeviceSettings,
  type DeviceConfigWrite,
  type DeviceTokenPlacement,
} from "./device-config.ts";
import { waitForCut, type CutWait } from "./later.ts";
import { moveDeviceLocalState, placeVaultFiles } from "./local-state.ts";
import {
  convertPass,
  dualWritePool,
  verifyImport,
  type ConvertHooks,
  type VerificationGap,
} from "./convert.ts";
import { planMigrationDryRun } from "./dry-run.ts";
import {
  describeUnseen,
  loadJournal,
  migrationDir,
  readMigrationState,
  unseenHeldShards,
  writeMigrationState,
  type MigrationState,
} from "./journal.ts";
import {
  cohortBody,
  deviceSwitchedBody,
  hasCohortRecord,
  legacyDevices,
  standingDoneRecords,
  MIGRATION_COHORT_KIND,
  MIGRATION_DONE_KIND,
  DEVICE_SWITCHED_KIND,
  MIGRATION_STREAM,
  migrationDoneBody,
  type PartitionCut,
} from "./migration-records.ts";
import { legacyFileStamps, recordImportWatermark } from "./transition-watermark.ts";
import { liftQuiesce, MIGRATION_SETTLE_MS, quiesceLegacyWriters } from "./quiesce.ts";
import { sameVaultPath } from "./removal-marker.ts";

/** The most passes the final delta pass may take before the run gives up. */
export const MIGRATION_MAX_PASSES = 20;

/**
 * The devices whose standing migration named its vault by an identity
 * marker, when `vault` has none: a later machine of that vault waits for
 * the marker to arrive by sync rather than mint a second one.
 */
function markedElsewhere(store: StoreHandle, vault: string): string[] {
  if (readVaultIdentity(vault) !== null) return [];
  const devices = standingDoneRecords(store)
    .filter((r) => r.device !== store.device && typeof r.body["vault_id"] === "string")
    .map((r) => r.device);
  return [...new Set(devices)].toSorted();
}

/** A migration that cannot start, with the reason and the remedy. */
export class MigrationRefusedError extends Error {
  override readonly name = "MigrationRefusedError";
}

/** A later machine whose store does not hold the first machine's whole cut yet. */
export class MigrationWaitingError extends Error {
  override readonly name = "MigrationWaitingError";
  constructor(readonly wait: CutWait) {
    super(
      wait.marker === true
        ? `waiting for the vault identity marker the first migration ` +
            `(${wait.firstMachines.join(", ")}) gave this vault to arrive by sync; if this is ` +
            "another vault, give it its own marker with `o2b brain init`, then run the " +
            "migration again"
        : `waiting for the brain store files of the first migration (${wait.firstMachines.join(", ")}) ` +
            `to arrive by sync: ${wait.missing.length} shard(s) are missing or short (` +
            `${wait.missing.slice(0, 5).join(", ")}${wait.missing.length > 5 ? ", ..." : ""}); ` +
            "run the migration again once they arrive",
    );
  }
}

/**
 * Fault-injection points; the CLI never sets them. They stay because the
 * moments they mark (writers frozen after the backups, the tree changing
 * right before verification) cannot be reached deterministically from
 * outside a run that takes milliseconds; see {@link ConvertHooks}.
 */
export interface MigrationHooks extends ConvertHooks {
  /** After the backups, while the legacy writers are frozen. */
  readonly afterBackup?: () => void;
  /** After the last delta pass, before verification. */
  readonly beforeVerify?: () => void;
}

export interface MigrationOptions {
  readonly resume?: boolean;
  readonly configPath?: string;
  readonly agent?: string;
  /**
   * The settle wait after the gate closes, in ms (default
   * {@link MIGRATION_SETTLE_MS}). The CLI keeps the default; tests shorten
   * it because the wait only matters when writers are in flight.
   */
  readonly settleMs?: number;
  readonly hooks?: MigrationHooks;
  /** How long a later machine waits for the first machine's cut, in ms (default 0). */
  readonly waitMs?: number;
}

export interface MigrationResult {
  /** True when the store holds every legacy item and `migration-done` was recorded. */
  readonly ok: boolean;
  readonly run_id: string;
  readonly device: string;
  readonly store_root: string;
  readonly imported: number;
  readonly passes: number;
  readonly unparseable: number;
  readonly unparseable_archive: string;
  readonly backup: MigrationBackup | null;
  readonly cohort: ReadonlyArray<string>;
  readonly gaps: ReadonlyArray<VerificationGap>;
  readonly migration_done: string | null;
  readonly device_switched: string | null;
  /** The view writer after the run (this device when it claimed the role). */
  readonly view_writer: string | null;
  /** `first`: no device had finished; `later`: another device's cut was waited on. */
  readonly role: "first" | "later";
  /** Vault-relative paths of the device-local surfaces copied into device-local state. */
  readonly device_local: ReadonlyArray<string>;
  /** Legacy files placed as files in the vault (accepted skills under `skills/`). */
  readonly vault_files: ReadonlyArray<string>;
  /** Legacy files whose switched location already held a different file, kept as it was. */
  readonly vault_files_kept: ReadonlyArray<string>;
  /** Partitions a completion record names that this machine does not hold. */
  readonly skipped_partitions: ReadonlyArray<StorePartition>;
  /** What became of `_brain.yaml`; null when the run did not finish. */
  readonly settings: BrainSettingsImport | null;
  /** The changed device keys of `_brain.yaml` written to the machine config; null when unfinished. */
  readonly device_config: DeviceConfigWrite | null;
  /** The MCP token map copied to device config; null when unfinished. */
  readonly device_tokens: DeviceTokenPlacement | null;
}

export function openMigrationStore(vault: string, configPath?: string): StoreHandle {
  const { root, origin } = resolveConfiguredStoreRoot(configPath);
  if (isPathInsideResolved(root, vault, process.platform)) {
    throw new StoreRootInsideVaultError(root, vault, origin);
  }
  const device = resolveAppendShardId();
  if (device === "") {
    throw new MigrationRefusedError(
      "this machine has no device id; set device_id in the machine config or O2B_DEVICE_ID",
    );
  }
  return openStore({ root, device });
}

/** `dir`, or its nearest ancestor that exists (a first run has no device state yet). */
function existingAncestor(dir: string): string {
  let current = dir;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function checkDisk(dir: string, bytes: number): void {
  let free: number;
  try {
    const stat = statfsSync(existingAncestor(dir));
    free = Number(stat.bavail) * Number(stat.bsize);
  } catch {
    return; // not measurable here: the backups fail loudly on a full disk instead
  }
  if (free < bytes * 2) {
    throw new MigrationRefusedError(
      `the migration needs about ${bytes * 2} free bytes for its backups and records; ${free} are free`,
    );
  }
}

function settingsRecord(
  store: StoreHandle,
  agent: string,
  kind: string,
  body: Record<string, unknown>,
): string {
  return appendRecord(store, { partition: "shared", stream: MIGRATION_STREAM, kind, agent, body })
    .record.id;
}

function partitionCuts(store: StoreHandle): Partial<Record<StorePartition, PartitionCut>> {
  const cuts: Partial<Record<StorePartition, PartitionCut>> = {};
  for (const partition of store.partitions) {
    const cut = computeCut(readPartition(partitionDir(store.root, partition)));
    cuts[partition] = { cut, cut_hash: cutHash(cut) };
  }
  return cuts;
}

/**
 * A refusal while a held shard's records cannot all be seen (unreadable,
 * gone since this machine read it, or read only in part), or null. The
 * run imports over the store's `migrated` marks and verifies against its
 * records: a mark in a hidden shard would import its item twice, and a
 * record in one could not be verified. So the run refuses before it
 * imports anything, and again before it switches.
 */
function unseenRefusal(store: StoreHandle): string | null {
  const named = describeUnseen(unseenHeldShards(store));
  return named === null
    ? null
    : `${named}; fix their permissions, let sync finish or repair the shard, then run the ` +
        "migration again";
}

function preflight(store: StoreHandle, options: MigrationOptions): MigrationState | null {
  if (!store.partitions.has("shared")) {
    throw new MigrationRefusedError("this machine does not hold the shared partition of the store");
  }
  if (deviceSwitchedHere(store, store.device)) {
    throw new MigrationRefusedError(
      `device ${store.device} has already switched to the brain store`,
    );
  }
  const state = readMigrationState(migrationDir(store));
  if (state?.phase === "in-progress" && options.resume !== true) {
    throw new MigrationRefusedError(
      `an interrupted migration (${state.run_id}) is waiting; run \`o2b brain migrate-store --resume\``,
    );
  }
  const unseen = unseenRefusal(store);
  if (unseen !== null) throw new MigrationRefusedError(unseen);
  return state;
}

/**
 * The steps after `device-switched`: bind the vault to the store and claim
 * the view writer on the first machine. It neither records the run as
 * done nor opens the gate: the callers save `phase: done` and call
 * `liftQuiesce` themselves. Every step is idempotent, so a run killed
 * after its switch record is finished by the next `migrate-store`
 * ({@link finishInterruptedSwitch}).
 */
function finishSwitch(
  vault: string | null,
  store: StoreHandle,
  agent: string,
  first: boolean,
): string | null {
  // The switch is sticky on this machine from here on (`store-only.ts`):
  // an absent or unreadable `settings` shard never takes it back.
  recordSwitchMarker(store.root, store.device);
  // The switched vault is bound to the store in device-local state, so
  // the note tools' guard knows it once no marker file guards it (D14.13).
  if (vault !== null) bindVaultToStore(vault, { store });
  // The first machine to migrate renders the human view (design D7),
  // unless a writer was already named.
  const claim = first
    ? claimViewWriter(store, { agent })
    : { claimed: false as const, writer: readViewWriter(store).writer };
  return claim.claimed ? store.device : claim.writer;
}

/**
 * This device's own standing `migration-done`, when its current run
 * recorded one: a done record of an earlier run that was rolled back does
 * not count (`standingDoneRecords`).
 */
function ownDoneRecord(store: StoreHandle): string | null {
  return standingDoneRecords(store).find((r) => r.device === store.device)?.id ?? null;
}

/**
 * The vault an interrupted run migrated, as far as this machine can tell:
 * the vault its backup manifest names (compared as a rollback compares
 * it, by identity marker, else by real path), else the vault the gate of
 * the run names. `same` says whether that is `vault`.
 */
function interruptedVault(
  dir: string,
  vault: string,
  runId: string,
): { readonly same: boolean; readonly original: string | null } {
  const backup = readMigrationBackup(dir);
  if (backup !== null && backup.vault !== null) {
    return { same: backupVaultMismatch(backup, vault) === null, original: backup.vault.path };
  }
  const gate = readMigrationGate();
  const original = gate !== null && gate.run_id === runId ? gate.vault : null;
  return { same: original !== null && sameVaultPath(original, vault), original };
}

/**
 * Finish a migration killed between its `device-switched` record and its
 * last step: the device is switched while its run is still `in-progress`.
 * Returns whether there was one to finish.
 *
 * Only the vault the run migrated is bound. When another vault is
 * configured now, the switch is finished for the original vault (bound
 * when it is still there, its gate opened) and `vault` is left unbound:
 * it then goes through the transition's own checks (its settings, a
 * permissions conflict, items held back) like any vault configured after
 * the switch.
 */
export function finishInterruptedSwitch(vault: string, store: StoreHandle, agent: string): boolean {
  const dir = migrationDir(store);
  const state = readMigrationState(dir);
  if (state?.phase !== "in-progress" || !deviceSwitchedHere(store, store.device)) return false;
  const { same, original } = interruptedVault(dir, vault, state.run_id);
  const toBind = same ? vault : original !== null && existsSync(original) ? original : null;
  try {
    finishSwitch(toBind, store, agent, ownDoneRecord(store) !== null);
    writeMigrationState(dir, { ...state, phase: "done", updated_at: new Date().toISOString() });
  } finally {
    liftQuiesce(same ? vault : (original ?? vault), state.run_id);
  }
  return true;
}

/** Run (or resume) the migration of `vault` on this machine. */
export function runMigration(vault: string, options: MigrationOptions = {}): MigrationResult {
  const store = openMigrationStore(vault, options.configPath);
  const previous = preflight(store, options);
  const plan = planMigrationDryRun(vault);
  if (!plan.ok) {
    const listed = plan.unmapped
      .slice(0, 10)
      .map((u) => u.path)
      .join(", ");
    throw new MigrationRefusedError(
      `${plan.unmapped.length} legacy entr(ies) have no destination (${listed}); ` +
        "run `o2b brain migrate-store --dry-run` for the full plan",
    );
  }
  // A later machine (design D11 "Later machines"): another device already
  // finished; wait until this copy of the store holds its whole cut. This
  // device's own completion (a resumed run that recorded it) keeps it first.
  const ownDone = ownDoneRecord(store);
  const later = ownDone === null && standingDoneRecords(store).length > 0;
  const wait = later ? waitForCut(store, options.waitMs ?? 0) : null;
  if (wait !== null && wait.missing.length > 0) throw new MigrationWaitingError(wait);
  if (wait !== null) {
    const marked = markedElsewhere(store, vault);
    if (marked.length > 0) {
      throw new MigrationWaitingError({ ...wait, firstMachines: marked, marker: true });
    }
  }
  const dir = migrationDir(store);
  checkDisk(
    store.deviceStateDir,
    plan.surfaces.reduce((sum, s) => sum + s.bytes, 0),
  );

  const agent = options.agent ?? safeAgent(options.configPath);
  const now = new Date().toISOString();
  const resuming = options.resume === true && previous?.phase === "in-progress";
  let state: MigrationState = {
    run_id: resuming ? previous!.run_id : `migrate-${now.replace(/[-:.]/g, "")}`,
    phase: "in-progress",
    started_at: resuming ? previous!.started_at : now,
    updated_at: now,
    backed_up: resuming ? previous!.backed_up : false,
  };
  const save = (next: Partial<MigrationState>): void => {
    state = { ...state, ...next, updated_at: new Date().toISOString() };
    writeMigrationState(dir, state);
  };
  const backupStep = <T>(step: () => T): T => {
    try {
      return step();
    } catch (error) {
      save({ phase: "failed", reason: (error as Error).message });
      throw error;
    }
  };
  // The vault carries its identity marker before any journal mark names
  // it (`journal-scope.ts`): a path is a device's own, and the marker is
  // what a later machine of the same vault, which receives it by sync,
  // matches the marks by. This machine is not switched yet, so the marker
  // is a legacy-layout write (the snapshot below includes it).
  const vaultId = writeVaultIdentity(vault).vault_id;
  const cohort = plan.devices.cohort.map((d) => d.device);
  // A resumed run that already backed up reports the backup it took.
  let backup: MigrationBackup | null = state.backed_up ? readMigrationBackup(dir) : null;
  try {
    quiesceLegacyWriters(vault, state.run_id, options.settleMs ?? MIGRATION_SETTLE_MS);
    // The run is on record once it holds the gate: a run refused by a
    // gate another run holds leaves no interrupted run behind.
    save({});
    const catalogue = migrationCatalogue(vault);
    if (!state.backed_up) {
      const snapshot = backupStep(() => takeMigrationSnapshot(vault, dir));
      backup = backupStep(() => takeMigrationBackups(vault, catalogue, dir, snapshot));
      save({ backed_up: true });
    }
    const local = backupStep(() => moveDeviceLocalState(vault, catalogue, dir));
    // Accepted skills are files agents read: they move to the vault's own
    // skills/ folder, never into the store (design D14, task 2.10).
    const skills = backupStep(() => placeVaultFiles(vault, catalogue));
    options.hooks?.afterBackup?.();
    if (!hasCohortRecord(store)) {
      settingsRecord(store, agent, MIGRATION_COHORT_KIND, cohortBody(vaultId, cohort));
    }

    const scope = journalScopeFor(vault, store.device, dir);
    const journal = loadJournal(dir, store, scope);
    const ctx = {
      vault,
      store,
      vaultId,
      agent,
      dir,
      journal,
      scope,
      pool: dualWritePool(store, journal, scope),
      ...(options.hooks ? { hooks: options.hooks } : {}),
    };
    let imported = 0;
    let passes = 0;
    // The legacy-file stamps taken before each pass: those of the final
    // (delta) pass become the automatic import's watermark at the switch.
    let stamps = legacyFileStamps(vault);
    let last = convertPass(ctx);
    for (passes = 1; ; passes++) {
      imported += last.imported;
      if (last.imported === 0) break;
      if (passes >= MIGRATION_MAX_PASSES) {
        throw new Error(
          `the legacy tree kept changing after ${passes} passes; stop its writers and resume`,
        );
      }
      stamps = legacyFileStamps(vault);
      last = convertPass(ctx);
    }
    const archive = archiveUnparseable(vault, dir, last.problems);
    options.hooks?.beforeVerify?.();
    const gaps = verifyImport(ctx, last.seen);
    const base = {
      run_id: state.run_id,
      device: store.device,
      store_root: store.root,
      imported,
      passes,
      unparseable: last.problems.length,
      unparseable_archive: archive,
      backup,
      cohort,
      gaps,
      role: later ? ("later" as const) : ("first" as const),
      device_local: local,
      vault_files: skills.placed,
      vault_files_kept: skills.kept,
      skipped_partitions: wait?.skipped ?? [],
    };
    if (gaps.length > 0) {
      save({ phase: "failed", reason: `${gaps.length} legacy item(s) are not in the store` });
      return {
        ok: false,
        ...base,
        migration_done: null,
        device_switched: null,
        view_writer: null,
        settings: null,
        device_config: null,
        device_tokens: null,
      };
    }
    // The switch is the step a later run cannot take back: every held
    // shard reads in full first, or the run fails and this machine stays
    // on the legacy layout.
    const unseen = unseenRefusal(store);
    if (unseen !== null) {
      save({ phase: "failed", reason: unseen });
      throw new MigrationRefusedError(`${unseen}; this machine was not switched`);
    }
    const settings = importBrainSettings(vault, store, agent);
    // Device keys go to this machine's config and the token map beside it,
    // so neither falls back to a default once the vault's files stop
    // counting (D14 items 3 and 15).
    const deviceConfig = writeDeviceSettings(settings.device, options.configPath);
    const deviceTokens = placeDeviceTokens(vault, options.configPath, dir);
    // Only the first machine records the completion and its cut, once: a
    // resumed run that recorded it keeps that record.
    const done = later
      ? null
      : (ownDone ??
        settingsRecord(
          store,
          agent,
          MIGRATION_DONE_KIND,
          migrationDoneBody({
            vaultId,
            device: store.device,
            cuts: partitionCuts(store),
            imported,
          }),
        ));
    const switched = settingsRecord(
      store,
      agent,
      DEVICE_SWITCHED_KIND,
      deviceSwitchedBody(vaultId, store.device),
    );
    // The automatic import's baseline: the tree as the final pass read it,
    // all of it imported (`transition-watermark.ts`).
    recordImportWatermark(store, {
      stamps,
      devices: legacyDevices(store, [...last.devices]),
      converged: true,
      heldBack: 0,
    });
    const viewWriter = finishSwitch(vault, store, agent, !later);
    save({ phase: "done" });
    return {
      ok: true,
      ...base,
      migration_done: done,
      device_switched: switched,
      view_writer: viewWriter,
      settings,
      device_config: deviceConfig,
      device_tokens: deviceTokens,
    };
  } finally {
    liftQuiesce(vault, state.run_id);
  }
}

export function safeAgent(configPath?: string): string {
  try {
    return resolveAgentName(configPath);
  } catch {
    return "o2b-migrate-store";
  }
}
