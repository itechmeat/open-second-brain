/**
 * Whether this machine has a migration into the brain store to run (design
 * D11, D14.1, task 2.12): the vault still holds the legacy `Brain/` tree,
 * and the store holds no `device-switched` record written by this device.
 * A machine is store-only once it holds its own such record, so a record
 * of another device, or a `device-switched` kind no release has written
 * yet, leaves the answer at "available".
 *
 * One function answers for both the `store` status block
 * (`store-status.ts`) and the doctor (`brain/doctor/migration-check.ts`),
 * so the two never disagree. It also names the commands to run next: with
 * no store yet, `o2b store init` first, then the dry run.
 *
 * Read-only and cheap: one directory probe of the vault, the store
 * identity files, and this device's own `settings` shards of the `shared`
 * partition. It never creates the store, a lock or a clock. A store or
 * config problem is carried as {@link MigrationAvailability.error} and
 * never thrown; the migration then stays offered, because a switch that
 * cannot be read cannot be relied on.
 */

import { statSync } from "node:fs";
import { join } from "node:path";

import { BRAIN_ROOT_REL } from "../brain/path-constants.ts";
import { readDeviceId } from "../config.ts";
import {
  DEVICE_SWITCHED_KIND,
  DEVICE_UNSWITCHED_KIND,
} from "../store-migration/migration-records.ts";
import { vaultBindingStatus } from "../vault-adapter/vault-binding.ts";
import { holdsLegacyData } from "./legacy-tree.ts";
import { deviceSwitchedHere } from "./store-only.ts";
import { withoutSeenRecording } from "./seen-shards.ts";
import { inspectStore } from "./store-open.ts";
import {
  isPathInsideResolved,
  resolveConfiguredStoreRoot,
  StoreRootInsideVaultError,
} from "./store-paths.ts";

/** The switch records (D11, D11a, task 2.6), from the one reader the writers use. */
export { DEVICE_SWITCHED_KIND, DEVICE_UNSWITCHED_KIND };

/** The command that creates the store on the first machine. */
export const STORE_INIT_COMMAND = "o2b store init";

/** The command that imports a vault's legacy data on a machine that already switched. */
export const MIGRATE_STORE_COMMAND = "o2b brain migrate-store";

/** The command that previews the migration without writing anything. */
export const MIGRATE_STORE_DRY_RUN_COMMAND = "o2b brain migrate-store --dry-run";

export interface MigrationAvailability {
  /** The legacy tree holds something to move and this device has not switched. */
  readonly available: boolean;
  readonly legacyTreePresent: boolean;
  /**
   * The legacy tree holds something to move: a file other than the ones a
   * fresh bootstrap writes (its settings, manual, identity marker and
   * Bases views). Without it no migration is offered, by the status
   * block and the doctor alike.
   */
  readonly legacyDataPresent: boolean;
  /** A store exists at the configured root; `null` when the root cannot be read. */
  readonly storeExists: boolean | null;
  /** The store holds this device's own `device-switched` record. */
  readonly switched: boolean;
  /** Commands to run, in order; empty when nothing is available. */
  readonly nextCommands: ReadonlyArray<string>;
  /** Why the store or the device id could not be read, or `null`. */
  readonly error: string | null;
}

export interface MigrationAvailabilitySource {
  /** The vault whose legacy tree is looked at; `null` when there is none. */
  readonly vault: string | null;
  readonly configPath?: string | undefined;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function bindingOptions(configPath: string | undefined): { configPath?: string } {
  return configPath !== undefined ? { configPath } : {};
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The store side: whether a store exists and this device switched in it. */
function storeSide(source: MigrationAvailabilitySource): {
  storeExists: boolean | null;
  switched: boolean;
  error: string | null;
} {
  try {
    const { root, origin } = resolveConfiguredStoreRoot(source.configPath);
    // The vault looked at may not be the configured one; a root inside it is just as wrong.
    if (source.vault !== null && isPathInsideResolved(root, source.vault, process.platform)) {
      throw new StoreRootInsideVaultError(root, source.vault, origin);
    }
    const store = inspectStore(root);
    if (store === null) return { storeExists: false, switched: false, error: null };
    const device = readDeviceId(source.configPath);
    // The reader the store-only write path uses, so the status block and
    // the doctor never disagree with the writers.
    const switched = device !== null && deviceSwitchedHere(store, device);
    return { storeExists: true, switched, error: null };
  } catch (err) {
    return { storeExists: null, switched: false, error: messageOf(err) };
  }
}

/** Whether a migration is available on this machine; see the module header. */
export function migrationAvailability(source: MigrationAvailabilitySource): MigrationAvailability {
  const brainRoot = source.vault === null ? null : join(source.vault, BRAIN_ROOT_REL);
  const legacyTreePresent = brainRoot !== null && isDirectory(brainRoot);
  // Read-only: no shard is recorded as seen (`seen-shards.ts`).
  const store = withoutSeenRecording(() => storeSide(source));
  const { storeExists, switched } = store;
  const legacyDataPresent = brainRoot !== null && legacyTreePresent && holdsLegacyData(brainRoot);
  // A switch covers the vault it was made with, which the migration (or a
  // transition import) binds to the store. A vault configured later on a
  // switched machine (after a vault-free switch, or another vault) with
  // legacy data of its own is not covered: its migration is offered, and
  // `migrate-store` imports it through the transition path.
  const binding =
    switched && source.vault !== null
      ? vaultBindingStatus(source.vault, bindingOptions(source.configPath))
      : null;
  const covered = binding?.state === "match";
  // A damaged binding file says nothing about the vault: it is the
  // problem to report (`o2b init --vault` repairs it), not a migration to
  // offer again.
  const bindingError =
    binding?.state === "unreadable"
      ? `the vault binding file ${binding.path} cannot be read; run \`o2b init --vault\` to repair it`
      : null;
  const error = store.error ?? bindingError;
  // A freshly bootstrapped tree holds nothing to move: no migration to offer.
  const available = legacyDataPresent && !covered;
  let nextCommands: string[] = [];
  if (bindingError !== null) nextCommands = [];
  else if (available && switched) nextCommands = [MIGRATE_STORE_COMMAND];
  else if (available && storeExists === false) {
    nextCommands = [STORE_INIT_COMMAND, MIGRATE_STORE_DRY_RUN_COMMAND];
  } else if (available) nextCommands = [MIGRATE_STORE_DRY_RUN_COMMAND];
  return {
    available,
    legacyTreePresent,
    legacyDataPresent,
    storeExists,
    switched,
    nextCommands,
    error,
  };
}
