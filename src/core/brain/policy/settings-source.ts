/**
 * The single reader of brain settings without `_brain.yaml` (design D14
 * item 3, task 2.10).
 *
 * On a store-only machine (`../../store/store-only.ts`) the brain settings
 * no longer come from `<vault>/Brain/_brain.yaml`. The migration's settings
 * import (`../../store-migration/brain-settings.ts`) owns the record shape
 * and its key classification (the leaf `./settings-keys.ts`); this reader
 * reads exactly what it writes:
 *
 *  - **Shared** fields are `setting-set` / `setting-unset` records in the
 *    `settings` stream of `shared` (FORMAT.md "Shared settings"), keyed
 *    `brain.<block>.<field>` (`brain.<key>` for a scalar top-level key),
 *    each holding the field's own value. The settings fold resolves each
 *    key by authority, then clock (design D4), so a human setting wins
 *    over the migration's `agent`-authority seed.
 *  - **Device** fields are lines of the machine config,
 *    `brain_<block>_<field>: <JSON value>`, exactly the lines the
 *    migration prints for the user to add. A shared record for a device
 *    field, and a config line for a shared one, are ignored: neither may
 *    force one machine's value onto the others or the reverse.
 *
 * Keys the table does not classify (a newer release's key) are skipped.
 * The result goes through the same validator `_brain.yaml` goes through,
 * so an absent field takes its default exactly as in the file. With no
 * records and no device lines the answer is the defaults. A shared
 * `settings` shard that cannot be read, or that this machine read before
 * and is gone now, throws {@link BrainSettingsUnreadableError}, as an
 * `_brain.yaml` that cannot be opened does: the record it hides may be an
 * exclusion, so the defaults are never answered in its place.
 */

import { readFileSync, statSync } from "node:fs";

import { defaultConfigPath, discoverConfig } from "../../config.ts";
import { foldSettings } from "../../store/fold-settings.ts";
import { protectionStore, StoreUnavailableError } from "../../store/read/protection-store.ts";
import { readStreamRecords } from "../../store/read/stream-read.ts";
import { listShards } from "../../store/shard-list.ts";
import { partitionDir } from "../../store/store-paths.ts";
import type { StoreInspection } from "../../store/store-open.ts";
import type { BrainConfig } from "../types.ts";
import {
  BrainConfigError,
  BrainSettingsUnreadableError,
  type BrainConfigLoadWarning,
} from "./errors.ts";
import { BRAIN_YAML_KEYS, brainConfigKey, brainKeyHome } from "./settings-keys.ts";
import { validateBrainConfigDetailed } from "./validate.ts";

/** Where a store-backed settings read comes from. */
export interface BrainSettingsSourceOptions {
  /** The machine config the store root and device lines come from. */
  readonly configPath?: string;
  /** The store to read (default: the configured store; `null` for none). */
  readonly store?: StoreInspection | null;
}

export interface BrainSettingsRead {
  readonly config: BrainConfig;
  readonly warnings: ReadonlyArray<BrainConfigLoadWarning>;
  /** A label for messages: where the settings came from. */
  readonly source: string;
}

/** Label used in validation messages for store-backed settings. */
export const STORE_SETTINGS_SOURCE = "brain settings (store and device config)";

const SETTING_PREFIX = "brain.";

/** Put `value` at `block` (scalar key) or `block.field` of `target`. */
function place(
  target: Record<string, unknown>,
  block: string,
  field: string | undefined,
  value: unknown,
): void {
  if (field === undefined) {
    // A block's fields placed earlier stay: they are the finer records.
    if (!(block in target)) target[block] = value;
    return;
  }
  const current = target[block];
  if (typeof current !== "object" || current === null || Array.isArray(current)) {
    target[block] = {};
  }
  (target[block] as Record<string, unknown>)[field] = value;
}

/** The folded shared `brain.*` settings, as `_brain.yaml` keys. */
function sharedBrainSettings(store: StoreInspection | null): Record<string, unknown> {
  if (store === null || !store.partitions.has("shared")) return {};
  const { records, unreadable } = readStreamRecords(store.root, "shared", SETTINGS);
  if (unreadable.length > 0) {
    throw new BrainSettingsUnreadableError(
      `a shared settings shard cannot be read (${unreadable.map((rel) => `shared/${rel}`).join(", ")}); ` +
        "the settings in force are unknown until it reads again",
      STORE_SETTINGS_SOURCE,
    );
  }
  const fold = foldSettings(records);
  const fields: Array<[string, string, unknown]> = [];
  const scalars: Array<[string, unknown]> = [];
  for (const [key, state] of fold.settings) {
    if (!key.startsWith(SETTING_PREFIX) || state.removed) continue;
    const rest = key.slice(SETTING_PREFIX.length);
    const dot = rest.indexOf(".");
    const block = dot === -1 ? rest : rest.slice(0, dot);
    const field = dot === -1 ? undefined : rest.slice(dot + 1);
    if (field !== undefined && field.includes(".")) continue;
    if (brainKeyHome(block, field) !== "shared") continue;
    if (field === undefined) scalars.push([block, state.value]);
    else fields.push([block, field, state.value]);
  }
  const out: Record<string, unknown> = {};
  for (const [block, field, value] of fields) place(out, block, field, value);
  for (const [block, value] of scalars) place(out, block, undefined, value);
  return out;
}

/** A device config key and the `_brain.yaml` key it maps to. */
interface DeviceKey {
  readonly block: string;
  /** `undefined` for a whole device block, whose fields follow the prefix. */
  readonly field: string | undefined;
}

/**
 * Every machine-config key prefix a device field can have, longest first,
 * so `brain_discipline_report_timezone` is never split at an earlier
 * underscore.
 */
const DEVICE_KEYS: ReadonlyArray<DeviceKey & { readonly key: string }> = (() => {
  const out: Array<DeviceKey & { key: string }> = [];
  for (const [block, rule] of Object.entries(BRAIN_YAML_KEYS)) {
    if (rule.home === "device") out.push({ block, field: undefined, key: brainConfigKey(block) });
    for (const [field, home] of Object.entries(rule.fields ?? {})) {
      if (home === "device") out.push({ block, field, key: brainConfigKey(block, field) });
    }
  }
  return out.sort((a, b) => b.key.length - a.key.length);
})();

/** The `_brain.yaml` key a machine-config key names, if it is a device field. */
function deviceKeyOf(configKey: string): DeviceKey | undefined {
  for (const entry of DEVICE_KEYS) {
    if (entry.field !== undefined) {
      if (configKey === entry.key) return entry;
      continue;
    }
    if (configKey === entry.key) return { block: entry.block, field: undefined };
    if (configKey.startsWith(`${entry.key}_`) && configKey.length > entry.key.length + 1) {
      const field = configKey.slice(entry.key.length + 1);
      // A field of a device block can be shared on its own
      // (`decision_model.enabled`): every machine must agree on it, so a
      // config line for it is ignored like any shared one.
      if (brainKeyHome(entry.block, field) !== "device") return undefined;
      return { block: entry.block, field };
    }
  }
  return undefined;
}

/**
 * A device line's value: the JSON the migration printed, or, for a line
 * written by hand that is not JSON, the bare (unquoted) string.
 */
function deviceValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    const quoted =
      raw.length >= 2 &&
      ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")));
    return quoted ? raw.slice(1, -1) : raw;
  }
}

/**
 * The device lines of the machine config, as `_brain.yaml` keys. The file
 * is scanned here rather than through the flat config parser because that
 * parser strips quotes, which would turn the JSON string `"5"` into the
 * number 5.
 */
function deviceBrainSettings(configPath: string | undefined): Record<string, unknown> {
  const found = discoverConfig(configPath);
  if (!found.exists) return {};
  const out: Record<string, unknown> = {};
  for (const rawLine of readFileSync(found.path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("brain_")) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const target = deviceKeyOf(line.slice(0, idx).trim());
    if (target === undefined) continue;
    place(out, target.block, target.field, deviceValue(line.slice(idx + 1).trim()));
  }
  return out;
}

interface CachedRead {
  readonly fingerprint: string;
  readonly read: BrainSettingsRead;
}

/** Reads keyed by store root and machine config, valid until either changes. */
const cache = new Map<string, CachedRead>();

const SETTINGS = { stream: "settings" } as const;

function statStamp(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "missing";
  }
}

/** What a read depends on: the settings shards and the machine config file. */
function fingerprintOf(store: StoreInspection | null, configPath: string): string {
  const parts = [configPath, statStamp(configPath)];
  if (store !== null && store.partitions.has("shared")) {
    parts.push(store.storeId);
    for (const shard of listShards(partitionDir(store.root, "shared"), SETTINGS)) {
      parts.push(`${shard.rel}=${statStamp(shard.path)}`);
    }
  }
  return parts.join("\n");
}

/**
 * The configured store the settings are read from. On a switched machine
 * whose store cannot be opened, or shows no `shared` partition, the
 * settings in force are unknown: it throws
 * {@link BrainSettingsUnreadableError}, as an unseen settings shard does,
 * so capture closes instead of answering the defaults.
 */
function settingsStore(configPath: string | undefined): StoreInspection | null {
  try {
    return protectionStore(configPath, { needShared: true });
  } catch (err) {
    if (!(err instanceof StoreUnavailableError)) throw err;
    throw new BrainSettingsUnreadableError(err.message, STORE_SETTINGS_SOURCE);
  }
}

/**
 * The brain settings of a store-only machine: the folded shared records,
 * the device keys over them, the defaults under both.
 *
 * Throws {@link BrainConfigError} when the folded values do not validate,
 * as an unreadable `_brain.yaml` does: settings that exist and are not in
 * force are never answered with the defaults.
 */
export function readBrainSettingsFromStore(
  options: BrainSettingsSourceOptions = {},
): BrainSettingsRead {
  const store = options.store !== undefined ? options.store : settingsStore(options.configPath);
  let configPath: string;
  try {
    configPath = options.configPath ?? defaultConfigPath();
  } catch {
    configPath = "";
  }
  const key = `${store?.root ?? ""}\u0000${configPath}`;
  const fingerprint = fingerprintOf(store, configPath);
  const hit = cache.get(key);
  if (hit !== undefined && hit.fingerprint === fingerprint) return hit.read;
  const read = readUncached(store, options.configPath);
  cache.set(key, { fingerprint, read });
  return read;
}

function readUncached(
  store: StoreInspection | null,
  configPathOption: string | undefined,
): BrainSettingsRead {
  const merged = mergedRawSettings(store, configPathOption);
  const { config, warnings } = validateBrainConfigDetailed(merged, STORE_SETTINGS_SOURCE);
  // Cached and handed to every caller: frozen, so no caller can change
  // what the next read in this process answers.
  return Object.freeze({
    config: deepFreeze(config),
    warnings: Object.freeze([...warnings]),
    source: STORE_SETTINGS_SOURCE,
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/**
 * The raw `_brain.yaml`-shaped object a store-only machine's settings are
 * validated from: the folded shared records, the device lines over them.
 * The settings writer (`./settings-write.ts`) validates a candidate change
 * against exactly this, so a value it accepts is one this reader accepts.
 */
export function readRawBrainSettingsFromStore(
  options: BrainSettingsSourceOptions = {},
): Record<string, unknown> {
  const store = options.store !== undefined ? options.store : settingsStore(options.configPath);
  return mergedRawSettings(store, options.configPath);
}

function mergedRawSettings(
  store: StoreInspection | null,
  configPathOption: string | undefined,
): Record<string, unknown> {
  let device: Record<string, unknown>;
  try {
    device = deviceBrainSettings(configPathOption);
  } catch (err) {
    throw new BrainConfigError(
      `machine config could not be read: ${(err as Error).message ?? String(err)}`,
      null,
      STORE_SETTINGS_SOURCE,
    );
  }
  const merged: Record<string, unknown> = { schema_version: 1 };
  for (const source of [sharedBrainSettings(store), device]) {
    for (const [block, value] of Object.entries(source)) {
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        for (const [field, inner] of Object.entries(value)) place(merged, block, field, inner);
      } else {
        place(merged, block, undefined, value);
      }
    }
  }
  return merged;
}
