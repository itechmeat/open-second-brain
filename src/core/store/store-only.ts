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
 * A machine that is not switched and cannot examine `<vault>/Brain` (the
 * vault cannot be traversed, an I/O error) cannot tell which it is: a
 * failed look is not an absent folder. {@link storeOnlyAnswer} says so
 * (`undetermined`), and {@link storeOnlyMode} and {@link isStoreOnly}
 * throw {@link StoreOnlyUndeterminedError}, so no writer lands in the store
 * on a guess and no reader answers "nothing here" from an empty store.
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

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { BRAIN_ROOT_REL } from "../brain/path-constants.ts";
import { readDeviceId, resolveVault } from "../config.ts";
import { atomicWriteFileSync } from "../fs-atomic.ts";
import {
  DEVICE_SWITCHED_KIND as MIGRATION_DEVICE_SWITCHED_KIND,
  isDeviceSwitched,
} from "../store-migration/migration-records.ts";
import { processDirsEnv } from "../platform-dirs.ts";
import { lookAtDirectory, VaultUnexaminableError } from "../vault-unexaminable.ts";
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

/** The answer when this machine cannot tell whether it is store-only. */
export interface StoreOnlyUndetermined {
  readonly reason: "undetermined";
  readonly vault: string;
  /** The error the look at `<vault>/Brain` failed with. */
  readonly cause: Error;
}

/**
 * This machine is not switched and cannot tell whether `vault` holds a
 * legacy tree: `<vault>/Brain` could not be examined. Thrown by
 * {@link storeOnlyMode} and {@link isStoreOnly}; a caller that branches on
 * the mode fails with it instead of reading or writing either layout.
 */
export class StoreOnlyUndeterminedError extends VaultUnexaminableError {
  constructor(vault: string, cause: Error) {
    const code = (cause as NodeJS.ErrnoException).code;
    super(
      vault,
      cause,
      `cannot tell whether ${vault} holds a ${BRAIN_ROOT_REL}/ tree: ${join(vault, BRAIN_ROOT_REL)} ` +
        `cannot be examined (${code ?? cause.message}); nothing is read from or written to ` +
        "the store or the vault until the vault can be read (check its permissions)",
    );
    this.name = "StoreOnlyUndeterminedError";
  }
}

/** Whether `<vault>/Brain` exists, is absent, or cannot be examined. */
type LegacyTreeLook = "present" | "absent" | { readonly failed: Error };

function lookAtLegacyTree(vault: string | null): LegacyTreeLook {
  if (vault === null || vault.trim() === "") return "absent";
  // A missing vault or folder, or a name no file can have: no tree. A look
  // that fails otherwise (EACCES, EPERM, ELOOP, EIO, ENOTDIR through a
  // file), a Brain/ that is no directory, or one this process cannot list
  // and traverse (mode 000) says nothing (`lookAtDirectory`).
  return lookAtDirectory(join(vault, BRAIN_ROOT_REL));
}

/**
 * Whether `vault` holds a `Brain/` folder: an unswitched machine with one
 * writes the legacy tree. Whether that folder holds anything to migrate is
 * `legacy-tree.ts`; a bootstrap-only folder becomes store-only through the
 * fresh-install switch (`fresh-switch.ts`). Throws
 * {@link StoreOnlyUndeterminedError} when the folder cannot be examined.
 */
export function hasLegacyTree(vault: string | null): boolean {
  const look = lookAtLegacyTree(vault);
  if (typeof look === "object") throw new StoreOnlyUndeterminedError(vault ?? "", look.failed);
  return look === "present";
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

/**
 * Whether, and why, this machine writes to the store only, or that it
 * cannot tell (`undetermined`): for a caller that reports the answer (a
 * status or doctor line) rather than branching on it.
 */
export function storeOnlyAnswer(
  context: StoreOnlyContext = {},
  options: StoreOnlyOptions = {},
): StoreOnlyMode | StoreOnlyUndetermined {
  const vault = vaultOf(context);
  if (isSwitched(context, options)) return { storeOnly: true, reason: "device-switched", vault };
  const look = lookAtLegacyTree(vault);
  if (typeof look === "object")
    return { reason: "undetermined", vault: vault!, cause: look.failed };
  if (look === "absent") return { storeOnly: true, reason: "no-legacy-tree", vault };
  return { storeOnly: false, reason: "legacy", vault };
}

/**
 * The refusal for a vault a switched machine cannot reach, or `null` when
 * the vault is there to read or the machine has not switched.
 *
 * On a switched machine the brain lives in the store, and the vault is
 * only the human view and the user's notes (design D14 items 2 and 8): a
 * vault folder that cannot be examined (its permissions, an I/O error) or
 * is gone (an unmounted disk) leaves the store readers and writers working
 * as on a machine with no vault, and only what needs the vault refuses,
 * with this error. A machine that has not switched answers `null` here and
 * keeps its refusal of every read and write ({@link storeOnlyMode}).
 *
 * A machine that has not switched and whose vault is gone is store-only
 * too (`no-legacy-tree`): it reads its brain from the store, its READ
 * answers keep their own checks, and a WRITE into the vault refuses
 * where it writes - a note write never creates the folder that is missing
 * (`../vault-unexaminable.ts`).
 */
export function switchedVaultUnreachable(
  vault: string,
  context: Pick<StoreOnlyContext, "configPath"> = {},
): VaultUnexaminableError | null {
  const look = lookAtDirectory(vault);
  if (look === "present") return null;
  // A look, never a write: every surface asks this before it does
  // anything, a dry run and a hook included, so it never records a newly
  // observed switch (the writers and readers that follow do).
  if (!isSwitched({ vault, ...context }, { persistSwitch: false })) return null;
  if (look === "absent") {
    const gone = Object.assign(new Error(`ENOENT: no such directory, '${vault}'`), {
      code: "ENOENT",
    });
    return new VaultUnexaminableError(
      vault,
      gone,
      `the vault ${vault} is not there (ENOENT); this machine's brain is in the store, so ` +
        "the brain tools keep working, and a tool that needs the vault answers once the folder " +
        "is back (mount or restore it, or point the machine config at the vault)",
    );
  }
  return new VaultUnexaminableError(
    vault,
    look.failed,
    `the vault ${vault} cannot be examined (${
      (look.failed as NodeJS.ErrnoException).code ?? look.failed.message
    }); this machine's brain is in the store, so the brain tools keep working, and a tool ` +
      "that needs the vault answers once it can be read (make it and every parent directory " +
      "traversable, chmod u+rx)",
  );
}

/** A switched machine's vault that cannot be reached, and why. */
export interface UnreachableVault {
  /** The configured vault. */
  readonly vault: string;
  /** The refusal a step that needs the vault answers with. */
  readonly error: VaultUnexaminableError;
  /** The short reason: the vault and what the look at it failed with. */
  readonly reason: string;
}

/** The vault a caller works on, after the reachability decision. */
export interface ServedVault {
  /** The vault to work on; `null` serves the brain from the store, as with no vault. */
  readonly vault: string | null;
  /** Set when a switched machine's vault cannot be reached. */
  readonly unreachable: UnreachableVault | null;
}

/**
 * The one decision every surface (MCP, the command line, the hooks)
 * takes about a configured vault: on a switched machine whose vault
 * folder is gone or cannot be examined the brain is served from the
 * store, as on a machine with no vault, and a step that needs vault files
 * refuses with {@link UnreachableVault.error}. Every other vault is served
 * as it is ({@link switchedVaultUnreachable}).
 */
export function servedVault(
  vault: string | null,
  context: Pick<StoreOnlyContext, "configPath"> = {},
): ServedVault {
  if (vault === null || vault.trim() === "") return { vault, unreachable: null };
  const error = switchedVaultUnreachable(vault, context);
  if (error === null) return { vault, unreachable: null };
  const code = error.code ?? (error.cause as Error | undefined)?.message;
  const reason =
    code === "ENOENT"
      ? `the vault ${vault} is not there (ENOENT)`
      : `the vault ${vault} cannot be examined (${code})`;
  return { vault: null, unreachable: { vault, error, reason } };
}

/**
 * The notice a machine that has NOT switched gives when the vault its
 * machine config names is gone: the folder may sit on a disk that is not
 * mounted, and initialising a new brain beside it hides the real one.
 */
export interface ConfiguredVaultMissing {
  /** The configured vault, whose folder is not there. */
  readonly vault: string;
  /** The notice, in words: what is missing and what to do about it. */
  readonly notice: string;
}

/**
 * The notice for a configured vault whose folder is not there, or `null`
 * when there is nothing to report.
 *
 * It answers only on a machine that has NOT switched: a switched machine's
 * brain is in the store, and its vault is only the human view, so
 * {@link servedVault} already answers that case (and its folder being gone
 * is not a fault there). A machine with no vault configured never reaches
 * it - there is no folder to be missing - and a machine whose vault folder
 * is there never reaches it either.
 *
 * A failed look is not an absence: a vault this process cannot examine
 * (mode 000, an I/O error) is answered by {@link switchedVaultUnreachable}
 * on a switched machine and refused by the readers otherwise. Only a
 * folder that is simply not there is this notice.
 */
export function configuredVaultMissing(
  vault: string | null,
  context: Pick<StoreOnlyContext, "configPath"> = {},
): ConfiguredVaultMissing | null {
  if (vault === null || vault.trim() === "") return null;
  if (lookAtDirectory(vault) !== "absent") return null;
  // A look, never a write, as in `switchedVaultUnreachable`.
  if (isSwitched({ vault, ...context }, { persistSwitch: false })) return null;
  return {
    vault,
    notice:
      `the configured vault folder ${vault} is missing; it may be on a disk that is not ` +
      "mounted: mount it, or point the machine config at the vault, before initialising " +
      "a new brain.",
  };
}

/**
 * Whether, and why, this machine writes to the store only. Throws
 * {@link StoreOnlyUndeterminedError} when it cannot tell.
 */
export function storeOnlyMode(
  context: StoreOnlyContext = {},
  options: StoreOnlyOptions = {},
): StoreOnlyMode {
  const answer = storeOnlyAnswer(context, options);
  if (answer.reason === "undetermined") {
    throw new StoreOnlyUndeterminedError(answer.vault, answer.cause);
  }
  return answer;
}

/** Whether this machine writes to the store only; see the module docblock. Throws when it cannot tell. */
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
