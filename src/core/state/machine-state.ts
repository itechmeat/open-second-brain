/**
 * Where this machine's state lives (design D14 items 6, 9 and 13, task
 * 2.10): the one decision every module that keeps machine state asks,
 * switched or not.
 *
 * Machine state is everything this tool keeps for one machine rather than
 * for the brain: the `<vault>/.open-second-brain/` tree (secrets, keys,
 * checkpoints, lockfiles, leases, hook state, ingest manifests), the
 * internal state under `Brain/` (`.state/`, `.artifacts/`, `.payloads/`,
 * `.snapshots/`, graph JSON, watermarks, search tuning and provider
 * registries) and the freeze marker. Each module names its location as a
 * vault-relative path, the same path it used before the store, and this
 * module maps it:
 *
 *  - **Unswitched** (a legacy machine): `<vault>/<path>`, exactly today's
 *    location.
 *  - **Switched** (the machine holds its own `device-switched` record,
 *    `store/store-only.ts`) or **no vault**: `<local>/<path>`, where
 *    `<local>` is `<device state>/migration/local`, the folder the
 *    migration copies every device-local surface into at switch time
 *    (`store-migration/local-state.ts`). `<device state>` is the directory
 *    `o2b store path` reports: the store's own state directory, or the
 *    directory of all stores while no store exists yet.
 *  - **A vault with no `Brain/` tree** (store-only by the same predicate
 *    the writers follow, `isStoreOnly`, so nothing is ever written into
 *    it): `<device state>/fresh/<vault key>/<path>`, one folder per vault,
 *    so two such vaults on one machine never share state. The key is a
 *    digest of the resolved vault path.
 *
 * State follows the machine forward and is never orphaned: once the store
 * exists, a fresh vault's files kept in the folder of all stores move into
 * the store's own, and so does the no-vault `<local>` kept there before;
 * once the machine is switched, a fresh vault's files move into `<local>`.
 * Each move (`state-moves.ts`) publishes a file only when its copy is
 * complete, removes each source file once the destination holds it, and
 * leaves anything it could not move for the next process. Two fresh vaults
 * of one machine share the switched folder once it switches; a file both
 * kept with different bytes is never dropped: the first vault's copy stays
 * live and the other is kept aside under `adopt-conflicts/<vault key>/`.
 * What an older release kept in such a vault's own `.open-second-brain/`
 * is copied once into the relocated root; the vault is only read.
 *
 * Backup-class surfaces (secrets, signing keys, checkpoints, lockfiles,
 * dead letters; D14 item 6) are copied by the migration to its verified
 * backup (`backup/files/<path>`) and, at switch time, to `local/`, their
 * live home. As a fallback, the first time a switched machine resolves its
 * state every backed-up file that has no live copy yet is restored there, once:
 * a marker in the migration folder records it, so a file deleted later is
 * not brought back.
 */

import { createHash } from "node:crypto";
import { cpSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { BRAIN_ROOT_REL, DERIVED_STORE_DIR } from "../brain/path-constants.ts";

import { ensureInsideVault } from "../path-safety.ts";
import { noVaultRoot, processDirsEnv } from "../platform-dirs.ts";
import {
  MIGRATION_BACKUP_DIR,
  MIGRATION_BACKUP_FILES_DIR,
  MIGRATION_LOCAL_DIR,
} from "../store-migration/device-state-layout.ts";
import { MIGRATION_STATE_DIR } from "../store-migration/journal.ts";
import { heldPartitions } from "../store/store-open.ts";
import { storeOnlyMode } from "../store/store-only.ts";
import {
  deviceStateDirFor,
  resolveConfiguredStoreRoot,
  storesStateDir,
} from "../store/store-paths.ts";
import { ADOPT_CONFLICTS_DIR, adoptFolder, filesBelow, seedFolderOnce } from "./state-moves.ts";

/** Folder of the device state holding one folder per fresh (bare) vault. */
const FRESH_STATE_DIR = "fresh";

/** Hex characters of the vault key that names a fresh vault's folder. */
const VAULT_KEY_CHARS = 16;

/** Marker in the migration folder: the backup-class files were restored into `local/`. */
const BACKUP_RESTORED_MARKER = "local-restored.json";

/** Where one machine's state lives. */
export interface MachineStateLocation {
  /** True when the state lives in the device-local state, not in the vault. */
  readonly relocated: boolean;
  /**
   * The directory vault-relative state paths are joined to: the vault, or
   * the device-local `migration/local` folder.
   */
  readonly root: string;
}

/** Store ids by store root; an id never changes for a root once read. */
const STORE_IDS = new Map<string, string>();

function storeIdAt(root: string): string | null {
  const known = STORE_IDS.get(root);
  if (known !== undefined) return known;
  let id: string | null;
  try {
    id = heldPartitions(root).storeId;
  } catch {
    id = null;
  }
  if (id !== null) STORE_IDS.set(root, id);
  return id;
}

/** The id of the configured store, or `null` while none exists. */
function configuredStoreId(configPath?: string): string | null {
  try {
    return storeIdAt(resolveConfiguredStoreRoot(configPath).root);
  } catch {
    return null;
  }
}

/** `<device state>`: the store's own state directory, or that of all stores. */
function deviceStateDir(storeId: string | null): string {
  const source = processDirsEnv();
  return storeId === null ? storesStateDir(source) : deviceStateDirFor(storeId, source);
}

/**
 * The device-local folder that holds this machine's state once it is
 * switched: `<device state>/migration/local`.
 */
export function deviceLocalStateRoot(configPath?: string): string {
  return join(
    deviceStateDir(configuredStoreId(configPath)),
    MIGRATION_STATE_DIR,
    MIGRATION_LOCAL_DIR,
  );
}

/** The key that names a fresh vault's folder: a digest of its resolved path. */
function vaultKey(vault: string): string {
  return createHash("sha256").update(resolve(vault)).digest("hex").slice(0, VAULT_KEY_CHARS);
}

/** `fresh/<vault key>` of `vault`, below a device state directory. */
function freshVaultRel(vault: string): string {
  return join(FRESH_STATE_DIR, vaultKey(vault));
}

/**
 * The device-local folder that holds the state of a vault with no `Brain/`
 * tree on a machine that is not switched: `<device state>/fresh/<key>`.
 */
export function freshVaultStateRoot(vault: string, configPath?: string): string {
  return join(deviceStateDir(configuredStoreId(configPath)), freshVaultRel(vault));
}

/** Source folders whose move this process has already settled. */
const ADOPTED = new Set<string>();

/**
 * Move `from` into `to` once per process (`state-moves.ts` `adoptFolder`):
 * a source that does not exist yet is asked again next time, so a folder
 * another process creates later still moves.
 */
function adoptOnce(from: string, to: string): void {
  if (from === to || ADOPTED.has(from) || !existsSync(from)) return;
  if (adoptFolder(from, to)) ADOPTED.add(from);
}

/** Folder (in the device-local state) of the markers of vaults already seeded. */
const SEEDED_MARKER_DIR = join(DERIVED_STORE_DIR, "seeded-from-vault");

/**
 * The machine state an older release kept in a vault that has no `Brain/`
 * tree (`<vault>/.open-second-brain/`: a bootstrap receipt, secrets, token
 * maps) is copied once into the relocated root, so it is still found once
 * the state lives outside the vault. The vault is only read; a marker in
 * the root records the copy, so a file deleted later is not brought back.
 */
function seedFromVaultOnce(vault: string, root: string): void {
  const marker = join(root, SEEDED_MARKER_DIR, `${vaultKey(vault)}.json`);
  seedFolderOnce(join(vault, DERIVED_STORE_DIR), join(root, DERIVED_STORE_DIR), marker);
}

/** Local roots whose backup restore this process has already settled. */
const RESTORED = new Set<string>();

/**
 * Restore the migration's backup-class copies into `local` once (see the
 * module docblock). Never throws: a restore that fails is retried by the
 * next process, and the writer then starts from an empty surface.
 */
function restoreBackupOnce(local: string): void {
  if (RESTORED.has(local)) return;
  const migration = dirname(local);
  const marker = join(migration, BACKUP_RESTORED_MARKER);
  if (existsSync(marker)) {
    RESTORED.add(local);
    return;
  }
  const files = join(migration, MIGRATION_BACKUP_DIR, MIGRATION_BACKUP_FILES_DIR);
  if (!existsSync(files)) {
    RESTORED.add(local);
    return;
  }
  try {
    const restored: string[] = [];
    for (const file of filesBelow(files)) {
      const rel = relative(files, file);
      const target = join(local, rel);
      if (existsSync(target)) continue;
      cpSync(file, target, { preserveTimestamps: true });
      restored.push(rel.split(sep).join("/"));
    }
    writeFileSync(marker, `${JSON.stringify({ restored }, null, 2)}\n`);
    RESTORED.add(local);
  } catch {
    // Retried by the next process; see above.
  }
}

/**
 * Where the machine state of `vault` lives on this machine. `vault` is
 * the vault the caller works on, or `null` for none.
 */
export function machineStateLocation(
  vault: string | null,
  configPath?: string,
): MachineStateLocation {
  return locate(vault, configPath, true);
}

/**
 * {@link machineStateLocation} without its side effects: no folder is
 * adopted, seeded or restored. For read-only callers (the state
 * inventory, `o2b state status`, the migration plan) that must write
 * nothing.
 */
export function peekMachineStateLocation(
  vault: string | null,
  configPath?: string,
): MachineStateLocation {
  return locate(vault, configPath, false);
}

function locate(
  vault: string | null,
  configPath: string | undefined,
  settle: boolean,
): MachineStateLocation {
  // The no-vault stand-in path (`noVaultRoot`) is no vault.
  const hasVault = vault !== null && vault.trim() !== "" && vault !== noVaultRoot();
  if (hasVault) {
    // One rule with the writers (`isStoreOnly`): a store-only machine
    // keeps no state in the vault, a vault with no `Brain/` included.
    const mode = storeOnlyMode({ vault, ...(configPath !== undefined ? { configPath } : {}) });
    if (!mode.storeOnly) return { relocated: false, root: vault };
    if (mode.reason === "no-legacy-tree") {
      const storeId = configuredStoreId(configPath);
      const root = join(deviceStateDir(storeId), freshVaultRel(vault));
      if (!settle) return { relocated: true, root };
      if (storeId !== null) adoptOnce(join(deviceStateDir(null), freshVaultRel(vault)), root);
      seedFromVaultOnce(vault, root);
      return { relocated: true, root };
    }
  }
  const storeId = configuredStoreId(configPath);
  const root = join(deviceStateDir(storeId), MIGRATION_STATE_DIR, MIGRATION_LOCAL_DIR);
  if (!settle) return { relocated: true, root };
  // State kept in the folder of all stores before this store existed.
  if (storeId !== null) {
    adoptOnce(join(deviceStateDir(null), MIGRATION_STATE_DIR, MIGRATION_LOCAL_DIR), root);
  }
  if (hasVault) {
    // A vault that was fresh before this machine was switched.
    adoptOnce(join(deviceStateDir(null), freshVaultRel(vault)), root);
    if (storeId !== null) adoptOnce(join(deviceStateDir(storeId), freshVaultRel(vault)), root);
    // A switched vault with no legacy tree: the migration copied nothing.
    if (!existsSync(join(vault, BRAIN_ROOT_REL))) seedFromVaultOnce(vault, root);
  }
  restoreBackupOnce(root);
  return { relocated: true, root };
}

/** Whether the machine state of `vault` lives in the device-local state. */
export function isMachineStateRelocated(vault: string | null, configPath?: string): boolean {
  return machineStateLocation(vault, configPath).relocated;
}

/** The directory the vault-relative state paths of `vault` are joined to. */
export function machineStateRoot(vault: string | null, configPath?: string): string {
  return machineStateLocation(vault, configPath).root;
}

/**
 * The location of one piece of machine state, named by its vault-relative
 * path segments. Contained in its root: a segment that climbs out throws
 * `VaultEscapeError`, as the vault builders do. It resolves the root
 * against the default machine config; a caller holding another one (a
 * `--config`, a test's config) resolves the root with
 * `machineStateRoot(vault, configPath)` and joins below it with
 * {@link machineStatePathIn}, so the root and the path come from one
 * config.
 */
export function machineStatePath(vault: string | null, ...segments: string[]): string {
  return machineStatePathIn(machineStateRoot(vault), ...segments);
}

/**
 * {@link machineStatePath} below a root already resolved by
 * {@link machineStateRoot}: for a caller that names several paths of one
 * operation, so they all sit under the same root and the location is
 * resolved once.
 */
export function machineStatePathIn(root: string, ...segments: string[]): string {
  return ensureInsideVault(join(root, ...segments), root);
}

/** Files a switch kept aside in one `adopt-conflicts/` folder, and the live folder they met. */
export interface AdoptConflictFolder {
  /** The `adopt-conflicts/` folder. */
  readonly folder: string;
  /** The live folder whose copies won. */
  readonly live: string;
  /** Files kept aside below `folder`. */
  readonly files: number;
}

/**
 * Every `adopt-conflicts/` folder of this machine that holds files (see
 * {@link adoptOnce}), for the doctor. Read-only.
 */
export function adoptConflictFolders(configPath?: string): AdoptConflictFolder[] {
  const ids = [...new Set([configuredStoreId(configPath), null])];
  const out: AdoptConflictFolder[] = [];
  for (const id of ids) {
    const base = deviceStateDir(id);
    const places = [
      {
        parent: join(base, MIGRATION_STATE_DIR),
        live: join(base, MIGRATION_STATE_DIR, MIGRATION_LOCAL_DIR),
      },
      { parent: join(base, FRESH_STATE_DIR), live: join(base, FRESH_STATE_DIR) },
    ];
    for (const { parent, live } of places) {
      const folder = join(parent, ADOPT_CONFLICTS_DIR);
      if (live !== parent) {
        const files = filesBelow(folder).length;
        if (files > 0) out.push({ folder, live, files });
        continue;
      }
      // A fresh vault's copies are kept per vault key
      // (`adopt-conflicts/<key>/`), each beside the live `fresh/<key>/`
      // whose copy won, so the doctor names the folder to compare with.
      for (const key of subfolders(folder)) {
        const files = filesBelow(join(folder, key)).length;
        if (files > 0) out.push({ folder: join(folder, key), live: join(live, key), files });
      }
    }
  }
  return out;
}

/** The names of the folders directly below `dir`; none when it cannot be listed. */
function subfolders(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .toSorted();
  } catch {
    return [];
  }
}

/** Forget what this process cached. For tests that recreate stores and state dirs. */
export function forgetMachineStateCache(): void {
  STORE_IDS.clear();
  RESTORED.clear();
  ADOPTED.clear();
}
