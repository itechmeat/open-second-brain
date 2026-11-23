/**
 * The shared setting `dream.auto` (change `dream-session-trigger`, design
 * D5) as this device reads it from the `settings` stream of `shared`.
 */

import {
  SETTING_DREAM_AUTO,
  SETTING_ENTRY_KIND,
  SETTING_SET_KIND,
  SETTING_UNSET_KIND,
} from "../../store/constants.ts";
import { foldSettings, settingValue } from "../../store/fold-settings.ts";
import { readStreamRecords } from "../../store/read/stream-read.ts";

/**
 * The setting at the store `root`: `true` unless it is set to `false`;
 * `null` when the stream cannot be read completely here (unknown is not
 * the default).
 */
export function readDreamAuto(root: string): boolean | null {
  const read = readStreamRecords(root, "shared", { stream: "settings" });
  if (read.unreadable.length > 0) return null;
  for (const kind of [SETTING_SET_KIND, SETTING_UNSET_KIND, SETTING_ENTRY_KIND]) {
    if ((read.pendingKinds.get(kind) ?? 0) > 0) return null;
  }
  // The whole stream is folded, as every reader of the shared settings
  // folds it: two versions of one record id are settled before any key is
  // looked at, so this reads the value the shared fold resolves.
  const value = settingValue(foldSettings(read.records), SETTING_DREAM_AUTO);
  return value !== false;
}
