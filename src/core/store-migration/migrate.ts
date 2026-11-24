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
import { legacyLogSeed } from "../brain/vault-seed.ts";
import { readMigrationGate, recordMigrationGateProgress } from "../migration-gate.ts";
import { appendRecord } from "../store/appender.ts";
import { bindVaultToStore } from "../vault-adapter/vault-binding.ts";
import { claimViewWriter, readViewWriter } from "../view/writer.ts";
import { cutHash, readPartitionCut } from "../store/state-digest.ts";
import { deviceSwitchedHere, recordSwitchMarker } from "../store/store-only.ts";
import { openStore, type StoreHandle } from "../store/store-open.ts";
import {
  storeRootForbiddenInVault,
  partitionDir,
  resolveConfiguredStoreRoot,
  StoreRootInsideVaultError,
} from "../store/store-paths.ts";
import type { StorePartition } from "../store/constants.ts";
import {
  archiveSyncCopies,
  archiveUnparseable,
  backupVaultMismatch,
  journalScopeFor,
  readMigrationBackup,
  takeMigrationBackups,
  takeMigrationSnapshot,
  type MigrationBackup,
} from "./backup.ts";
import {
  BrainSettingsUnreadableError,
  importBrainSettings,
  type BrainSettingsImport,
} from "./brain-settings.ts";
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
import { retainedSyncCopies, type SyncCopyReport } from "./sync-leftovers.ts";
import { IncrementalReads, saveIncrementalReads } from "./incremental-reads.ts";
import {
  clearRollbackRecord,
  describeUnseen,
  loadJournalAndUnmarked,
  readFinalStoreView,
  type UnseenShards,
  type Journal,
  migrationDir,
  readMigrationState,
  unseenHeldShards,
  writeMigrationState,
  type MigrationState,
} from "./journal.ts";
import {
  cohortBody,
  ownSwitchLacksCut,
  deviceSwitchedBody,
  hasCohortRecord,
  latestOwnSwitch,
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
import {
  holdGateFor,
  MigrationGateBusyError,
  MIGRATION_SETTLE_MS,
  migrationGateOn,
  MIGRATION_RUN_PREFIX,
  quiesceLegacyWriters,
  releaseGateAfter,
  releaseStoppedRunGate,
} from "./quiesce.ts";
import { sameVaultPath } from "./removal-marker.ts";
import { MigrationScratch } from "./spill-map.ts";
import { gcHint } from "../store/gc-hint.ts";

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

/**
 * An automatic call ({@link MigrationOptions.automatic}) met a device that
 * switched meanwhile: the transition import of a vault configured after
 * the switch is the operator's to run, and nothing was done.
 */
export class MigrationSwitchedError extends Error {
  override readonly name = "MigrationSwitchedError";
  constructor(readonly device: string) {
    super(
      `device ${device} switched to the brain store while the automatic migration was ` +
        "starting; a vault configured after the switch is imported by the manual command",
    );
  }
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
  /** After the checks made before the gate, before the run takes it. */
  readonly beforeGate?: () => void;
  /**
   * At each named step boundary of the run ({@link MigrationStep}), so a
   * test can throw or kill its own process exactly there.
   */
  readonly atStep?: (step: MigrationStep) => void;
}

/** The step boundaries {@link MigrationHooks.atStep} names, in run order. */
export const MIGRATION_STEP = Object.freeze({
  /**
   * The gate is closed and the settle wait is over; the run is not on
   * record yet (its state is saved right after).
   */
  gateTaken: "gate-taken",
  /** The gate is closed and the run is on record. */
  gateClosed: "gate-closed",
  /** The snapshot and the backups are taken and verified. */
  backedUp: "backed-up",
  /**
   * The import is verified and every held shard read in full: the switch's
   * steps follow (the settings import first).
   */
  verified: "verified",
  /** `migration-done` is recorded (the first machine only). */
  migrationDone: "migration-done",
  /** This device's `device-switched` is recorded. */
  deviceSwitched: "device-switched",
  /** The sticky switch marker is written. */
  switchMarker: "switch-marker",
  /** The vault is bound to the store. */
  vaultBound: "vault-bound",
  /** The view writer is claimed (or read). */
  viewWriter: "view-writer",
} as const);

export type MigrationStep = (typeof MIGRATION_STEP)[keyof typeof MIGRATION_STEP];

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
  /**
   * How many items the import writes per batch (default
   * `IMPORT_BATCH_ITEMS` in `import-batch.ts`). The CLI keeps the default; the crash tests
   * use a small batch so a kill lands with part of a small vault imported.
   */
  readonly importBatchItems?: number;
  /**
   * How many entries a map with one entry per legacy item or store record
   * (the journal, the items a pass saw, the store's checksums) holds in
   * memory before it moves to the run's scratch file (default
   * `SPILL_AT_ENTRIES` in `spill-map.ts`). The CLI keeps the default; tests
   * set it low so a small vault runs the on-disk maps.
   */
  readonly spillAt?: number;
  readonly hooks?: MigrationHooks;
  /** How long a later machine waits for the first machine's cut, in ms (default 0). */
  readonly waitMs?: number;
  /**
   * Refuse, before the switch, when conversion met an item it cannot
   * parse, instead of keeping it only in the backup archive. The automatic
   * migration sets it (nobody watches it, so the person decides, as its dry
   * run leaves it to them); the command line keeps the archive.
   */
  readonly refuseUnparseable?: boolean;
  /**
   * The automatic worker's call: on a device that switched meanwhile the
   * migrator refuses (`MigrationSwitchedError` in `outcome.ts`) instead of running
   * the transition import, which imports a vault configured after the
   * switch (its settings at the operator's authority, its binding) and is
   * the operator's to run.
   */
  readonly automatic?: boolean;
  /**
   * Each step the run records in its progress file (`migration-gate.ts`),
   * with the import's counts once known: the automatic worker writes them
   * to its log, `o2b update` to stderr. Called after every import batch.
   */
  readonly onProgress?: (
    step: string,
    counts?: { readonly journaled: number; readonly planned: number },
  ) => void;
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
  /** What the sync tool's conflict copies and temp files became (`sync-leftovers.ts`). */
  readonly sync_copies: SyncCopyReport;
  /** The backup folder the kept conflict copies are in; null when none was kept. */
  readonly sync_copies_archive: string | null;
}

/** Items a journal holds, each version once. */
function journaledItems(journal: Journal): number {
  return journal.size;
}

/** Items the dry run found on the surfaces that become records. */
function plannedRecordItems(plan: ReturnType<typeof planMigrationDryRun>): number {
  let n = 0;
  for (const s of plan.surfaces) {
    if (s.partitions !== null)
      n += s.partitions.shared + s.partitions.private + s.partitions["private-when-held"];
  }
  return n;
}

export function openMigrationStore(vault: string, configPath?: string): StoreHandle {
  const { root, origin } = resolveConfiguredStoreRoot(configPath);
  if (storeRootForbiddenInVault(root, vault, process.platform)) {
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

export function checkDisk(dir: string, bytes: number): void {
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
    // Record by record: only each shard's count, last id and pending count.
    const cut = readPartitionCut(partitionDir(store.root, partition));
    cuts[partition] = { cut, cut_hash: cutHash(cut) };
  }
  return cuts;
}

/** {@link partitionCuts} of only the shards `store.device` writes (`<stream>/<device>/<month>.jsonl`). */
function ownShardCuts(store: StoreHandle): Partial<Record<StorePartition, PartitionCut>> {
  const cuts: Partial<Record<StorePartition, PartitionCut>> = {};
  for (const [partition, all] of Object.entries(partitionCuts(store))) {
    const cut = all.cut.filter((entry) => entry.shard.split("/").at(-2) === store.device);
    cuts[partition as StorePartition] = { cut, cut_hash: cutHash(cut) };
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
function unseenRefusal(store: StoreHandle, unseen?: UnseenShards): string | null {
  const named = describeUnseen(unseen ?? unseenHeldShards(store));
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
  const read = readMigrationState(migrationDir(store));
  if (read.kind === "unreadable") {
    throw new MigrationRefusedError(
      `this device's migration run state cannot be read (${read.error}); fix its ` +
        "permissions or restore it, then run the migration again",
    );
  }
  const state = read.kind === "state" ? read.state : null;
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
  hooks?: MigrationHooks,
): string | null {
  // The switch is sticky on this machine from here on (`store-only.ts`):
  // an absent or unreadable `settings` shard never takes it back.
  recordSwitchMarker(store.root, store.device);
  hooks?.atStep?.(MIGRATION_STEP.switchMarker);
  // The switched vault is bound to the store in device-local state, so
  // the note tools' guard knows it once no marker file guards it (D14.13).
  if (vault !== null) bindVaultToStore(vault, { store });
  hooks?.atStep?.(MIGRATION_STEP.vaultBound);
  // The first machine to migrate renders the human view (design D7),
  // unless a writer was already named.
  const claim = first
    ? claimViewWriter(store, { agent })
    : { claimed: false as const, writer: readViewWriter(store).writer };
  hooks?.atStep?.(MIGRATION_STEP.viewWriter);
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

/** An interrupted switch as read: its run state and the vault it migrated. */
interface InterruptedSwitch {
  readonly state: MigrationState;
  readonly same: boolean;
  readonly original: string | null;
}

/**
 * This device's interrupted switch, or null when there is none: the device
 * is switched while its run state is still `in-progress`. A run state that
 * cannot be read refuses: it could be a run whose switch did not finish,
 * never read as one that did.
 */
function readInterruptedSwitch(vault: string, store: StoreHandle): InterruptedSwitch | null {
  const dir = migrationDir(store);
  if (!deviceSwitchedHere(store, store.device)) return null;
  const read = readMigrationState(dir);
  if (read.kind === "unreadable") {
    throw new MigrationRefusedError(
      `this device's migration run state cannot be read (${read.error}); fix its ` +
        "permissions or restore it, then run the migration again",
    );
  }
  if (read.kind !== "state" || read.state.phase !== "in-progress") return null;
  return { state: read.state, ...interruptedVault(dir, vault, read.state.run_id) };
}

/**
 * Finish a migration killed between its `device-switched` record and its
 * last step: the device is switched while its run is still `in-progress`.
 * Returns whether there was one to finish.
 *
 * The finish takes the gate of that run as the run itself held it (a dead
 * holder's gate of the run is taken over, a live holder refuses it with
 * {@link MigrationGateBusyError}, and an interrupted rollback's or
 * removal's gate is never taken over), reads the run state and the vault it
 * migrated again under it (another finish may have ended the run in
 * between), and opens only the gate it holds, under the gate lock.
 *
 * Only the vault the run migrated is bound. When another vault is
 * configured now, the switch is finished for the original vault (bound
 * when it is still there, its gate opened) and `vault` is left unbound:
 * it then goes through the transition's own checks (its settings, a
 * permissions conflict, items held back) like any vault configured after
 * the switch.
 */
export function finishInterruptedSwitch(vault: string, store: StoreHandle, agent: string): boolean {
  const seen = readInterruptedSwitch(vault, store);
  if (seen === null) return false;
  const runId = seen.state.run_id;
  const gateVault = seen.same ? vault : (seen.original ?? vault);
  holdGateFor(gateVault, runId, { takeOver: (held) => held.startsWith(MIGRATION_RUN_PREFIX) });
  let failure: { readonly error: unknown } | null = null;
  try {
    const now = readInterruptedSwitch(vault, store);
    if (now === null || now.state.run_id !== runId) return false;
    // The backup manifest is read again; the gate now names this finish's
    // own choice, so without a manifest the first read's vault stands.
    const manifest = readMigrationBackup(migrationDir(store))?.vault ?? null;
    const { same, original } = manifest !== null ? now : seen;
    const toBind = same ? vault : original !== null && existsSync(original) ? original : null;
    finishSwitch(toBind, store, agent, ownDoneRecord(store) !== null);
    writeMigrationState(migrationDir(store), {
      ...now.state,
      phase: "done",
      updated_at: new Date().toISOString(),
    });
    return true;
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    releaseGateAfter(gateVault, runId, failure);
  }
}

/** What {@link runMigration} checks before it takes the gate. */
interface BeforeGate {
  readonly previous: MigrationState | null;
  readonly plan: ReturnType<typeof planMigrationDryRun>;
  readonly later: boolean;
  readonly ownDone: string | null;
  readonly wait: ReturnType<typeof waitForCut> | null;
}

function beforeGate(vault: string, store: StoreHandle, options: MigrationOptions): BeforeGate {
  const previous = preflight(store, options);
  const plan = planMigrationDryRun(vault);
  if (!plan.ok) {
    if (plan.unreadable_folders.length > 0) {
      throw new MigrationRefusedError(
        `${plan.unreadable_folders.length} legacy folder(s) could not be read ` +
          `(${plan.unreadable_folders.slice(0, 10).join(", ")}), so what they hold has no ` +
          "planned destination; fix their permissions and run `o2b brain migrate-store --dry-run`",
      );
    }
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
  checkDisk(
    store.deviceStateDir,
    plan.surfaces.reduce((sum, s) => sum + s.bytes, 0),
  );
  return { previous, plan, later, ownDone, wait };
}

/**
 * The run of this machine that stopped before its switch, whose gate on
 * `vault` a run that ends before taking the gate over must not leave
 * closed ({@link releaseStoppedRunGate}), or null: the migration run the
 * gate names, on a machine that has not switched. That is the run still
 * `in-progress` in its state, or a run killed after it took the gate and
 * before it put itself on record, which no state names. The release
 * itself leaves a live holder alone.
 */
export function stoppedUnswitchedRun(vault: string, store: StoreHandle): string | null {
  if (deviceSwitchedHere(store, store.device)) return null;
  return migrationGateOn(vault);
}

/**
 * The checks of {@link beforeGate}, read again once the run holds the gate:
 * the store as configured, whether this device switched, the run state,
 * the done records, the vault marker another machine's migration names,
 * the plan. A device switched meanwhile stops an automatic run with
 * {@link MigrationSwitchedError} and a manual one with the preflight's
 * refusal. A run state or a done record that changed means another run
 * acted in between: the run stops with {@link MigrationGateBusyError}
 * before its first write, and the next run decides afresh. The cut is not
 * waited for again: the gate is held, and a store that stopped holding it
 * is a wait.
 */
function underGate(
  vault: string,
  before: StoreHandle,
  options: MigrationOptions,
  checked: BeforeGate,
): { readonly store: StoreHandle; readonly checked: BeforeGate } {
  const store = openMigrationStore(vault, options.configPath);
  if (store.root !== before.root || store.device !== before.device) {
    throw new MigrationGateBusyError(
      "this machine's brain store changed while the migration waited for its gate; nothing " +
        "was changed. Run the migration again",
    );
  }
  if (options.automatic === true && deviceSwitchedHere(store, store.device)) {
    throw new MigrationSwitchedError(store.device);
  }
  const again = beforeGate(vault, store, { ...options, waitMs: 0 });
  if (
    !sameRunState(checked.previous, again.previous) ||
    again.ownDone !== checked.ownDone ||
    again.later !== checked.later
  ) {
    throw new MigrationGateBusyError(
      "another run changed this machine's migration while this one waited for its gate; " +
        "nothing was changed. Run the migration again",
    );
  }
  return { store, checked: again };
}

/** Whether two reads of the run state name the same run at the same point. */
function sameRunState(a: MigrationState | null, b: MigrationState | null): boolean {
  if (a === null || b === null) return a === b;
  return a.run_id === b.run_id && a.phase === b.phase && a.backed_up === b.backed_up;
}

/** Run (or resume) the migration of `vault` on this machine. */
export function runMigration(vault: string, options: MigrationOptions = {}): MigrationResult {
  let store = openMigrationStore(vault, options.configPath);
  let checked: BeforeGate;
  try {
    checked = beforeGate(vault, store, options);
  } catch (error) {
    // Refused or waiting before the gate was taken over: a run this
    // machine stopped with the gate closed does not keep it closed. A
    // cleanup that fails (the gate lock busy) never replaces the reason
    // the run stopped: it is added to it, and the caller's error keeps
    // its kind (a wait stays a wait).
    const stopped = stoppedUnswitchedRun(vault, store);
    if (stopped !== null) {
      try {
        releaseStoppedRunGate(vault, stopped);
      } catch (cleanup) {
        if (error instanceof Error) {
          error.message +=
            `; the migration gate run ${stopped} left on this vault could not be opened ` +
            `(${(cleanup as Error).message})`;
        }
      }
    }
    throw error;
  }
  const previous = checked.previous;
  let dir = migrationDir(store);

  const agent = options.agent ?? safeAgent(options.configPath);
  const now = new Date().toISOString();
  const resuming = options.resume === true && previous?.phase === "in-progress";
  let state: MigrationState = {
    run_id: resuming ? previous!.run_id : `${MIGRATION_RUN_PREFIX}${now.replace(/[-:.]/g, "")}`,
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
  // Only a gate this run took is opened again at its end: a run refused at
  // the gate (another process resumes the same run and holds it) leaves
  // it to its holder.
  let held = false;
  let failure: { readonly error: unknown } | null = null;
  // How far the run is, its step and, once its import began, its counts:
  // the one progress file (`migration-gate.ts`), read by the writers it
  // refuses, the status block and the doctor. Written from the moment this
  // run holds the gate, so a write refused in the first seconds of the run
  // (the settle wait, the checks made again under the gate) names the step.
  let step = "";
  let counts: { journaled: number; planned: number } | undefined;
  const progress = (text: string = step): void => {
    step = text;
    recordMigrationGateProgress(state.run_id, step, counts);
    try {
      options.onProgress?.(step, counts);
    } catch {
      // a report of the progress never stops the run
    }
  };
  let scratch: MigrationScratch | null = null;
  options.hooks?.beforeGate?.();
  try {
    // Only once the gate is this run's: the progress file is one per
    // machine, and a run refused at the gate must not replace the holder's.
    quiesceLegacyWriters(vault, state.run_id, options.settleMs ?? MIGRATION_SETTLE_MS, () =>
      progress("the gate is closed; waiting for writers in flight to settle"),
    );
    held = true;
    progress("the gate is closed; checking the legacy tree again before the backups");
    // Every fact the run decided on before it held the gate is read again:
    // another run may have switched this device, recorded or rolled back a
    // run, or brought a done record in the meantime.
    ({ store, checked } = underGate(vault, store, options, checked));
    dir = migrationDir(store);
    const { plan, later, ownDone, wait } = checked;
    const cohort = plan.devices.cohort.map((d) => d.device);
    // A resumed run that already backed up reports the backup it took.
    let backup: MigrationBackup | null = state.backed_up ? readMigrationBackup(dir) : null;
    // The vault carries its identity marker before any journal mark names
    // it (`journal-scope.ts`): a path is a device's own, and the marker is
    // what a later machine of the same vault, which receives it by sync,
    // matches the marks by. It is read, or written when missing, only once
    // this run holds the gate: a run that has not taken the gate yet (a
    // worker whose claim was taken over, a manual run beside it) writes no
    // marker, so the id this run records is the one on disk. This machine
    // is not switched yet, so the marker is a legacy-layout write (the
    // snapshot below includes it).
    // Minted from what every machine of the vault holds alike, so a store
    // another machine created before this marker existed is the one this
    // marker leads to (`init-store.ts`).
    const vaultId = writeVaultIdentity(vault, { seed: legacyLogSeed(vault) }).vault_id;
    // The run is on record once it holds the gate: a run refused by a
    // gate another run holds leaves no interrupted run behind. A run
    // killed in between leaves a gate no state names; the gate's run id
    // says it is a migration's, which is how the next run on this vault
    // recognises it (`stoppedUnswitchedRun`).
    options.hooks?.atStep?.(MIGRATION_STEP.gateTaken);
    progress("taking the backups");
    save({});
    options.hooks?.atStep?.(MIGRATION_STEP.gateClosed);
    const catalogue = migrationCatalogue(vault);
    if (!state.backed_up) {
      const snapshot = backupStep(() => takeMigrationSnapshot(vault, dir));
      backup = backupStep(() => takeMigrationBackups(vault, catalogue, dir, snapshot));
      save({ backed_up: true });
    }
    options.hooks?.atStep?.(MIGRATION_STEP.backedUp);
    progress("backed up, importing the legacy tree");
    const local = backupStep(() => moveDeviceLocalState(vault, catalogue, dir));
    // Accepted skills are files agents read: they move to the vault's own
    // skills/ folder, never into the store (design D14, task 2.10).
    const skills = backupStep(() => placeVaultFiles(vault, catalogue));
    options.hooks?.afterBackup?.();
    if (!hasCohortRecord(store)) {
      settingsRecord(store, agent, MIGRATION_COHORT_KIND, cohortBody(vaultId, cohort));
    }

    const scope = journalScopeFor(vault, store.device, dir);
    // The maps with an entry per legacy item or store record (the journal,
    // the items a pass saw, the store's checksums) move to a temporary file
    // in the migration folder once they grow, so the run's memory does not
    // grow with the vault (`spill-map.ts`).
    scratch = new MigrationScratch(
      dir,
      options.spillAt !== undefined ? { spillAt: options.spillAt } : {},
    );
    // One pass over the store, shard by shard, for the journal and the
    // dual-written copies: the run never holds the store's records.
    const { journal, unmarked } = loadJournalAndUnmarked(dir, store, scope, scratch);
    const recordReads = new IncrementalReads(new Map(), false);
    // How far the import is: rewritten after every batch it writes.
    counts = { journaled: journaledItems(journal), planned: plannedRecordItems(plan) };
    progress();
    const ctx = {
      vault,
      store,
      vaultId,
      agent,
      dir,
      journal,
      scope,
      pool: dualWritePool(store, journal, scope, unmarked),
      ...(options.hooks ? { hooks: options.hooks } : {}),
      ...(options.importBatchItems !== undefined ? { batchItems: options.importBatchItems } : {}),
      // Recorded, never used to skip: the first import after the switch
      // starts from what this migration's final pass read.
      incremental: recordReads,
      scratch,
      onJournaled: (items: number): void => {
        counts = { journaled: counts!.journaled + items, planned: counts!.planned };
        progress();
      },
    };
    let imported = 0;
    let passes = 0;
    // The legacy-file stamps taken before each pass: those of the final
    // (delta) pass become the automatic import's watermark at the switch.
    let stamps = legacyFileStamps(vault);
    // Each pass reads the whole legacy tree: its garbage goes before the
    // next phase (`gc-hint.ts`).
    gcHint();
    let last = convertPass(ctx);
    for (passes = 1; ; passes++) {
      imported += last.imported;
      progress(`importing: pass ${passes}, ${imported} item(s) imported so far`);
      if (last.imported === 0) break;
      if (passes >= MIGRATION_MAX_PASSES) {
        throw new Error(
          `the legacy tree kept changing after ${passes} passes; stop its writers and resume`,
        );
      }
      stamps = legacyFileStamps(vault);
      gcHint();
      last = convertPass(ctx);
    }
    if (options.refuseUnparseable === true && last.unparseable.length > 0) {
      const listed = last.unparseable
        .slice(0, 10)
        .map((p) => (p.line !== null ? `${p.path}:${p.line}` : p.path))
        .join(", ");
      const reason =
        `${last.unparseable.length} legacy item(s) cannot be parsed (${listed}); a migration ` +
        "would keep them only in its backup archive";
      save({ phase: "failed", reason });
      throw new MigrationRefusedError(`${reason}; this machine was not switched`);
    }
    const archive = archiveUnparseable(vault, dir, last.problems);
    progress(`verifying ${imported} imported item(s)`);
    // A conflict copy that is a second version of a record or a document
    // is never merged: it is kept in the backup and named in the report.
    const syncArchive = backupStep(() => archiveSyncCopies(vault, dir, last.syncCopies.kept));
    options.hooks?.beforeVerify?.();
    // One read of the store for the verification and the switch's check
    // of unseen shards; the settings import reads its own stream later.
    gcHint();
    const final = readFinalStoreView(store, scratch);
    const gaps = verifyImport(ctx, last.seen, final.sums);
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
      // Only the copies the archive holds are named as kept.
      sync_copies: retainedSyncCopies(
        last.syncCopies,
        syncArchive === null ? null : new Set(syncArchive.copies.map((c) => c.path)),
      ),
      sync_copies_archive: syncArchive?.dir ?? null,
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
    // Every item the final pass read is in the store: the first import of
    // late writes after the switch reads only what changed since.
    saveIncrementalReads(dir, vault, recordReads);
    // The switch is the step a later run cannot take back: every held
    // shard reads in full first, or the run fails and this machine stays
    // on the legacy layout.
    const unseen = unseenRefusal(store, final.unseen);
    if (unseen !== null) {
      save({ phase: "failed", reason: unseen });
      throw new MigrationRefusedError(`${unseen}; this machine was not switched`);
    }
    progress("switching this machine to the brain store");
    options.hooks?.atStep?.(MIGRATION_STEP.verified);
    let settings: ReturnType<typeof importBrainSettings>;
    try {
      settings = importBrainSettings(vault, store, agent);
    } catch (error) {
      if (!(error instanceof BrainSettingsUnreadableError)) throw error;
      // As an unreadable held shard before the switch: the run fails and
      // this machine stays on the legacy layout.
      const reason =
        `${error.message}; fix their permissions, let sync finish or repair the shard, then ` +
        "run the migration again";
      save({ phase: "failed", reason });
      throw new MigrationRefusedError(`${reason}; this machine was not switched`);
    }
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
    options.hooks?.atStep?.(MIGRATION_STEP.migrationDone);
    // A rollback that began and did not finish ends here: the operator
    // chose the store again, and a later rollback starts from this run's
    // snapshot. Cleared before the switch, so no switched machine keeps it.
    clearRollbackRecord(dir);
    // A later machine's switch record carries the cut of its own shards,
    // taken now, after everything its migration wrote: a machine that
    // removes the legacy tree waits until those records arrive, not only
    // the switch record (`cohort-in-flight.ts`). So does a first machine's
    // resumed run, whose `migration-done` (kept from before) does not
    // cover what it imported since.
    const switched = settingsRecord(
      store,
      agent,
      DEVICE_SWITCHED_KIND,
      deviceSwitchedBody(
        vaultId,
        store.device,
        later || ownDone !== null ? ownShardCuts(store) : undefined,
      ),
    );
    options.hooks?.atStep?.(MIGRATION_STEP.deviceSwitched);
    // The automatic import's baseline: the tree as the final pass read it,
    // all of it imported (`transition-watermark.ts`).
    recordImportWatermark(store, {
      stamps,
      devices: legacyDevices(store, [...last.devices]),
      converged: true,
      heldBack: 0,
    });
    const viewWriter = finishSwitch(vault, store, agent, !later, options.hooks);
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
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    scratch?.close();
    if (held) releaseGateAfter(vault, state.run_id, failure);
  }
}

/**
 * Record the cut of this device's own shards in one more `device-switched`
 * record, when this device switched as a later machine on a release that
 * wrote no cut (`ownSwitchLacksCut`): until it does, a machine that
 * removes the legacy tree cannot tell whether the records its migration
 * wrote have arrived, and waits. Returns whether it wrote the record.
 */
export function recordOwnSwitchCut(store: StoreHandle, agent: string): boolean {
  if (!ownSwitchLacksCut(store)) return false;
  const vaultId = latestOwnSwitch(store)?.body["vault_id"];
  settingsRecord(
    store,
    agent,
    DEVICE_SWITCHED_KIND,
    deviceSwitchedBody(
      typeof vaultId === "string" ? vaultId : null,
      store.device,
      ownShardCuts(store),
    ),
  );
  return true;
}

export function safeAgent(configPath?: string): string {
  try {
    return resolveAgentName(configPath);
  } catch {
    return "o2b-migrate-store";
  }
}
