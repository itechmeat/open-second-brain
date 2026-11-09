/**
 * Test bench for the record lanes (task 2.10 WP6), in each of the three
 * modes a lane module meets:
 *
 *  - `legacy`: an unswitched machine with a legacy `Brain/` tree (pages
 *    are files, dual write on);
 *  - `store`: the same machine after its switch (pages are `lane-entry`
 *    records, nothing may change under `Brain/`);
 *  - `no-vault`: a store and no vault configured at all.
 *
 * Everything lives under one temp parent, removed in teardown.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { appendRecord } from "../../../../src/core/store/appender.ts";
import {
  LANE_ENTRY_KIND,
  LANE_ENTRY_REMOVE_KIND,
} from "../../../../src/core/store/lane-records.ts";
import { laneVaultRoot } from "../../../../src/core/store/lane-pages.ts";
import { readPartition } from "../../../../src/core/store/state-digest.ts";
import { openStore } from "../../../../src/core/store/store-open.ts";
import type { StoreRecord } from "../../../../src/core/store/envelope.ts";
import { makeStoreEnv, type StoreEnv } from "../../store/fixtures/store-env.ts";
import { digestVaultTree } from "../../../helpers/vault-digest.ts";

export type LaneMode = "legacy" | "store" | "no-vault";

export const LANE_MODES: ReadonlyArray<LaneMode> = ["legacy", "store", "no-vault"];

export interface LaneEnv {
  readonly mode: LaneMode;
  readonly env: StoreEnv;
  /** The vault a lane module is handed: the real one, or the no-vault root. */
  readonly vault: string;
  /**
   * Hash of every tree a lane write must not touch (paths, types, mtimes,
   * bytes): the configured vault folder and, in no-vault mode, the root the
   * module was handed (`laneVaultRoot(null)`), which must not even exist.
   */
  vaultHash(): string;
  /** Every lane-entry and lane-entry-remove record of the store (of one partition when given). */
  laneRecords(partition?: "shared" | "private"): StoreRecord[];
  cleanup(): void;
}

export function makeLaneEnv(
  mode: LaneMode,
  prefix = "osb-lane-",
  options: { readonly partitions?: ReadonlyArray<"shared" | "private"> } = {},
): LaneEnv {
  const env = makeStoreEnv(prefix, {
    legacyTree: mode !== "no-vault",
    configureVault: mode !== "no-vault",
    ...(options.partitions !== undefined ? { partitions: options.partitions } : {}),
  });
  if (mode === "store") {
    appendRecord(openStore({ root: env.storeRoot, device: "dev-a" }), {
      partition: "shared",
      stream: "settings",
      kind: "device-switched",
      agent: "o2b",
      body: { authority: "human", device: "dev-a" },
    });
  }
  const vault = mode === "no-vault" ? laneVaultRoot(null) : env.vault;
  return {
    mode,
    env,
    vault,
    vaultHash: () => {
      const handed =
        mode !== "no-vault"
          ? ""
          : existsSync(vault)
            ? digestVaultTree(vault, { mtime: true })
            : "absent";
      return `${digestVaultTree(env.vault, { mtime: true })} ${handed}`;
    },
    laneRecords: (only?: "shared" | "private") =>
      (only !== undefined ? [only] : (["shared", "private"] as const)).flatMap((partition) =>
        readPartition(join(env.storeRoot, partition))
          .flatMap((shard) => shard.all)
          .filter((r) => r.kind === LANE_ENTRY_KIND || r.kind === LANE_ENTRY_REMOVE_KIND),
      ),
    cleanup: () => env.cleanup(),
  };
}
