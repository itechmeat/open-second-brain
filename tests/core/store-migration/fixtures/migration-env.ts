/**
 * A migration test bench: the legacy fixture vault with nothing unmapped,
 * a created store, and a sandboxed HOME, state, data, config and device id, all
 * under the fixture's one temp parent. {@link MigrationBench.cleanup}
 * restores the environment and removes the parent.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { resetFreezeMarkerCache } from "../../../../src/core/brain/freeze-marker.ts";
import { resetVaultIdentityPins } from "../../../../src/core/brain/vault-identity.ts";
import { STORE_ROOT_ENV } from "../../../../src/core/store/constants.ts";
import type { StoreRecord } from "../../../../src/core/store/envelope.ts";
import { readPartition } from "../../../../src/core/store/state-digest.ts";
import { initStore } from "../../../../src/core/store/store-init.ts";
import { openStore, type StoreHandle } from "../../../../src/core/store/store-open.ts";
import { planMigrationDryRun } from "../../../../src/core/store-migration/dry-run.ts";
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

/**
 * The benches alive in this process, oldest first, and the environment
 * from before the first of them. A bench used to put back what it saw
 * when it was made, which is right only when benches end newest first:
 * two in one file end in the order their `afterAll` hooks were registered,
 * so the newer one put back the older one's paths after the older one had
 * removed them, and every later file of the process booted from a config
 * that no longer existed. Ending in any order now leaves the environment
 * of the newest bench still alive, or, when none is, the one from before.
 */
const LIVE_BENCHES: Array<Readonly<Record<string, string>>> = [];
let envBeforeBenches: Map<string, string | undefined> | null = null;

function enterBenchEnv(env: Readonly<Record<string, string>>): void {
  if (LIVE_BENCHES.length === 0) {
    envBeforeBenches = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  }
  LIVE_BENCHES.push(env);
  Object.assign(process.env, env);
}

function leaveBenchEnv(env: Readonly<Record<string, string>>): void {
  const index = LIVE_BENCHES.indexOf(env);
  if (index === -1) return;
  LIVE_BENCHES.splice(index, 1);
  const newest = LIVE_BENCHES.at(-1);
  if (newest !== undefined) {
    Object.assign(process.env, newest);
    return;
  }
  for (const key of ENV_KEYS) {
    const value = envBeforeBenches?.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  envBeforeBenches = null;
}

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

export function makeMigrationBench(
  prefix = "osb-migrate-",
  options: { readonly withStore?: boolean } = {},
): MigrationBench {
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
  enterBenchEnv(env);
  resetFreezeMarkerCache();
  resetVaultIdentityPins();
  const cleanup = (): void => {
    leaveBenchEnv(env);
    resetFreezeMarkerCache();
    resetVaultIdentityPins();
    fx.cleanup();
  };
  // Without a store, the first machine's automatic migration creates it.
  // A bench that fails to start gives its environment back at once: no
  // caller holds its cleanup yet.
  try {
    if (options.withStore !== false) initStore({ root: storeRoot });
  } catch (error) {
    cleanup();
    throw error;
  }

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
    cleanup,
  };
}

/**
 * Drop every line the dry run cannot parse from the fixture's legacy
 * tree. The fixture carries such a line on purpose (the manual migration
 * archives it); the automatic migration refuses on it, so the benches that
 * exercise an automatic run that succeeds start without it.
 */
export function dropUnparseable(vault: string): void {
  const plan = planMigrationDryRun(vault);
  const byPath = new Map<string, Set<number>>();
  for (const problem of plan.unparseable) {
    if (problem.line === null) {
      rmSync(join(vault, ...problem.path.split("/")), { force: true });
      continue;
    }
    byPath.set(problem.path, (byPath.get(problem.path) ?? new Set()).add(problem.line));
  }
  for (const [rel, lines] of byPath) {
    const path = join(vault, ...rel.split("/"));
    const kept = readFileSync(path, "utf8")
      .split("\n")
      .filter((_, index) => !lines.has(index + 1));
    writeFileSync(path, kept.join("\n"));
  }
}
