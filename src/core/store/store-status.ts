/**
 * The `store` block of `second_brain_status` and `o2b status --json`
 * (design D12, task 2.11): where the brain store is
 * (`store-location.ts`), the device id this machine writes under, whether
 * the dual-write trial is on, how far the search index has caught up with
 * the store, and whether a migration is available.
 *
 * Read-only and never throwing for a store or config problem: a value
 * that cannot be resolved carries its reason (`{ error }`), so a broken
 * store degrades this block and never the status call that carries it.
 *
 * Paths are reported as they resolve. The block is part of the status
 * diagnostics, which already name the config file and the index path, and
 * it exists so that no agent needs a path by heart.
 */

import { ConfigReadError, readDeviceId } from "../config.ts";
import { readStoreIndexSummary } from "../search/brain-store/index-summary.ts";
import { resolveSearchConfig } from "../search/index.ts";
import { isDualWriteEnabled } from "./dual-write.ts";
import { migrationAvailability } from "./migration-availability.ts";
import { describeConfiguredStoreLocation, type StoreLocationReport } from "./store-location.ts";

export interface StoreStatusSource {
  /** The vault whose index and legacy tree are looked at; `null` when there is none to look at. */
  readonly vault: string | null;
  readonly configPath: string | null;
}

function errorOf(err: unknown): { error: string } {
  return { error: err instanceof Error ? err.message : String(err) };
}

function indexBlock(source: StoreStatusSource): Record<string, unknown> | null {
  if (source.vault === null) return null;
  try {
    const config = resolveSearchConfig({
      vault: source.vault,
      configPath: source.configPath ?? undefined,
    });
    const summary = readStoreIndexSummary(config.dbPath);
    return {
      exists: summary.exists,
      records_indexed: summary.recordsIndexed,
      shards_read: summary.shardsRead,
      last_catch_up_at: summary.lastCatchUpAt,
      ...(summary.error !== undefined ? { error: summary.error } : {}),
    };
  } catch (err) {
    return errorOf(err);
  }
}

/**
 * Whether a migration is available (`migration-availability.ts`, the same
 * answer the doctor gives): the legacy tree is in the vault and this
 * device has not recorded its switch, with the commands to run next.
 */
function migrationBlock(source: StoreStatusSource): Record<string, unknown> {
  const m = migrationAvailability({
    vault: source.vault,
    configPath: source.configPath ?? undefined,
  });
  return {
    available: m.available,
    legacy_tree_present: m.legacyTreePresent,
    store_exists: m.storeExists,
    switched: m.switched,
    next_commands: m.nextCommands,
    ...(m.error !== null ? { error: m.error } : {}),
  };
}

function deviceId(configPath: string | null): string | null | { error: string } {
  try {
    return readDeviceId(configPath);
  } catch (err) {
    if (err instanceof ConfigReadError) return errorOf(err);
    throw err;
  }
}

/** Build the snake_case `store` status block. */
export function buildStoreStatusBlock(source: StoreStatusSource): Record<string, unknown> {
  let location: StoreLocationReport;
  try {
    // The vault the rest of the block describes, so the block agrees with itself.
    location = describeConfiguredStoreLocation(source.configPath ?? undefined, source.vault);
  } catch (err) {
    if (err instanceof ConfigReadError) return errorOf(err);
    throw err;
  }
  return {
    root: location.root,
    initialized: location.initialized,
    store_id: location.storeId,
    partitions: location.partitions,
    partitions_held: location.partitions.filter((p) => p.held).map((p) => p.name),
    device_state_dir: location.deviceStateDir,
    view_target: location.viewTarget,
    device_id: deviceId(source.configPath),
    dual_write_enabled: isDualWriteEnabled(source.configPath ?? undefined),
    index: indexBlock(source),
    migration: migrationBlock(source),
    error: location.error,
  };
}
