/**
 * The vault map as a store setting: the name of the operator-only shared
 * setting that holds the text `Brain/_vault-map.yaml` held, and the parse
 * both the setting's validator and the role-token reader use. A leaf
 * module, so the settings registry (`policy/settings-names.ts`) can name
 * the setting without importing the reader, which reads settings.
 *
 * The role tokens map the vault's own content folders, the same for every
 * machine that opens the vault, and only the operator wrote the file (no
 * agent writer touches it): so it is one shared setting at `human`
 * authority, as `_permissions.yaml` is `permissions.document`.
 */

import { parseSimpleYaml } from "../../config.ts";
import { BRAIN_ROOT_REL } from "../path-constants.ts";

/** The shared setting holding the vault map's YAML text. */
export const VAULT_MAP_SETTING = "vault_map.document";

/** Vault-relative path of the legacy vault map file. */
export const VAULT_MAP_REL = `${BRAIN_ROOT_REL}/_vault-map.yaml`;

/** The `token: folder` pairs of a vault map's text, every value a string. */
export function parseVaultMapText(text: string): Record<string, string> {
  return parseSimpleYaml(text);
}

/** `null` when `value` can be the setting's value, else why not. */
export function invalidVaultMapValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return `${VAULT_MAP_SETTING} must be the YAML text of a vault map (token: folder lines)`;
  }
  return null;
}
