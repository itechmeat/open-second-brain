/**
 * The store step of `o2b init` and `o2b brain init` on a machine with no
 * vault (design D14 item 1, task 2.10): the brain lives in the store, so
 * initialising it means creating the store, as `o2b store init` does.
 *
 * An existing store is left exactly as it is (its partitions included: a
 * machine that holds only `shared` keeps holding only `shared`). A store
 * this step creates holds every partition, and the machine that creates
 * it takes the view writer role, as `o2b store init` does (design D7).
 *
 * Either way the machine is bound to the store (`../store/store-identity.ts`,
 * design D14 item 13): init is the explicit step that accepts a store
 * replaced, or a device id changed, on purpose.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  isUsableLocalDeviceId,
  readDeviceId,
  resolveAgentName,
  resolveDeviceId,
  resolveVault,
} from "../config.ts";
import { ulidFromSeed } from "../store/ulid.ts";
import { BRAIN_ROOT_REL } from "./path-constants.ts";
import { readVaultIdentity, writeVaultIdentity } from "./vault-identity.ts";
import { legacyLogSeed } from "./vault-seed.ts";
import { STORE_PARTITIONS } from "../store/constants.ts";
import { initStore, StoreInitRefusal } from "../store/store-init.ts";
import { bindStoreIdentity } from "../store/store-identity.ts";
import { inspectStore, openStore, StoreOpenError } from "../store/store-open.ts";
import { resolveConfiguredStoreRoot } from "../store/store-paths.ts";
import { claimViewWriter } from "../view/writer.ts";
import { isStoreOnly } from "../store/store-only.ts";
import { claimDreamOwnerOnCreate } from "./dream-owner/create.ts";

export interface EnsureBrainStoreOptions {
  /** The machine config the store root and the device id come from. */
  readonly configPath?: string;
  /**
   * Set by the commands that create a brain (`o2b init`, `o2b brain
   * init`): a store this call creates for `vault` claims the dream owner
   * role for this device and the configured agent (change
   * `agent-neutral-dream`, design D5). Never set by the store migration:
   * moving an existing brain to the store binds no owner. A vault that
   * still holds a legacy `Brain/` tree is an existing brain too.
   */
  readonly dreamOwnerFor?: { readonly vault: string | null };
}

export interface EnsureBrainStoreResult {
  /** `created`: this call made the store; `existing`: it was there already. */
  readonly status: "created" | "existing";
  readonly root: string;
  readonly storeId: string;
  readonly partitions: ReadonlyArray<string>;
  /** The view writer claim of a created store; `null` for an existing one. */
  readonly viewWriter: { readonly claimed: boolean; readonly message: string } | null;
  /**
   * The dream owner claim of a store created for a new brain; `null` for an
   * existing store, or when the caller did not create a brain.
   */
  readonly dreamOwner: { readonly claimed: boolean; readonly message: string } | null;
}

/**
 * Create the configured store unless it exists. Throws what `o2b store
 * init` reports: a store root inside the vault, an unreadable machine
 * config, a store that cannot be read, a filesystem error.
 */
export function ensureBrainStore(options: EnsureBrainStoreOptions = {}): EnsureBrainStoreResult {
  // One reading of the vault for the root and the id it seeds.
  const vault = resolveVault(options.configPath);
  const resolved = resolveConfiguredStoreRoot(options.configPath, vault);
  const { root } = resolved;
  const existing = inspectStore(root);
  if (existing !== null) return bindExisting(root, existing, options.configPath);
  let created: ReturnType<typeof initStore>;
  try {
    const storeId = resolved.placement === "vault" ? vaultStoreId(vault) : null;
    created = initStore({ root, ...(storeId !== null ? { storeId } : {}) });
  } catch (err) {
    // Another process created the store between the inspection and the
    // create: bind to that store, as a second init would.
    const raced =
      err instanceof StoreInitRefusal && err.reason === "exists" ? inspectStore(root) : null;
    if (raced === null) throw err;
    return bindExisting(root, raced, options.configPath);
  }
  // The claim resolves (and on a first init mints) the device id, so it
  // runs before the binding: otherwise the store this call made would be
  // bound to no device until a later init.
  const viewWriter = claimOnCreate(root, options.configPath);
  const dreamOwner =
    options.dreamOwnerFor !== undefined &&
    isNewBrain(options.dreamOwnerFor.vault, options.configPath)
      ? claimDreamOwnerOnCreate(root, options.configPath)
      : null;
  bindThisDevice(root, created.storeId, options.configPath);
  return {
    status: "created",
    root,
    storeId: created.storeId,
    partitions: created.partitions,
    viewWriter,
    dreamOwner,
  };
}

/**
 * The id of a store created in the vault's reserved folder, the same on
 * every machine that creates it before it has seen another's, so they
 * create one store. It derives from the vault id: the identity marker
 * (`Brain/vault-id.json`), a datum every machine of the vault shares
 * however far its sync of the log has come.
 *
 * A vault with a legacy tree and no marker yet has its marker minted here,
 * before the store, from the oldest legacy log line (`vault-seed.ts`; a
 * random id when the log has none), and the store id derives from the
 * marker as written. So the marker and the store agree for good: the seed
 * is read once, and a log shard that arrives afterwards and would seed
 * another id changes neither (every later marker writer finds this marker
 * and keeps it). A process that read the seed at the same time and minted
 * another id gets the marker published first, not its own
 * (`writeVaultIdentity` publishes exclusively), so its store id derives
 * from the marker that stands. A marker that another machine minted and
 * that arrived first is used as it is. Null (a fresh id) for a vault with no legacy
 * tree, which has no marker to agree on.
 */
function vaultStoreId(vault: string | null): string | null {
  if (vault === null || vault === "") return null;
  const marked = readVaultIdentity(vault)?.vault_id;
  if (marked !== undefined) return ulidFromSeed(marked);
  if (!existsSync(join(vault, BRAIN_ROOT_REL))) return null;
  return ulidFromSeed(writeVaultIdentity(vault, { seed: legacyLogSeed(vault) }).vault_id);
}

function bindExisting(
  root: string,
  existing: NonNullable<ReturnType<typeof inspectStore>>,
  configPath: string | undefined,
): EnsureBrainStoreResult {
  bindThisDevice(root, existing.storeId, configPath);
  return {
    status: "existing",
    root,
    storeId: existing.storeId,
    partitions: STORE_PARTITIONS.filter((p) => existing.partitions.has(p)),
    viewWriter: null,
    dreamOwner: null,
  };
}

/** Bind the store to this machine's device, when it has a usable one. */
function bindThisDevice(root: string, storeId: string, configPath: string | undefined): void {
  const device = readDeviceId(configPath ?? null);
  if (device !== null && isUsableLocalDeviceId(device)) bindStoreIdentity(root, storeId, device);
}

/** A brain with no legacy `Brain/` tree: there is nothing before this store to adopt. */
function isNewBrain(vault: string | null, configPath: string | undefined): boolean {
  return (
    vault === null || isStoreOnly({ vault, ...(configPath !== undefined ? { configPath } : {}) })
  );
}

function claimOnCreate(
  root: string,
  configPath: string | undefined,
): { claimed: boolean; message: string } {
  try {
    const device = resolveDeviceId(configPath);
    const claim = claimViewWriter(openStore({ root, device }), {
      agent: resolveAgentName(configPath),
    });
    return claim.claimed
      ? { claimed: true, message: `This machine (${device}) renders the human view.` }
      : { claimed: false, message: `The human view is rendered by ${claim.writer}.` };
  } catch (err) {
    if (!(err instanceof StoreOpenError)) throw err;
    return {
      claimed: false,
      message:
        "This machine has no device id, so it did not take the view writer role; set device_id " +
        "and run `o2b view writer --here` on the machine that should render the human view.",
    };
  }
}
