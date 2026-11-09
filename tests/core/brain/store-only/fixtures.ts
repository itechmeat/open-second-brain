/**
 * Shared fixtures for the store-only tests of the log and the ledgers
 * (task 2.10, design D14 item 1): switch this device the way the
 * migration does, read what the store holds, and hash the legacy tree so a
 * test proves a switched machine wrote no byte under `Brain/`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  deviceSwitchedBody,
  MIGRATION_STREAM,
} from "../../../../src/core/store-migration/migration-records.ts";
import { appendRecord } from "../../../../src/core/store/appender.ts";
import type { StoreRecord } from "../../../../src/core/store/envelope.ts";
import { readPartition } from "../../../../src/core/store/state-digest.ts";
import { DEVICE_SWITCHED_KIND } from "../../../../src/core/store/store-only.ts";
import { openStore } from "../../../../src/core/store/store-open.ts";
import { digestVaultTree, treeEntries } from "../../../helpers/vault-digest.ts";

/**
 * Write this device's own `device-switched` record, as the migration does:
 * the same stream and body builder (`deviceSwitchedBody`), so every suite
 * switches a machine exactly the way the product does.
 */
export function switchDevice(root: string, device = "dev-a"): void {
  appendRecord(openStore({ root, device }), {
    partition: "shared",
    stream: MIGRATION_STREAM,
    kind: DEVICE_SWITCHED_KIND,
    agent: "o2b",
    body: deviceSwitchedBody(null, device),
  });
}

/** Every record of one partition, in shard order. */
export function partitionRecords(root: string, partition: "shared" | "private"): StoreRecord[] {
  if (!existsSync(join(root, partition))) return [];
  return readPartition(join(root, partition)).flatMap((shard) => shard.records);
}

/** The rows of ledger `name` in one partition, in shard order. */
export function ledgerRows(root: string, partition: "shared" | "private", name: string): unknown[] {
  if (!existsSync(join(root, partition))) return [];
  return readPartition(join(root, partition))
    .filter((shard) => shard.rel.startsWith(`ledgers/${name}/`))
    .flatMap((shard) => shard.records)
    .filter((r) => r.kind === "ledger-row")
    .map((r) => r.body["row"]);
}

/** A digest of the vault's whole `Brain/` tree (or `"absent"`). */
export function brainTreeDigest(vault: string): string {
  const brain = join(vault, "Brain");
  return existsSync(brain) ? digestVaultTree(brain) : "absent";
}

/**
 * Every entry under the vault's `Brain/` outside the log and ledger
 * folders (`log/`, `logs/`), with its digest: the memory pages a writer
 * test compares while the log and ledgers are another package's surface.
 */
export function brainOutsideLog(vault: string): Map<string, string> {
  const entries = treeEntries(join(vault, "Brain"));
  for (const key of entries.keys()) {
    if (key.startsWith("log/") || key.startsWith("logs/")) entries.delete(key);
  }
  return entries;
}
