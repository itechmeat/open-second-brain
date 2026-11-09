/**
 * Several machines of one user for the later-machine migration tests: each
 * machine has its own copy of the legacy vault (a synced vault, which may
 * hold files another copy has not received yet), its own copy of the
 * store root, its own device-local state and its own device id. Sync is
 * explicit: {@link Fleet.syncStore} copies one machine's store files to
 * another, {@link Fleet.syncVaultFile} one legacy file. Everything lives
 * under one temp parent; {@link Fleet.cleanup} restores the environment.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import { resetFreezeMarkerCache } from "../../../../src/core/brain/freeze-marker.ts";
import { resetVaultIdentityPins } from "../../../../src/core/brain/vault-identity.ts";
import { forgetMachineStateCache } from "../../../../src/core/state/machine-state.ts";
import { STORE_ROOT_ENV } from "../../../../src/core/store/constants.ts";
import type { StoreRecord } from "../../../../src/core/store/envelope.ts";
import { readPartition } from "../../../../src/core/store/state-digest.ts";
import { initStore } from "../../../../src/core/store/store-init.ts";
import { openStore, type StoreHandle } from "../../../../src/core/store/store-open.ts";
import { migratedMark } from "../../../../src/core/store-migration/migration-records.ts";
import { makeLegacyVault, UNMAPPED_LEGACY_ENTRIES as UNMAPPED } from "./legacy-vault.ts";

const ENV_KEYS = [
  STORE_ROOT_ENV,
  "O2B_DEVICE_ID",
  "HOME",
  "XDG_STATE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "LOCALAPPDATA",
  "APPDATA",
  "OPEN_SECOND_BRAIN_CONFIG",
] as const;

export interface Machine {
  readonly name: string;
  readonly vault: string;
  readonly storeRoot: string;
  /** Point the process environment at this machine. */
  use(): void;
  store(): StoreHandle;
  /** Every record this machine's store copy holds. */
  records(): StoreRecord[];
  /** Imported records grouped by their legacy item key. */
  byKey(): Map<string, StoreRecord[]>;
  /** Write a legacy file into this machine's vault copy. */
  write(rel: string, text: string): void;
}

export interface Fleet {
  readonly parent: string;
  machine(name: string): Machine;
  /** Copy `from`'s store files to `to`, never overwriting `to`'s own shards. */
  syncStore(from: string, to: string, filter?: (rel: string) => boolean): void;
  /** Copy one legacy file from one machine's vault to another's. */
  syncVaultFile(from: string, to: string, rel: string): void;
  cleanup(): void;
}

function filesBelow(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesBelow(path) : [path];
  });
}

export function makeFleet(names: ReadonlyArray<string>): Fleet {
  const saved = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  const base = makeLegacyVault("osb-fleet-");
  for (const rel of UNMAPPED) rmSync(join(base.vault, ...rel.split("/")), { force: true });
  const parent = base.parent;
  const machines = new Map<string, Machine>();

  for (const name of names) {
    const home = join(parent, name);
    const vault = join(home, "vault");
    const storeRoot = join(home, "store");
    mkdirSync(home, { recursive: true });
    cpSync(base.vault, vault, { recursive: true, preserveTimestamps: true });
    const configPath = join(home, "config.yaml");
    writeFileSync(configPath, `vault: ${vault}\n`);
    const env: Record<string, string> = {
      [STORE_ROOT_ENV]: storeRoot,
      O2B_DEVICE_ID: name,
      HOME: join(home, "home"),
      XDG_STATE_HOME: join(home, "state"),
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"),
      LOCALAPPDATA: join(home, "state"),
      APPDATA: join(home, "data"),
      OPEN_SECOND_BRAIN_CONFIG: configPath,
    };
    const records = (): StoreRecord[] =>
      (["shared", "private"] as const).flatMap((p) =>
        readPartition(join(storeRoot, p)).flatMap((shard) => shard.all),
      );
    machines.set(name, {
      name,
      vault,
      storeRoot,
      use: () => {
        Object.assign(process.env, env);
        resetFreezeMarkerCache();
        resetVaultIdentityPins();
        // Its keys are per-machine paths today; flipping machines in one
        // process must not depend on that.
        forgetMachineStateCache();
      },
      store: () => openStore({ root: storeRoot, device: name }),
      records,
      byKey: () => {
        const out = new Map<string, StoreRecord[]>();
        for (const record of records()) {
          const mark = migratedMark(record);
          if (mark !== null) out.set(mark.key, [...(out.get(mark.key) ?? []), record]);
        }
        return out;
      },
      write: (rel, text) => {
        const path = join(vault, ...rel.split("/"));
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text);
      },
    });
  }

  const fleet: Fleet = {
    parent,
    machine: (name) => machines.get(name)!,
    syncStore: (from, to, filter = () => true) => {
      const source = machines.get(from)!.storeRoot;
      const target = machines.get(to)!.storeRoot;
      for (const file of filesBelow(source)) {
        const rel = relative(source, file).split(sep).join("/");
        const segments = rel.split("/");
        // A device's own shards are only ever written on that device.
        if (segments.includes(to) && segments.length > 2) continue;
        if (!filter(rel)) continue;
        const dest = join(target, ...segments);
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(file, dest);
      }
    },
    syncVaultFile: (from, to, rel) => {
      const source = join(machines.get(from)!.vault, ...rel.split("/"));
      const dest = join(machines.get(to)!.vault, ...rel.split("/"));
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(source, dest);
    },
    cleanup: () => {
      for (const key of ENV_KEYS) {
        const value = saved.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      resetFreezeMarkerCache();
      resetVaultIdentityPins();
      base.cleanup();
    },
  };

  // The store is created once, on the first machine, and reaches the others by sync.
  initStore({ root: machines.get(names[0]!)!.storeRoot });
  for (const name of names.slice(1)) fleet.syncStore(names[0]!, name);
  return fleet;
}
