/**
 * The store identity check, the write guard of store writes (design D14
 * item 13, task 2.10).
 *
 * The vault identity guard (`../brain/vault-identity.ts`) refuses a write
 * when the vault at a root is no longer the one the process opened. A
 * store write needs the same protection without a vault: the store at the
 * configured root, and the device writing it, must be the ones this
 * machine is bound to.
 *
 * The binding lives in the device-local state (never synced): for each
 * store root, the store id and the device id. The first store write on a
 * machine binds them. A later write refuses when
 *
 *  - the store at the root has another store id (it was deleted and made
 *    again, or a sync tool put another store's partitions there), or
 *  - the binding names another device (the device-local directory was
 *    copied from another machine, or the device id changed).
 *
 * Within one process the store id is also pinned at the first write, as
 * the vault guard pins the vault id, so a store swapped under a running
 * process is refused even before the binding is read.
 *
 * `o2b init` binds the machine again ({@link bindStoreIdentity}): that is
 * the remedy a refusal names, for a store replaced or a device id changed
 * on purpose.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { processDirsEnv } from "../platform-dirs.ts";
import { withLocalLock } from "./local-lock.ts";
import { storesStateDir } from "./store-paths.ts";

/** Device-local file holding the store bindings. */
export const STORE_IDENTITY_FILE = "identity.json";

/** One binding: the store and the device a store root is bound to. */
export interface StoreBinding {
  readonly root: string;
  readonly store_id: string;
  readonly device: string;
  readonly bound_at: string;
}

/** A store write refused by the identity check. */
export class StoreIdentityMismatchError extends Error {
  constructor(
    readonly root: string,
    detail: string,
  ) {
    super(`refusing to write: ${detail}`);
    this.name = "StoreIdentityMismatchError";
  }
}

/** The binding file of this machine. */
export function storeIdentityPath(): string {
  return join(storesStateDir(processDirsEnv()), STORE_IDENTITY_FILE);
}

function isBinding(value: unknown): value is StoreBinding {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["root"] === "string" &&
    typeof v["store_id"] === "string" &&
    typeof v["device"] === "string" &&
    typeof v["bound_at"] === "string"
  );
}

/** The bindings on file; an absent or unreadable file holds none. */
export function readStoreBindings(path: string = storeIdentityPath()): StoreBinding[] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { bindings?: unknown };
    return Array.isArray(parsed.bindings) ? parsed.bindings.filter(isBinding) : [];
  } catch {
    return [];
  }
}

/**
 * The bindings on file, telling an absent file (no bindings yet) from one
 * that cannot be read or parsed (`null`): a corrupt file is no licence to
 * bind whatever store is there now.
 */
function readBindingsStrict(path: string): StoreBinding[] | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? [] : null;
  }
  try {
    const parsed = JSON.parse(text) as { bindings?: unknown };
    return Array.isArray(parsed.bindings) ? parsed.bindings.filter(isBinding) : null;
  } catch {
    return null;
  }
}

function unreadableBindings(root: string, path: string): StoreIdentityMismatchError {
  return new StoreIdentityMismatchError(
    root,
    `this machine's store binding file ${path} cannot be read, so the store at ${root} ` +
      "cannot be checked; repair or remove it, or run `o2b init` to bind this machine again",
  );
}

/**
 * Write the binding of `root`, keeping every other root's. Under the
 * lock; a binding file that cannot be read is replaced only by `o2b init`
 * (`repair`), never by a write that would drop the other roots' bindings.
 */
function writeBinding(root: string, storeId: string, device: string, repair = false): void {
  const path = storeIdentityPath();
  mkdirSync(dirname(path), { recursive: true });
  withLocalLock(path, () => writeBindingLocked(path, root, storeId, device, repair));
}

function writeBindingLocked(
  path: string,
  root: string,
  storeId: string,
  device: string,
  repair: boolean,
): void {
  const current = readBindingsStrict(path);
  if (current === null && !repair) throw unreadableBindings(root, path);
  const others = (current ?? []).filter((b) => b.root !== root);
  const bindings = [
    ...others,
    { root, store_id: storeId, device, bound_at: new Date().toISOString() },
  ];
  atomicWriteFileSync(path, `${JSON.stringify({ bindings }, null, 2)}\n`);
}

/** Store ids pinned by this process, per root. */
const pinned = new Map<string, string>();

/** (root, store id, device) triples this process has checked against the binding. */
const verified = new Set<string>();

function verifiedKey(root: string, storeId: string, device: string): string {
  return `${root}\u0000${storeId}\u0000${device}`;
}

/**
 * Bind `root` to `storeId` and `device` on this machine, replacing any
 * earlier binding of the root. Run by `o2b init`.
 */
export function bindStoreIdentity(root: string, storeId: string, device: string): void {
  writeBinding(root, storeId, device, true);
  pinned.set(root, storeId);
  verified.clear();
}

/**
 * Refuse a store write to the store `storeId` at `root` by `device` when
 * this machine is bound to another store or another device. See the
 * module docblock. The first write binds.
 */
export function assertStoreIdentityForWrite(root: string, storeId: string, device: string): void {
  const pin = pinned.get(root);
  if (pin !== undefined && pin !== storeId) {
    throw new StoreIdentityMismatchError(
      root,
      `the store at ${root} is not the one this process opened (store id ${storeId}, ` +
        `opened ${pin})`,
    );
  }
  const key = verifiedKey(root, storeId, device);
  if (verified.has(key)) return;
  const path = storeIdentityPath();
  const bindings = readBindingsStrict(path);
  if (bindings === null) throw unreadableBindings(root, path);
  let binding = bindings.find((b) => b.root === root);
  if (binding === undefined) {
    try {
      // The check and the first bind are one step: of two processes
      // binding the same root at once, the second sees the first's.
      mkdirSync(dirname(path), { recursive: true });
      binding = withLocalLock(path, () => {
        const again = readBindingsStrict(path);
        if (again === null) throw unreadableBindings(root, path);
        const found = again.find((b) => b.root === root);
        if (found !== undefined) return found;
        writeBindingLocked(path, root, storeId, device, false);
        return undefined;
      });
    } catch (err) {
      if (err instanceof StoreIdentityMismatchError) throw err;
      // The binding is the guard's memory; failing to keep it must not
      // fail the write it would have allowed. The process pin still holds.
    }
  }
  // `undefined`: bound just now (or the binding could not be kept), so
  // there is nothing to compare and the process pin below holds.
  if (binding !== undefined) {
    if (binding.store_id !== storeId) {
      throw new StoreIdentityMismatchError(
        root,
        `the store at ${root} has store id ${storeId}, and this machine is bound to ` +
          `${binding.store_id}`,
      );
    }
    if (binding.device !== device) {
      throw new StoreIdentityMismatchError(
        root,
        `this machine writes as device ${device}, and its device-local state is bound to ` +
          `device ${binding.device} (copied from another machine, or the device id changed)`,
      );
    }
  }
  pinned.set(root, storeId);
  verified.add(key);
}
