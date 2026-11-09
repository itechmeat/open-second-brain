/**
 * `_brain.yaml` in the store (design D14 item 3): the import of the file
 * into shared settings records and device config lines. Every key the
 * Brain config validator reads is classified once, in
 * `../brain/policy/settings-keys.ts` (re-exported here):
 *
 *  - `shared` keys become `setting-set` records in the `settings` stream
 *    of `shared`, under `brain.<block>.<field>` (`brain.<key>` for a
 *    scalar).
 *  - `device` keys are reported: the migration never writes the user's
 *    config file, it prints the config key and value to add.
 *  - `drop` keys are skipped.
 *
 * Only values the user changed from the shipped default are carried over:
 * such a value is user-authored config, so a shared one is seeded at
 * `human` authority and a device one is reported. A value equal to its
 * default is neither written nor reported; the store's settings reader
 * falls back to the same default.
 *
 * `_permissions.yaml` rides along (review finding F461): its text becomes
 * the operator-only `permissions.document` setting at `human` authority,
 * never over a value the store already holds, so the deny rules stay in
 * force once the legacy tree leaves the vault.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  PERMISSIONS_DOCUMENT_REL,
  PERMISSIONS_DOCUMENT_SETTING,
} from "../brain/permissions/document.ts";

import { brainConfigPath } from "../brain/paths.ts";
import { DEFAULT_BRAIN_CONFIG } from "../brain/policy/defaults.ts";
import { brainConfigKey, brainKeyHome, brainSettingKey } from "../brain/policy/settings-keys.ts";
import { parseBrainYaml } from "../brain/yaml-parse.ts";
import { canonicalJson } from "../integrity/digest.ts";
import { appendRecord } from "../store/appender.ts";
import { AUTHORITY_FIELD, SETTING_SET_KIND } from "../store/constants.ts";
import { foldSettings } from "../store/fold-settings.ts";
import type { StoreHandle } from "../store/store-open.ts";
import { heldRecords } from "./journal.ts";

// The classification lives in a leaf module so the settings reader
// (`brain/policy/settings-source.ts`) can import it without closing an
// import cycle through this module's record builders.
export {
  BRAIN_YAML_KEYS,
  brainConfigKey,
  brainKeyHome,
  brainSettingKey,
  type BrainKeyHome,
  type BrainKeyRule,
} from "../brain/policy/settings-keys.ts";

/**
 * Whether `value` equals the shipped default of `block.field` (or of the
 * scalar `block`). A key with no shipped default counts as changed.
 */
function isDefault(block: string, field: string | undefined, value: unknown): boolean {
  const defaults = DEFAULT_BRAIN_CONFIG as unknown as Record<string, unknown>;
  let fallback: unknown = defaults[block];
  if (field !== undefined) {
    fallback =
      fallback !== null && typeof fallback === "object"
        ? (fallback as Record<string, unknown>)[field]
        : undefined;
  }
  return fallback !== undefined && canonicalJson(fallback) === canonicalJson(value);
}

/** What the import did with one `_brain.yaml` file. */
export interface BrainSettingsImport {
  /** Setting keys written as records. */
  readonly written: ReadonlyArray<string>;
  /**
   * Setting keys the store already holds a record for (set or unset): the
   * store's value wins, because after the first switch settings change
   * only in the store and the synced file goes stale.
   */
  readonly unchanged: ReadonlyArray<string>;
  /** `_brain.yaml` keys whose value equals the shipped default, not carried over. */
  readonly defaults: ReadonlyArray<string>;
  /** Device keys, as `<config key>: <JSON value>` lines to add to the machine config. */
  readonly device: ReadonlyArray<{ readonly yaml: string; readonly line: string }>;
  /** Keys the table does not classify (a newer release's key, or a typo). */
  readonly unknown: ReadonlyArray<string>;
}

/** Each set `(block, field, value)` of a parsed file; a scalar key has no field. */
function entries(parsed: Record<string, unknown>): Array<[string, string | undefined, unknown]> {
  const out: Array<[string, string | undefined, unknown]> = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const [field, inner] of Object.entries(value as Record<string, unknown>)) {
        out.push([key, field, inner]);
      }
    } else {
      out.push([key, undefined, value]);
    }
  }
  return out;
}

/**
 * Import `_brain.yaml` of `vault` into `store`: shared keys become
 * `setting-set` records unless the store's settings fold already holds the
 * key, whatever its value (a later machine, a resumed run, or a user's
 * edit after the first switch, which a stale file must not undo); device
 * keys are reported. A vault with no file imports nothing.
 */
export function importBrainSettings(
  vault: string,
  store: StoreHandle,
  agent: string,
): BrainSettingsImport {
  const path = brainConfigPath(vault);
  const result = {
    written: [] as string[],
    unchanged: [] as string[],
    defaults: [] as string[],
    device: [] as Array<{ yaml: string; line: string }>,
    unknown: [] as string[],
  };
  const fold = foldSettings(heldRecords(store));
  // `_permissions.yaml` becomes the operator-only `permissions.document`
  // setting (review finding F461): its text exactly as the file holds it,
  // at human authority, so a deny rule stays in force once the legacy tree
  // leaves the vault. An unreadable document is imported as it is: the
  // reader refuses it, as it refuses the file (fail closed).
  const permissions = join(vault, PERMISSIONS_DOCUMENT_REL);
  if (existsSync(permissions)) {
    if (fold.settings.has(PERMISSIONS_DOCUMENT_SETTING)) {
      result.unchanged.push(PERMISSIONS_DOCUMENT_SETTING);
    } else {
      appendRecord(store, {
        partition: "shared",
        stream: "settings",
        kind: SETTING_SET_KIND,
        agent,
        body: {
          [AUTHORITY_FIELD]: "human",
          key: PERMISSIONS_DOCUMENT_SETTING,
          value: readFileSync(permissions, "utf8"),
        },
      });
      result.written.push(PERMISSIONS_DOCUMENT_SETTING);
    }
  }
  if (!existsSync(path)) return result;
  const parsed = parseBrainYaml(readFileSync(path, "utf8")) as Record<string, unknown>;
  for (const [block, field, value] of entries(parsed)) {
    const yamlKey = field === undefined ? block : `${block}.${field}`;
    const home = brainKeyHome(block, field);
    if (home === undefined) {
      result.unknown.push(yamlKey);
      continue;
    }
    if (home === "drop" || value === null || value === undefined) continue;
    if (isDefault(block, field, value)) {
      result.defaults.push(yamlKey);
      continue;
    }
    if (home === "device") {
      result.device.push({
        yaml: yamlKey,
        line: `${brainConfigKey(block, field)}: ${JSON.stringify(value)}`,
      });
      continue;
    }
    const key = brainSettingKey(block, field);
    if (fold.settings.has(key)) {
      result.unchanged.push(key);
      continue;
    }
    appendRecord(store, {
      partition: "shared",
      stream: "settings",
      kind: SETTING_SET_KIND,
      agent,
      body: { [AUTHORITY_FIELD]: "human", key, value },
    });
    result.written.push(key);
  }
  return result;
}
