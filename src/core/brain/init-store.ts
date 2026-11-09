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

import {
  isUsableLocalDeviceId,
  readDeviceId,
  resolveAgentName,
  resolveDeviceId,
} from "../config.ts";
import { STORE_PARTITIONS } from "../store/constants.ts";
import { initStore, StoreInitRefusal } from "../store/store-init.ts";
import { bindStoreIdentity } from "../store/store-identity.ts";
import { inspectStore, openStore, StoreOpenError } from "../store/store-open.ts";
import { resolveConfiguredStoreRoot } from "../store/store-paths.ts";
import { claimViewWriter } from "../view/writer.ts";

export interface EnsureBrainStoreOptions {
  /** The machine config the store root and the device id come from. */
  readonly configPath?: string;
}

export interface EnsureBrainStoreResult {
  /** `created`: this call made the store; `existing`: it was there already. */
  readonly status: "created" | "existing";
  readonly root: string;
  readonly storeId: string;
  readonly partitions: ReadonlyArray<string>;
  /** The view writer claim of a created store; `null` for an existing one. */
  readonly viewWriter: { readonly claimed: boolean; readonly message: string } | null;
}

/**
 * Create the configured store unless it exists. Throws what `o2b store
 * init` reports: a store root inside the vault, an unreadable machine
 * config, a store that cannot be read, a filesystem error.
 */
export function ensureBrainStore(options: EnsureBrainStoreOptions = {}): EnsureBrainStoreResult {
  const { root } = resolveConfiguredStoreRoot(options.configPath);
  const existing = inspectStore(root);
  if (existing !== null) return bindExisting(root, existing, options.configPath);
  let created: ReturnType<typeof initStore>;
  try {
    created = initStore({ root });
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
  bindThisDevice(root, created.storeId, options.configPath);
  return {
    status: "created",
    root,
    storeId: created.storeId,
    partitions: created.partitions,
    viewWriter,
  };
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
  };
}

/** Bind the store to this machine's device, when it has a usable one. */
function bindThisDevice(root: string, storeId: string, configPath: string | undefined): void {
  const device = readDeviceId(configPath ?? null);
  if (device !== null && isUsableLocalDeviceId(device)) bindStoreIdentity(root, storeId, device);
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
