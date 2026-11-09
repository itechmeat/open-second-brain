/**
 * A migration test bench: the legacy fixture vault with nothing unmapped,
 * a created store, and a sandboxed HOME, state, data, config and device id, all
 * under the fixture's one temp parent. {@link MigrationBench.cleanup}
 * restores the environment and removes the parent.
 */
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { resetFreezeMarkerCache } from "../../../../src/core/brain/freeze-marker.ts";
import { resetVaultIdentityPins } from "../../../../src/core/brain/vault-identity.ts";
import { STORE_ROOT_ENV } from "../../../../src/core/store/constants.ts";
import type { StoreRecord } from "../../../../src/core/store/envelope.ts";
import { readPartition } from "../../../../src/core/store/state-digest.ts";
import { initStore } from "../../../../src/core/store/store-init.ts";
import { openStore, type StoreHandle } from "../../../../src/core/store/store-open.ts";
import { migratedMark } from "../../../../src/core/store-migration/migration-records.ts";
import {
  makeLegacyVault,
  UNMAPPED_LEGACY_ENTRIES as UNMAPPED,
  type LegacyVaultFixture,
} from "./legacy-vault.ts";

export const BENCH_DEVICE = "dev-a";

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

export type PartitionedRecord = StoreRecord & { partition: "shared" | "private" };

export interface MigrationBench {
  readonly fx: LegacyVaultFixture;
  readonly vault: string;
  readonly storeRoot: string;
  readonly env: Readonly<Record<string, string>>;
  store(): StoreHandle;
  /** Every record this device holds, by partition. */
  records(): PartitionedRecord[];
  /** Imported records grouped by their legacy item key. */
  byKey(): Map<string, PartitionedRecord[]>;
  cleanup(): void;
}

export function makeMigrationBench(prefix = "osb-migrate-"): MigrationBench {
  const saved = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  const fx = makeLegacyVault(prefix);
  for (const rel of UNMAPPED) rmSync(join(fx.vault, ...rel.split("/")), { force: true });
  const storeRoot = join(fx.parent, "store");
  const configPath = join(fx.parent, "config.yaml");
  writeFileSync(configPath, `vault: ${fx.vault}\n`);
  const env: Record<string, string> = {
    [STORE_ROOT_ENV]: storeRoot,
    O2B_DEVICE_ID: BENCH_DEVICE,
    HOME: join(fx.parent, "home"),
    XDG_STATE_HOME: join(fx.parent, "state"),
    XDG_CONFIG_HOME: join(fx.parent, "config"),
    XDG_DATA_HOME: join(fx.parent, "data"),
    LOCALAPPDATA: join(fx.parent, "state"),
    APPDATA: join(fx.parent, "data"),
    OPEN_SECOND_BRAIN_CONFIG: configPath,
  };
  Object.assign(process.env, env);
  resetFreezeMarkerCache();
  resetVaultIdentityPins();
  initStore({ root: storeRoot });

  const store = (): StoreHandle => openStore({ root: storeRoot, device: BENCH_DEVICE });
  const records = () =>
    (["shared", "private"] as const).flatMap((partition) =>
      readPartition(join(storeRoot, partition)).flatMap((shard) =>
        shard.all.map((record) => ({ ...record, partition })),
      ),
    );
  return {
    fx,
    vault: fx.vault,
    storeRoot,
    env,
    store,
    records,
    byKey: () => {
      const out = new Map<string, PartitionedRecord[]>();
      for (const record of records()) {
        const mark = migratedMark(record);
        if (mark === null) continue;
        out.set(mark.key, [...(out.get(mark.key) ?? []), record]);
      }
      return out;
    },
    cleanup: () => {
      for (const key of ENV_KEYS) {
        const value = saved.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      resetFreezeMarkerCache();
      resetVaultIdentityPins();
      fx.cleanup();
    },
  };
}
