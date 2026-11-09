/**
 * The switch record of a fresh install (design D14 item 1, task 2.10).
 *
 * A machine with no legacy tree is store-only from its first write
 * (`store-only.ts`, reason `no-legacy-tree`). That answer is computed from
 * the vault, so a later writer of an older release that creates `Brain/`
 * in the vault would flip the machine back to the legacy layout. Writing
 * this device's own `device-switched` record (the record the migration
 * writes, `../store-migration/migration-records.ts`) once the store exists
 * makes the answer durable: from then on the machine is store-only by its
 * record, whatever appears in the vault.
 *
 * `o2b init` and `o2b store init` call {@link recordFreshInstallSwitch};
 * it writes nothing when the vault holds a legacy tree (that machine
 * switches through the migration), when there is no store yet, when this
 * machine has no device id, or when the record is already there.
 */

import { readDeviceId, resolveAgentName } from "../config.ts";
import { readVaultIdentity } from "../brain/vault-identity.ts";
import {
  DEVICE_SWITCHED_KIND,
  deviceSwitchedBody,
  isDeviceSwitched,
  MIGRATION_STREAM,
} from "../store-migration/migration-records.ts";
import { appendRecord } from "./appender.ts";
import { holdsLegacyBrain } from "./legacy-tree.ts";
import { recordSwitchMarker } from "./store-only.ts";
import { inspectStore, openStore } from "./store-open.ts";
import { resolveConfiguredStoreRoot } from "./store-paths.ts";

/** What {@link recordFreshInstallSwitch} did. */
export type FreshSwitchOutcome =
  | "recorded"
  | "already-switched"
  | "legacy-tree"
  | "no-store"
  | "no-device";

export interface FreshSwitchInput {
  /** The configured vault, or `null` for none. */
  readonly vault: string | null;
  /** The machine config the store root and the device id come from. */
  readonly configPath?: string;
}

function agentName(configPath: string | undefined): string {
  try {
    return resolveAgentName(configPath);
  } catch {
    return "o2b";
  }
}

/**
 * Make the switch sticky on this machine (`store-only.ts`), so an absent
 * or unreadable `settings` shard never reads as unswitched. A marker that
 * cannot be written now is written by the next store-only answer that
 * sees the switch record; `o2b init` does not fail over it.
 */
function stickSwitch(root: string, device: string): void {
  try {
    recordSwitchMarker(root, device);
  } catch {
    // see above
  }
}

/**
 * Record this device's `device-switched` when the machine is a fresh
 * install (no legacy tree) and the store exists. Idempotent.
 */
export function recordFreshInstallSwitch(input: FreshSwitchInput): FreshSwitchOutcome {
  // A Brain/ of only what bootstrap writes is a fresh install too
  // (`legacy-tree.ts`, the rule doctor and the status block use).
  if (holdsLegacyBrain(input.vault)) return "legacy-tree";
  const device = readDeviceId(input.configPath ?? null);
  if (device === null) return "no-device";
  const { root } = resolveConfiguredStoreRoot(input.configPath);
  const inspection = inspectStore(root);
  if (inspection === null || !inspection.partitions.has("shared")) return "no-store";
  if (isDeviceSwitched(inspection, device)) {
    stickSwitch(root, device);
    return "already-switched";
  }
  const vault = input.vault?.trim();
  const vaultId = vault ? (readVaultIdentity(vault)?.vault_id ?? null) : null;
  appendRecord(openStore({ root, device }), {
    partition: "shared",
    stream: MIGRATION_STREAM,
    kind: DEVICE_SWITCHED_KIND,
    agent: agentName(input.configPath),
    body: deviceSwitchedBody(vaultId, device),
  });
  stickSwitch(root, device);
  return "recorded";
}
