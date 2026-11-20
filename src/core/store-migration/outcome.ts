/**
 * The one entry point of `o2b brain migrate-store` without `--dry-run`:
 * it picks what this machine has to do (tasks 2.3 and 2.4).
 *
 *  - `transition`: this device already switched. It imports the late
 *    writes machines still on an old release left in the legacy tree, and
 *    names those machines (`transition.ts`). A vault configured after the
 *    switch also brings its operator settings, and is bound to the store
 *    once nothing of it was left behind. A rollback that began and did not
 *    clear the switch ends here, as the migration ends one.
 *  - `first` / `later`: the migration (`migrate.ts`); a later machine
 *    first waits for the first machine's cut.
 *  - `waiting`: a later machine whose store does not hold that cut yet.
 *    Nothing was written; the report names what it waits for.
 *
 * {@link removeLegacy} and {@link rollback} are the `--remove-legacy` and
 * `--rollback` forms (tasks 2.5 and 2.6).
 */

import { readMigrationGateState } from "../migration-gate.ts";
import { deviceSwitchedHere } from "../store/store-only.ts";
import { legacyPermissionsConflict } from "../brain/doctor/permissions-check.ts";
import { storedPermissionsText } from "../brain/permissions/document-source.ts";
import { readVaultIdentity } from "../brain/vault-identity.ts";
import { bindVaultToStore, vaultBindingStatus } from "../vault-adapter/vault-binding.ts";
import { importBrainSettings, type BrainSettingsImport } from "./brain-settings.ts";
import { clearRollbackRecord, migrationDir, unseenHeldShards } from "./journal.ts";
import { writeDeviceSettings, type DeviceConfigWrite } from "./device-config.ts";
import { ROLLBACK_RUN_PREFIX } from "./gate-state.ts";
import type { CutWait } from "./later.ts";
import {
  finishInterruptedSwitch,
  MigrationSwitchedError,
  MigrationWaitingError,
  openMigrationStore,
  runMigration,
  safeAgent,
  type MigrationOptions,
  type MigrationResult,
} from "./migrate.ts";
import { removeLegacyTree, type RemovalResult } from "./removal.ts";

export { MigrationSwitchedError } from "./migrate.ts";
import { rollbackMigration, type RollbackHooks, type RollbackResult } from "./rollback.ts";
import { importLateLegacyWrites, type TransitionResult } from "./transition.ts";
import { cohortStatus, type DeviceEvidenceDate } from "./cohort-status.ts";
import { legacyDeviceEvidence } from "./device-evidence.ts";

/**
 * What the transition did with a vault configured after this machine
 * switched (not the bound one): its operator settings, and whether its
 * deny rules conflict with the stored permissions document.
 */
export interface TransitionSettings {
  /** `_brain.yaml` and `_permissions.yaml` imported (null for the bound vault). */
  readonly settings: BrainSettingsImport | null;
  readonly device_config: DeviceConfigWrite | null;
  /**
   * The vault's `_permissions.yaml` holds deny rules the stored document
   * does not: the store's document stays, and the vault is not bound.
   */
  readonly permissions_conflict: boolean;
  /** Whether the vault is the one bound to the store after this run. */
  readonly bound: boolean;
  /**
   * The cohort as `cohort-status.ts` judges it, the one judgement the
   * doctor, the status block and the removal report: `legacy_devices`
   * holds only the PENDING devices (the transition's own list minus the
   * devices retired by silence), with their last evidence here, beside
   * the devices that switched and those retired by silence.
   */
  readonly pending_evidence: ReadonlyArray<DeviceEvidenceDate>;
  readonly switched: ReadonlyArray<string>;
  /** Cohort devices retired by hand (a human `device-retire` record). */
  readonly retired: ReadonlyArray<string>;
  readonly retired_by_silence: ReadonlyArray<DeviceEvidenceDate>;
  readonly silence_threshold_days: number;
  readonly as_of: string | null;
  /**
   * Held store shards whose records this machine could not all see
   * (`<partition>/<rel>`): a record of the vault's items may be in one,
   * so the vault is not bound while any is listed.
   */
  readonly unseen_shards: ReadonlyArray<string>;
}

export type MigrateStoreOutcome =
  | ({ readonly mode: "migration" } & MigrationResult)
  | ({
      readonly mode: "transition";
      readonly ok: boolean;
      readonly device: string;
    } & TransitionResult &
      TransitionSettings)
  | {
      readonly mode: "waiting";
      readonly ok: false;
      readonly device: string;
      readonly wait: CutWait;
    };

export function migrateStore(vault: string, options: MigrationOptions = {}): MigrateStoreOutcome {
  const store = openMigrationStore(vault, options.configPath);
  if (deviceSwitchedHere(store, store.device)) {
    // The transition below is the operator's: the automatic worker that
    // finds the device switched under it (another vault's migration ran
    // first) does nothing here. A switched machine's own leftovers are the
    // worker's switched branch, and new legacy records of machines still on
    // the legacy layout are the automatic transition import's.
    if (options.automatic === true) throw new MigrationSwitchedError(store.device);
    const agent = options.agent ?? safeAgent(options.configPath);
    // A run killed after its switch record still has to bind the vault it
    // migrated, claim the view writer and open the gate. Another vault
    // configured since is not bound by it: it takes the checks below.
    finishInterruptedSwitch(vault, store, agent);
    const bindingOptions =
      options.configPath !== undefined ? { configPath: options.configPath } : {};
    const alreadyBound = vaultBindingStatus(vault, bindingOptions).state === "match";
    // A vault configured after this machine switched brings its operator
    // settings, as a migration does (design D14 item 3): `_brain.yaml` and
    // `_permissions.yaml` at human authority (the operator runs this
    // command), never over a value the store already holds. The settings
    // go in first, so a deny rule is in force before any record of the
    // vault is. The bound vault's settings were imported by its migration;
    // its files went stale at the switch and are not read again.
    let settings: BrainSettingsImport | null = null;
    let deviceConfig: DeviceConfigWrite | null = null;
    let permissionsConflict = false;
    if (!alreadyBound) {
      settings = importBrainSettings(vault, store, agent);
      deviceConfig = writeDeviceSettings(settings.device, options.configPath);
      // Deny rules the stored document does not hold: two operator
      // policies are not merged by guesswork; the vault stays unbound
      // (its migration offered) and doctor names the file
      // (`permissions-legacy-only`) until the operator reconciles them.
      permissionsConflict = legacyPermissionsConflict(
        vault,
        storedPermissionsText(options.configPath),
      );
    }
    const vaultId = readVaultIdentity(vault)?.vault_id ?? null;
    // The import records the automatic import's watermark at its final
    // pass, so that import starts from a point whose content is in the
    // store (`transition-watermark.ts`).
    const result = importLateLegacyWrites(vault, store, agent, vaultId, {
      recordWatermark: true,
      ...(options.hooks !== undefined ? { hooks: options.hooks } : {}),
      ...(options.spillAt !== undefined ? { spillAt: options.spillAt } : {}),
    });
    // Everything of the vault is in the store only when the import settled
    // and held nothing back for a partition this machine lacks, as the
    // migration's verification demands. Only then does a vault configured
    // after the switch become the bound one (its migration no longer
    // offered); a held-back item keeps it offered, and the next run
    // imports the item once the partition is here.
    // The journal may count an item as imported whose record sits in a
    // shard this machine cannot see: the binding waits until every held
    // shard reads in full, as the removal and the rollback do.
    const unseen = unseenHeldShards(store);
    const unseenShards = [...unseen.unreadable, ...unseen.partial].toSorted();
    const complete = result.converged && result.held_back === 0 && unseenShards.length === 0;
    let bound = alreadyBound;
    if (!alreadyBound && complete && !permissionsConflict) {
      bindVaultToStore(vault, { store });
      bound = true;
    }
    // A rollback that began here and did not clear the switch ends here,
    // as it does in a migration (`runMigration`): the operator chose the
    // store again. Without this its record would refuse every automatic
    // step and name only `--rollback`, which undoes this choice. Only this
    // operator's command does it; the automatic worker refused above. A
    // rollback that holds the gate, or may (a gate that cannot be read),
    // is left alone: this command does not open its gate, and only its
    // own command finishes it.
    if (!rollbackMayHoldGate()) clearRollbackRecord(migrationDir(store));
    // The devices still on the legacy layout, judged as every other surface
    // judges them: a device retired by silence is not pending.
    const cohort = cohortStatus(store, {
      legacy: result.legacy_devices,
      legacyEvidence: legacyDeviceEvidence(vault),
      now: new Date(),
    });
    return {
      mode: "transition",
      ok: complete && !permissionsConflict,
      device: store.device,
      ...result,
      legacy_devices: cohort.pending.map((d) => d.device),
      pending_evidence: cohort.pending,
      switched: cohort.switched,
      retired: cohort.retired,
      retired_by_silence: cohort.retired_by_silence,
      silence_threshold_days: cohort.threshold_days,
      as_of: cohort.as_of,
      settings,
      device_config: deviceConfig,
      permissions_conflict: permissionsConflict,
      bound,
      unseen_shards: unseenShards,
    };
  }
  try {
    return { mode: "migration", ...runMigration(vault, options) };
  } catch (error) {
    if (error instanceof MigrationWaitingError) {
      return { mode: "waiting", ok: false, device: store.device, wait: error.wait };
    }
    throw error;
  }
}

/** Whether a rollback holds this machine's migration gate, or may: a gate that cannot be read. */
function rollbackMayHoldGate(): boolean {
  const gate = readMigrationGateState();
  if (gate.kind === "unreadable") return true;
  return gate.kind === "held" && gate.gate.run_id.startsWith(ROLLBACK_RUN_PREFIX);
}

/** `--remove-legacy [--force]`: move the legacy tree out of the vault when the cohort allows. */
export function removeLegacy(
  vault: string,
  options: {
    readonly configPath?: string;
    readonly agent?: string;
    readonly force?: boolean;
    /** This machine's wall clock (the silence rule's cap and the archive's date). */
    readonly now?: Date;
  } = {},
): RemovalResult {
  const store = openMigrationStore(vault, options.configPath);
  const agent = options.agent ?? safeAgent(options.configPath);
  return removeLegacyTree(vault, store, {
    agent,
    ...(options.force ? { force: true } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
}

/** `--rollback`: take this machine back to the legacy layout. */
export function rollback(
  vault: string,
  options: {
    readonly configPath?: string;
    readonly agent?: string;
    readonly hooks?: RollbackHooks;
    /** Entries a per-item map holds in memory before it moves to disk (`MigrationOptions.spillAt`). */
    readonly spillAt?: number;
  } = {},
): RollbackResult {
  const store = openMigrationStore(vault, options.configPath);
  const agent = options.agent ?? safeAgent(options.configPath);
  return rollbackMigration(vault, store, {
    agent,
    ...(options.hooks ? { hooks: options.hooks } : {}),
    ...(options.spillAt !== undefined ? { spillAt: options.spillAt } : {}),
  });
}
