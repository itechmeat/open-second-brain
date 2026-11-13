/**
 * The one predicate "this machine writes to the store only" (design D14
 * item 1, task 2.10).
 *
 * A machine is store-only when either holds:
 *
 *  - **Switched.** It holds its own `device-switched` record (D14 item 1):
 *    the migration writes one on every machine it switches, the first
 *    machine included (beside its `migration-done`), and `o2b init` writes
 *    one on a fresh install once the store exists (`fresh-switch.ts`). The
 *    record is read by `isDeviceSwitched` (`../store-migration/
 *    migration-records.ts`); a `migration-done` alone does not switch.
 *  - **Fresh install.** There is no legacy tree to keep writing: no vault
 *    is configured, or the vault has no `Brain/` directory. Such a machine
 *    is store-only from its first write.
 *
 * Every other machine is unswitched: the legacy writers keep the legacy
 * tree and dual-write behind the flag exactly as in phase 1.
 *
 * The switch is sticky per machine. The migration records it in a
 * device-local marker beside the stores' state as it switches the device
 * ({@link recordSwitchMarker}), and the first answer that sees a switch
 * record writes it too. From then on the marker alone answers switched:
 * a store that cannot be read (a sync tool rewriting `store.json`) and a
 * `settings` shard that is absent or unreadable while sync delivers it
 * never send the machine back into the legacy tree; its writes fail with
 * the store's reason instead. Only a rollback (`--rollback`, D11) removes
 * the marker, with the switch. Callers that ask whether THIS device
 * switched use {@link deviceSwitchedHere}, which reads the same marker.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { BRAIN_ROOT_REL } from "../brain/path-constants.ts";
import { readDeviceId, resolveVault } from "../config.ts";
import { atomicWriteFileSync } from "../fs-atomic.ts";
import {
  DEVICE_SWITCHED_KIND as MIGRATION_DEVICE_SWITCHED_KIND,
  isDeviceSwitched,
} from "../store-migration/migration-records.ts";
import { processDirsEnv } from "../platform-dirs.ts";
import { withLocalLock } from "./local-lock.ts";
import { inspectStore, type StoreHandle, type StoreInspection } from "./store-open.ts";
import { resolveConfiguredStoreRoot, storesStateDir } from "./store-paths.ts";

/** Kind of the record that switches the device that wrote it (D11, D14 item 1). */
export const DEVICE_SWITCHED_KIND = MIGRATION_DEVICE_SWITCHED_KIND;

/** Device-local file listing the (store root, device) pairs seen switched. */
const SWITCH_MARKER_FILE = "store-only.json";

/** Whether `deviceId` holds its own switch record in `store`. */
export type DeviceSwitchedReader = (store: StoreInspection, deviceId: string) => boolean;

/** Where the store-only answer comes from. */
export interface StoreOnlyContext {
  /**
   * The vault the caller works on: a path, `null` for none, or absent to
   * resolve the configured one.
   */
  readonly vault?: string | null;
  /** The machine config the vault, the device id and the store root come from. */
  readonly configPath?: string;
}

export interface StoreOnlyOptions {
  /** A read-only preview must not persist a newly observed switch. */
  readonly persistSwitch?: boolean;
  /**
   * The switch-record reader (default: {@link readSwitchRecords}); no
   * production caller sets it. It stays for the read-facade parity tests,
   * which read ONE dual-written vault both as an unswitched and as a
   * switched machine: a real switch record is sticky (the device-local
   * marker), so the same vault could not be read the legacy way again.
   */
  readonly readSwitched?: DeviceSwitchedReader;
}

/** Why the machine is, or is not, store-only. */
export type StoreOnlyReason = "device-switched" | "no-legacy-tree" | "legacy";

export interface StoreOnlyMode {
  readonly storeOnly: boolean;
  readonly reason: StoreOnlyReason;
  /** The vault the answer was given for (`null`: none configured). */
  readonly vault: string | null;
}

/**
 * The default reader: this device's own `device-switched` record in the
 * `settings` stream of `shared`, as the migration reads it.
 */
export const readSwitchRecords: DeviceSwitchedReader = (store, deviceId) =>
  isDeviceSwitched(store, deviceId);

/**
 * Whether `vault` holds a `Brain/` folder: an unswitched machine with one
 * writes the legacy tree. Whether that folder holds anything to migrate is
 * `legacy-tree.ts`; a bootstrap-only folder becomes store-only through the
 * fresh-install switch (`fresh-switch.ts`).
 */
export function hasLegacyTree(vault: string | null): boolean {
  if (vault === null || vault.trim() === "") return false;
  return existsSync(join(vault, BRAIN_ROOT_REL));
}

function markerPath(): string {
  return join(storesStateDir(processDirsEnv()), SWITCH_MARKER_FILE);
}

function markerKey(root: string, device: string): string {
  return `${root}\u0000${device}`;
}

function readMarker(): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(markerPath(), "utf8")) as { switched?: unknown };
    if (!Array.isArray(parsed.switched)) return new Set();
    return new Set(
      parsed.switched
        .filter(
          (e): e is { root: string; device: string } =>
            typeof e === "object" &&
            e !== null &&
            typeof (e as { root?: unknown }).root === "string" &&
            typeof (e as { device?: unknown }).device === "string",
        )
        .map((e) => markerKey(e.root, e.device)),
    );
  } catch {
    return new Set();
  }
}

/**
 * Change the marker under its device-local lock, so two processes never
 * lose each other's entries. Never throws: the marker only makes a switch
 * survive an unreadable store, and the switch record in the store stays
 * the source of truth.
 */
function updateMarker(change: (known: Set<string>) => boolean, strict = false): void {
  try {
    mkdirSync(dirname(markerPath()), { recursive: true });
    withLocalLock(markerPath(), () => {
      const known = readMarker();
      if (!change(known)) return;
      const switched = [...known].map((key) => {
        const [r, d] = key.split("\u0000") as [string, string];
        return { root: r, device: d };
      });
      atomicWriteFileSync(markerPath(), `${JSON.stringify({ switched }, null, 2)}\n`);
    });
  } catch (err) {
    // see above; a strict update (a clear) reports its failure
    if (strict) throw err;
  }
}

/** Switches seen in this process, so a switched machine reads its store once. */
const seenSwitched = new Set<string>();

function writeMarker(root: string, device: string, strict = false): void {
  const key = markerKey(root, device);
  updateMarker((known) => {
    if (known.has(key)) return false;
    known.add(key);
    return true;
  }, strict);
}

/**
 * Record on this machine that `device` switched to the store at `root`
 * (the sticky marker). The migration calls it as it switches the device;
 * it throws when the marker cannot be written, so a run that cannot make
 * its switch durable is finished by the next `migrate-store`.
 */
export function recordSwitchMarker(root: string, device: string): void {
  writeMarker(root, device, true);
  seenSwitched.add(markerKey(root, device));
}

/**
 * Whether `device` switched on this machine: the sticky marker names it,
 * or the store holds its own standing `device-switched` record. The
 * migration, the rollback, the status block and the doctor ask this, so
 * an absent or unreadable `settings` shard never reads as unswitched
 * where the marker says otherwise.
 */
export function deviceSwitchedHere(
  store: Pick<StoreHandle, "root" | "partitions">,
  device: string,
): boolean {
  return readMarker().has(markerKey(store.root, device)) || isDeviceSwitched(store, device);
}

function vaultOf(context: StoreOnlyContext): string | null {
  if (context.vault !== undefined) return context.vault;
  try {
    return resolveVault(context.configPath);
  } catch {
    return null;
  }
}

/** This machine's (configured store root, device), or null when either cannot be resolved. */
function configuredSwitchKey(configPath?: string): { root: string; device: string } | null {
  try {
    const device = readDeviceId(configPath ?? null);
    const root = resolveConfiguredStoreRoot(configPath).root;
    return device === null ? null : { root, device };
  } catch {
    return null;
  }
}

/** Whether the sticky marker (or this process) names `key` switched. */
function markedKey(key: string): boolean {
  if (seenSwitched.has(key)) return true;
  if (!readMarker().has(key)) return false;
  seenSwitched.add(key);
  return true;
}

/**
 * Whether the sticky marker says this machine's device switched to the
 * configured store, without opening the store. A protection reader asks
 * this when the store cannot be opened: on such a machine that is a
 * failure to fail closed on, never "no store, no rules"
 * (`read/protection-store.ts`).
 */
export function markedSwitched(context: Pick<StoreOnlyContext, "configPath"> = {}): boolean {
  const at = configuredSwitchKey(context.configPath);
  return at !== null && markedKey(markerKey(at.root, at.device));
}

function isSwitched(context: StoreOnlyContext, options: StoreOnlyOptions): boolean {
  const at = configuredSwitchKey(context.configPath);
  if (at === null) return false;
  const { root, device } = at;
  const key = markerKey(root, device);
  // The marker first: once this machine recorded its switch, nothing the
  // synced store shows right now (no partition, an unreadable store, an
  // absent or unreadable `settings` shard) takes it back to the legacy
  // tree. Only a rollback clears it.
  if (markedKey(key)) return true;
  let store: StoreInspection | null;
  try {
    store = inspectStore(root);
  } catch {
    return false;
  }
  if (store === null) return false;
  let switched: boolean;
  try {
    switched = (options.readSwitched ?? readSwitchRecords)(store, device);
  } catch {
    switched = false;
  }
  if (switched && options.persistSwitch !== false) {
    seenSwitched.add(key);
    writeMarker(root, device);
  }
  return switched;
}

/** Whether, and why, this machine writes to the store only. */
export function storeOnlyMode(
  context: StoreOnlyContext = {},
  options: StoreOnlyOptions = {},
): StoreOnlyMode {
  const vault = vaultOf(context);
  if (isSwitched(context, options)) return { storeOnly: true, reason: "device-switched", vault };
  if (!hasLegacyTree(vault)) return { storeOnly: true, reason: "no-legacy-tree", vault };
  return { storeOnly: false, reason: "legacy", vault };
}

/** Whether this machine writes to the store only; see the module docblock. */
export function isStoreOnly(
  context: StoreOnlyContext = {},
  options: StoreOnlyOptions = {},
): boolean {
  return storeOnlyMode(context, options).storeOnly;
}

/**
 * Drop `(root, device)` from the sticky marker and from this process's
 * memory of switches: a rollback took the device back to the legacy
 * layout (design D11 "Rollback"), so an unreadable store must no longer
 * answer store-only for it. Unlike a write of the marker, a clear that
 * fails throws (a lock that stays busy, a failed write): a rollback must
 * not report success while the marker still names the device.
 */
export function clearSwitchMarker(root: string, device: string): void {
  const key = markerKey(root, device);
  seenSwitched.delete(key);
  updateMarker((known) => known.delete(key), true);
}
