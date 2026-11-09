/**
 * The vault binding of a store-only vault (design D14 items 8 and 13,
 * task 2.10).
 *
 * A legacy vault carries its identity marker inside the tree it guards
 * (`Brain/vault-id.json`, `../brain/vault-identity.ts`), and keeps it until
 * the legacy tree is removed (D11a). A store-only vault has no machine
 * file at all, so its identity is kept beside the store's own binding, in
 * the device-local state (never synced): for each store root, the vault's
 * real path and the identity of its root directory (device and inode on
 * POSIX, volume serial and file id on Windows, as `fs.statSync` reports
 * them).
 *
 * `o2b init --vault` binds, and the store migration binds when it
 * switches a machine (it calls {@link bindVaultToStore} with its store).
 * The note tools' write guard (`./index.ts`) compares the vault they were
 * handed against the binding and refuses a vault that is not the bound
 * one:
 *
 *  - the same directory (same identity) is the bound vault, even at
 *    another path (the vault was moved or is mounted elsewhere);
 *  - another directory at the bound path is a vault replaced under the
 *    binding (a restore, a sync tool recreating the folder);
 *  - another directory at another path is another vault.
 *
 * When the identity is unknown on either side (a file system that reports
 * no inode), the real paths decide. A vault never bound passes: binding is
 * what init and the migration add, and an older install has none yet.
 * Running `o2b init --vault <path>` again is the remedy a refusal names.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { readDeviceId } from "../config.ts";
import { atomicWriteFileSync, sleepSync } from "../fs-atomic.ts";
import { processDirsEnv } from "../platform-dirs.ts";
import { withLocalLock } from "../store/local-lock.ts";
import { inspectStore } from "../store/store-open.ts";
import { resolveConfiguredStoreRoot, storesStateDir } from "../store/store-paths.ts";

/** Device-local file holding the vault bindings, beside the store bindings. */
export const VAULT_BINDING_FILE = "vault-binding.json";

/** One binding: the vault a store root is used with on this machine. */
export interface VaultBinding {
  readonly root: string;
  readonly store_id: string;
  readonly device: string;
  /** The vault's real path when it was bound. */
  readonly vault: string;
  /** Device (volume) of the vault's root directory, or null when unknown. */
  readonly dev: string | null;
  /** Inode (file id) of the vault's root directory, or null when unknown. */
  readonly ino: string | null;
  readonly bound_at: string;
}

/** Whether the vault is the bound one. */
export type VaultBindingStatus =
  | { readonly state: "unbound" }
  /** The binding file exists but cannot be read: nothing can be checked. */
  | { readonly state: "unreadable"; readonly path: string }
  | { readonly state: "match"; readonly binding: VaultBinding }
  | {
      readonly state: "mismatch";
      readonly binding: VaultBinding;
      /** What differs, with both paths (for a local reader). */
      readonly detail: string;
      /** What differs, naming no path. */
      readonly reason: string;
    };

/** The refusal code of a note write to a vault that is not the bound one. */
export const VAULT_BINDING_MISMATCH_CODE = "vault_binding_mismatch";

/** Why a vault that is not the bound one is refused, naming no path. */
const OTHER_VAULT_REASON = "the vault is not the vault bound to the brain store";

/**
 * A note write refused because the vault is not the one bound to the
 * store. The message names the vault handed in (the caller's own vault,
 * which every reach redacts) and never the bound one: that is another
 * vault's device path, which no redaction knows. `detail` keeps both for
 * a local reader.
 */
export class VaultBindingMismatchError extends Error {
  readonly code = VAULT_BINDING_MISMATCH_CODE;
  constructor(
    readonly vault: string,
    readonly detail: string,
    reason: string = OTHER_VAULT_REASON,
  ) {
    super(
      `refusing to write: ${reason}. If this is the vault you mean to use, run ` +
        `\`o2b init --vault ${vault}\` to bind it.`,
    );
    this.name = "VaultBindingMismatchError";
  }
}

export interface VaultBindingOptions {
  /** The machine config the store root and the device id come from. */
  readonly configPath?: string;
}

/** The binding file of this machine. */
export function vaultBindingPath(): string {
  return join(storesStateDir(processDirsEnv()), VAULT_BINDING_FILE);
}

interface DirIdentity {
  readonly path: string;
  readonly dev: string | null;
  readonly ino: string | null;
}

function realPathOf(vault: string): string {
  try {
    return realpathSync(vault);
  } catch {
    return resolve(vault);
  }
}

/** The vault's real path and root directory identity. */
function identityOf(vault: string): DirIdentity {
  const path = realPathOf(vault);
  try {
    const stat = statSync(path, { bigint: true });
    if (stat.ino === 0n) return { path, dev: null, ino: null };
    return { path, dev: stat.dev.toString(), ino: stat.ino.toString() };
  } catch {
    return { path, dev: null, ino: null };
  }
}

function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function nullableString(x: unknown): boolean {
  return x === null || typeof x === "string";
}

function isBinding(value: unknown): value is VaultBinding {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["root"] === "string" &&
    typeof v["store_id"] === "string" &&
    typeof v["device"] === "string" &&
    typeof v["vault"] === "string" &&
    nullableString(v["dev"]) &&
    nullableString(v["ino"]) &&
    typeof v["bound_at"] === "string"
  );
}

/**
 * The binding file exists but cannot be read or parsed. It shares the
 * mismatch's wire code on purpose: either way the vault cannot be shown
 * to be the bound one, and `o2b init --vault <path>` is the remedy of
 * both (it rebinds the vault, and moves a damaged file aside); the
 * message tells the two apart.
 */
export class VaultBindingsUnreadableError extends Error {
  readonly code = VAULT_BINDING_MISMATCH_CODE;
  /**
   * `damaged`: the file was read and is not a binding file (the bind
   * moves it aside); `io`: it could not be read at all (a lock, a denied
   * permission), so it is left as it is.
   */
  constructor(
    readonly path: string,
    readonly failure: "damaged" | "io" = "damaged",
  ) {
    super(
      failure === "io"
        ? "refusing to write: this machine's vault binding file cannot be read right now, so " +
            "the vault cannot be checked against the one bound to the brain store. Check the " +
            "file's permissions, or try again once no other program holds it."
        : "refusing to write: this machine's vault binding file cannot be read, so the vault " +
            "cannot be checked against the one bound to the brain store. Run `o2b init --vault " +
            "<path>` to bind the vault again (the unreadable file is kept beside the new one).",
    );
    this.name = "VaultBindingsUnreadableError";
  }
}

/** Attempts and pause of a binding file read that hits an I/O error (a short sharing lock). */
const READ_ATTEMPTS = 3;
const READ_RETRY_MS = 25;

/**
 * The bindings on file. An absent file holds none; a file that exists but
 * cannot be read or parsed is a {@link VaultBindingsUnreadableError}, so a
 * damaged file neither reads as "no vault bound" (the note guard would
 * pass any vault) nor is overwritten with the bindings of other stores
 * lost.
 */
export function readVaultBindings(path: string = vaultBindingPath()): VaultBinding[] {
  let text: string | null = null;
  for (let attempt = 0; attempt < READ_ATTEMPTS && text === null; attempt++) {
    if (attempt > 0) sleepSync(READ_RETRY_MS);
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    }
  }
  if (text === null) throw new VaultBindingsUnreadableError(path, "io");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new VaultBindingsUnreadableError(path);
  }
  const bindings = (parsed as { bindings?: unknown } | null)?.bindings;
  if (!Array.isArray(bindings)) throw new VaultBindingsUnreadableError(path);
  return bindings.filter(isBinding);
}

/**
 * The bindings an explicit bind keeps: the file's, or none once a damaged
 * file is moved aside (`<file>.unreadable-<time>`), so the bind repairs
 * the file and the damaged one is kept for a look. A file that cannot be
 * read at all is not moved (it may be whole, behind a short lock): the
 * refusal is rethrown.
 */
function bindingsToKeep(path: string): VaultBinding[] {
  try {
    return readVaultBindings(path);
  } catch (err) {
    if (!(err instanceof VaultBindingsUnreadableError) || err.failure === "io") throw err;
    renameSync(path, `${path}.unreadable-${Date.now()}`);
    return [];
  }
}

/**
 * Whether two store roots name the same store: the same store id when
 * both stores can be inspected, else the same real path (case folded on
 * Windows). A store recreated at the same root has a new id, so the
 * binding of the old one no longer applies.
 */
function sameStore(binding: VaultBinding, root: string, storeId: string | null): boolean {
  if (storeId !== null) return binding.store_id === storeId;
  return samePath(realPathOf(binding.root), realPathOf(root));
}

function storeIdAt(root: string): string | null {
  try {
    return inspectStore(root)?.storeId ?? null;
  } catch {
    return null;
  }
}

/**
 * The store a binding is for: an explicit one, or the configured store. A
 * store handle (`StoreHandle`, as the migration holds it) also names the
 * device that binds.
 */
export interface VaultBindingStore {
  readonly root: string;
  readonly storeId: string;
  readonly device?: string;
}

/**
 * Bind `vault` to the store on this machine, replacing any earlier binding
 * of that store root. The store is `store` when given, else the configured
 * one. Returns `null`, binding nothing, when there is no store or this
 * machine has no device id: the binding is device-local state, and a
 * machine without a device id keeps none (it cannot write store records
 * either).
 *
 * The store migration's integration point: once it has switched this
 * machine it calls `bindVaultToStore(vault, { store })` with its own
 * store handle, so the vault it migrated is the bound one.
 */
export function bindVaultToStore(
  vault: string,
  options: VaultBindingOptions & { readonly store?: VaultBindingStore } = {},
): VaultBinding | null {
  const device = options.store?.device ?? readDeviceId(options.configPath ?? null);
  if (device === null || device === "") return null;
  let store: VaultBindingStore | null = options.store ?? null;
  if (store === null) {
    const root = resolveConfiguredStoreRoot(options.configPath).root;
    const found = inspectStore(root);
    if (found === null) return null;
    store = { root, storeId: found.storeId };
  }
  const identity = identityOf(vault);
  const binding: VaultBinding = {
    root: store.root,
    store_id: store.storeId,
    device,
    vault: identity.path,
    dev: identity.dev,
    ino: identity.ino,
    bound_at: new Date().toISOString(),
  };
  const path = vaultBindingPath();
  mkdirSync(dirname(path), { recursive: true });
  withLocalLock(path, () => {
    const kept = bindingsToKeep(path).filter((b) => !sameStore(b, store.root, store.storeId));
    const bindings = [...kept, binding];
    atomicWriteFileSync(path, `${JSON.stringify({ bindings }, null, 2)}\n`);
  });
  return binding;
}

/**
 * Drop the binding of the store root `root` on this machine: a rollback
 * took the vault back to the legacy layout, where its identity marker
 * guards it again. A root never bound is a no-op. A file that cannot be
 * read is left as it is: it keeps refusing note writes until an explicit
 * bind repairs it, and the other stores' bindings it may hold are not
 * dropped with it.
 */
export function unbindVaultFromStore(root: string): void {
  const path = vaultBindingPath();
  if (!existsSync(path)) return;
  const storeId = storeIdAt(root);
  withLocalLock(path, () => {
    let known: VaultBinding[];
    try {
      known = readVaultBindings(path);
    } catch (err) {
      if (err instanceof VaultBindingsUnreadableError) return;
      throw err;
    }
    const bindings = known.filter((b) => !sameStore(b, root, storeId));
    if (bindings.length === known.length) return;
    atomicWriteFileSync(path, `${JSON.stringify({ bindings }, null, 2)}\n`);
  });
}

/** Whether `vault` is the vault bound to the configured store on this machine. */
export function vaultBindingStatus(
  vault: string,
  options: VaultBindingOptions = {},
): VaultBindingStatus {
  let root: string;
  try {
    root = resolveConfiguredStoreRoot(options.configPath).root;
  } catch {
    return { state: "unbound" };
  }
  const storeId = storeIdAt(root);
  let bindings: VaultBinding[];
  try {
    bindings = readVaultBindings();
  } catch (err) {
    if (err instanceof VaultBindingsUnreadableError) return { state: "unreadable", path: err.path };
    throw err;
  }
  const binding = bindings.find((b) => sameStore(b, root, storeId));
  if (binding === undefined) return { state: "unbound" };
  const current = identityOf(vault);
  const known = binding.ino !== null && current.ino !== null;
  if (known && binding.dev === current.dev && binding.ino === current.ino) {
    return { state: "match", binding };
  }
  const atBoundPath = samePath(binding.vault, current.path);
  if (!known) {
    return atBoundPath
      ? { state: "match", binding }
      : {
          state: "mismatch",
          binding,
          detail: `the vault ${current.path} is not the vault ${binding.vault} bound to the brain store`,
          reason: OTHER_VAULT_REASON,
        };
  }
  return {
    state: "mismatch",
    binding,
    detail: atBoundPath
      ? `the vault directory at ${current.path} was replaced since it was bound to the brain store`
      : `the vault ${current.path} is not the vault ${binding.vault} bound to the brain store`,
    reason: atBoundPath
      ? "the vault directory was replaced since it was bound to the brain store"
      : OTHER_VAULT_REASON,
  };
}

/** Refuse a note write to a vault that is not the one bound to the store. */
export function assertVaultBindingForWrite(vault: string, options: VaultBindingOptions = {}): void {
  const status = vaultBindingStatus(vault, options);
  if (status.state === "unreadable") throw new VaultBindingsUnreadableError(status.path);
  if (status.state === "mismatch") {
    throw new VaultBindingMismatchError(vault, status.detail, status.reason);
  }
}
