/**
 * The shared settings topics read (`view.language`, the thresholds of
 * planning), from the `settings` stream of the configured store's
 * `shared` partition: one reader, so the topic tool, the digest's topic
 * section and the page render of `show` cannot disagree on a value.
 */

import { foldSettings, settingValue, type SettingsFold } from "../store/fold-settings.ts";
import { configuredStore } from "../store/read/store-entities.ts";
import { readStreamRecords } from "../store/read/stream-read.ts";
import type { StoreInspection } from "../store/store-open.ts";

/** The settings fold of `store` (its defaults when it has no `shared` partition). */
export function sharedSettingsOf(store: StoreInspection | null): SettingsFold {
  if (store === null || !store.partitions.has("shared")) return foldSettings([]);
  return foldSettings(readStreamRecords(store.root, "shared", { stream: "settings" }).records);
}

/** The value of `key` in the configured store's shared settings, else its default. */
export function sharedSetting(key: string, configPath?: string): unknown {
  return settingValue(sharedSettingsOf(configuredStore(configPath)), key);
}
