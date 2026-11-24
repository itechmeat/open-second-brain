/**
 * Several machines of one user that share ONLY their vault folder (patch
 * 2.0.1): no store root is configured anywhere, so each machine resolves
 * the default root itself, and the only transport between machines is
 * {@link VaultFleet.syncVault}, a plain copy of the vault's files (the
 * store's reserved hidden folder included, unless the transport drops
 * hidden folders, as Obsidian Sync does). The store is never synced
 * separately.
 *
 * Each machine has its own home, data, state and config directories and
 * its own device id. The legacy vault every machine starts from carries a
 * vault identity marker, as every vault `o2b init` of a 1.x release made.
 * Everything lives under one temp parent; {@link VaultFleet.cleanup}
 * restores the environment and removes it.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import { resetFreezeMarkerCache } from "../../../../src/core/brain/freeze-marker.ts";
import {
  resetVaultIdentityPins,
  writeVaultIdentity,
} from "../../../../src/core/brain/vault-identity.ts";
import { forgetMachineStateCache } from "../../../../src/core/state/machine-state.ts";
import { STORE_ROOT_ENV, STORE_VAULT_DIR } from "../../../../src/core/store/constants.ts";
import type { StoreRecord } from "../../../../src/core/store/envelope.ts";
import { readPartition } from "../../../../src/core/store/state-digest.ts";
import {
  defaultStoreRoot,
  resolveConfiguredStoreRoot,
} from "../../../../src/core/store/store-paths.ts";
import { makeLegacyVault, UNMAPPED_LEGACY_ENTRIES as UNMAPPED } from "./legacy-vault.ts";
import { dropUnparseable } from "./migration-env.ts";

const ENV_KEYS = [
  STORE_ROOT_ENV,
  "O2B_DEVICE_ID",
  "HOME",
  "USERPROFILE",
  "XDG_STATE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "LOCALAPPDATA",
  "APPDATA",
  "OPEN_SECOND_BRAIN_CONFIG",
  "OPEN_SECOND_BRAIN_AUTO_STORE_MIGRATION",
  "VAULT_DIR",
] as const;

export interface VaultMachine {
  readonly name: string;
  readonly home: string;
  readonly vault: string;
  /** The vault's reserved store folder on this machine. */
  readonly vaultStore: string;
  /** The 2.0.0 default store root (outside the vault) on this machine. */
  readonly externalStore: string;
  /** This machine's device-local state root. */
  readonly stateHome: string;
  /** Point the process environment at this machine. */
  use(): void;
  /** The store root this machine resolves now (it must be `use`d). */
  root(): string;
  /** Every record of the store at the root this machine resolves (it must be `use`d). */
  records(): StoreRecord[];
}

export interface SyncOptions {
  /** A transport that never carries folders whose name starts with a dot. */
  readonly dropHidden?: boolean;
  /** Vault-relative paths (`/`-separated) this transport has not delivered yet. */
  readonly skip?: (rel: string) => boolean;
}

export interface VaultFleet {
  readonly parent: string;
  machine(name: string): VaultMachine;
  /**
   * Copy `from`'s vault into `to`'s, as a file-sync tool would: a file the
   * target lacks, or holds older, is copied; a file that only `to` writes
   * (its own store shards and legacy log shards) is never overwritten. The
   * legacy device-local `.open-second-brain/` folder never travels.
   */
  syncVault(from: string, to: string, options?: SyncOptions): number;
  cleanup(): void;
}

function filesBelow(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesBelow(path) : [path];
  });
}

/** Whether `rel` (vault-relative) is a file only device `device` writes. */
function ownedBy(rel: string, device: string): boolean {
  const segments = rel.split("/");
  if (segments[0] === STORE_VAULT_DIR) {
    return segments.length > 3 && segments[segments.length - 2] === device;
  }
  const name = segments[segments.length - 1]!;
  return segments[0] === "Brain" && name.endsWith(`.${device}.jsonl`);
}

export interface VaultFleetOptions {
  /**
   * Whether the legacy vault carries its identity marker (default true). A
   * 1.x vault where only `o2b init` ran has none; the migration writes it.
   */
  readonly identityMarker?: boolean;
}

export function makeVaultFleet(
  names: ReadonlyArray<string>,
  fleetOptions: VaultFleetOptions = {},
): VaultFleet {
  const saved = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  const base = makeLegacyVault("osb-vault-fleet-");
  for (const rel of UNMAPPED) rmSync(join(base.vault, ...rel.split("/")), { force: true });
  dropUnparseable(base.vault);
  // A 1.x vault carries its identity marker when `o2b brain init` ran.
  if (fleetOptions.identityMarker !== false) writeVaultIdentity(base.vault);
  const parent = base.parent;
  const machines = new Map<string, VaultMachine>();

  for (const name of names) {
    const home = join(parent, name);
    const vault = join(home, "vault");
    mkdirSync(home, { recursive: true });
    cpSync(base.vault, vault, { recursive: true, preserveTimestamps: true });
    const configPath = join(home, "config", "open-second-brain", "config.yaml");
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, `vault: ${vault}\ndevice_id: ${name}\n`);
    const env: Record<string, string> = {
      O2B_DEVICE_ID: name,
      HOME: join(home, "home"),
      USERPROFILE: join(home, "home"),
      XDG_STATE_HOME: join(home, "state"),
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"),
      XDG_CACHE_HOME: join(home, "cache"),
      LOCALAPPDATA: join(home, "state"),
      APPDATA: join(home, "data"),
      OPEN_SECOND_BRAIN_CONFIG: configPath,
      OPEN_SECOND_BRAIN_AUTO_STORE_MIGRATION: "true",
    };
    const machine: VaultMachine = {
      name,
      home,
      vault,
      vaultStore: join(vault, STORE_VAULT_DIR),
      externalStore: defaultStoreRoot({
        platform: process.platform,
        home: env["HOME"]!,
        env,
      }),
      stateHome: join(home, "state"),
      use: () => {
        delete process.env[STORE_ROOT_ENV];
        delete process.env["VAULT_DIR"];
        Object.assign(process.env, env);
        resetFreezeMarkerCache();
        resetVaultIdentityPins();
        forgetMachineStateCache();
      },
      root: () => resolveConfiguredStoreRoot(configPath).root,
      records: () => {
        const root = resolveConfiguredStoreRoot(configPath).root;
        return (["shared", "private"] as const).flatMap((p) =>
          readPartition(join(root, p)).flatMap((shard) => shard.all),
        );
      },
    };
    machines.set(name, machine);
  }

  return {
    parent,
    machine: (name) => machines.get(name)!,
    syncVault: (from, to, options = {}) => {
      const source = machines.get(from)!.vault;
      const target = machines.get(to)!.vault;
      let copied = 0;
      for (const file of filesBelow(source)) {
        const rel = relative(source, file).split(sep).join("/");
        const segments = rel.split("/");
        if (segments[0] === ".open-second-brain") continue;
        if (options.dropHidden === true && segments.some((s) => s.startsWith("."))) continue;
        if (options.skip?.(rel) === true) continue;
        if (ownedBy(rel, to)) continue;
        const dest = join(target, ...segments);
        const src = statSync(file);
        if (existsSync(dest)) {
          const have = statSync(dest);
          if (have.mtimeMs >= src.mtimeMs && readFileSync(dest).equals(readFileSync(file))) {
            continue;
          }
          if (have.mtimeMs > src.mtimeMs) continue;
        }
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(file, dest);
        utimesSync(dest, src.atime, src.mtime);
        copied += 1;
      }
      return copied;
    },
    cleanup: () => {
      for (const key of ENV_KEYS) {
        const value = saved.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      resetFreezeMarkerCache();
      resetVaultIdentityPins();
      forgetMachineStateCache();
      base.cleanup();
    },
  };
}
