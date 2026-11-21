/**
 * Vault-map role-token resolution (Vault portability suite, Feature 3).
 *
 * Lets tools resolve `{{role}}` tokens (e.g. `{{inbox}}`, `{{projects}}`)
 * to USER content folder names via an optional vault map, falling back to
 * built-in defaults when the map or a token is absent.
 *
 * Where the map is read: the operator-only shared setting
 * `vault_map.document` first, on every machine (the migration imports
 * `Brain/_vault-map.yaml` into it). Without it, an unswitched machine reads
 * the file. A switched machine that migrated before the import existed
 * reads the copy its legacy-tree removal kept in the device-local archive,
 * once: it stores the text in the setting at the operator's authority, as
 * the migration would have, and reads the setting from then on. With no
 * archive left on the machine, the built-in names apply until the operator
 * sets the setting (`o2b brain settings set vault_map.document ...`).
 *
 * Scope: this addresses the user's content folders only (scan read paths,
 * graph-import target, ...). The FIXED Brain machinery layout in
 * `paths.ts` (`BRAIN_INBOX_REL` etc.) is intentionally NOT routed through
 * this resolver - the "one agent-owned Brain root" design stays intact.
 *
 * Determinism + safety: mapped values are validated against path traversal
 * (no `..` segment, not absolute, no NUL); an invalid value falls back to
 * the built-in default for that role. No language word lists anywhere.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { legacyArchivePath } from "../../store-migration/legacy-kept.ts";
import { resolveAgentName } from "../../config.ts";
import { isStoreOnly } from "../../store/store-only.ts";
import { getBrainSetting, carryOverBrainSetting } from "../policy/settings-write.ts";
import { parseVaultMapText, VAULT_MAP_REL, VAULT_MAP_SETTING } from "./vault-map-document.ts";

/** Canonical PKM role tokens with their default folder names. */
export const DEFAULT_ROLE_TOKENS: Readonly<Record<string, string>> = Object.freeze({
  inbox: "inbox",
  projects: "projects",
  areas: "areas",
  resources: "resources",
  archive: "archive",
  "daily-notes": "daily-notes",
  meetings: "meetings",
  reference: "reference",
  scratch: "scratch",
  templates: "templates",
  attachments: "attachments",
});

/** A mapped folder value is safe when it stays a relative in-vault subpath. */
function isSafeFolder(value: string): boolean {
  const v = value.trim();
  if (v.length === 0) return false;
  // Spaces are legal folder names ("Daily Notes"); reject only genuine
  // hazards: control chars (incl. NUL), absolute paths, `..`/`.` segments.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(v)) return false;
  if (v.startsWith("/") || v.startsWith("\\")) return false;
  if (/^[A-Za-z]:/.test(v)) return false; // Windows drive-absolute
  const segments = v.split(/[\\/]/);
  return !segments.some((s) => s === ".." || s === ".");
}

/** Strip surrounding `{{ }}` (if any) and whitespace from a token. */
function tokenKey(token: string): string {
  return token.replace(/^\{\{/, "").replace(/\}\}$/, "").trim();
}

/**
 * The operator's vault map text in the shared setting, or `null` when it
 * is not set (or only an agent ever won it).
 */
function storedVaultMapText(vault: string): string | null {
  const view = getBrainSetting({ vault }, VAULT_MAP_SETTING);
  if (!view.set || view.authority !== "human") return null;
  return typeof view.value === "string" ? view.value : null;
}

/**
 * The vault map a switched machine's legacy-tree removal kept in the
 * device-local archive, or `null` when there is no archive of this vault
 * or it holds no map.
 */
function archivedVaultMapText(vault: string): string | null {
  const path = legacyArchivePath(vault, VAULT_MAP_REL);
  return path !== null && existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** The agent name the one-time carry-over is stamped with, as the migration's. */
function carryAgent(): string {
  try {
    return resolveAgentName();
  } catch {
    return "o2b-migrate-store";
  }
}

/** The vault map text in force for `vault` on this machine (module docblock). */
function vaultMapText(vault: string): string | null {
  const stored = storedVaultMapText(vault);
  if (stored !== null) return stored;
  if (!isStoreOnly({ vault })) {
    const path = join(vault, ...VAULT_MAP_REL.split("/"));
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  }
  const archived = archivedVaultMapText(vault);
  if (archived === null) return null;
  // Carried over once, as the migration carries the file: the operator
  // wrote it, so it is stored at the operator's authority. An operator's
  // unset is a decision to use the built-in names, not a setting that
  // never existed, and a settings shard this machine cannot see may hold
  // that unset: the carry-over judges both on the read it writes from, and
  // while either holds it writes nothing and the built-in names apply.
  const carried = carryOverBrainSetting(
    { vault, authority: "human", agent: carryAgent() },
    VAULT_MAP_SETTING,
    archived,
  );
  // Refused: the store holds a record of the setting after all (another
  // process set or unset it since the read above). Its value is the
  // answer: the operator's map, or null after an unset (the built-in
  // names), never the built-in names over a map that is in force.
  return carried ? archived : storedVaultMapText(vault);
}

/**
 * Load the vault-map (token -> folder) merged over the built-in defaults.
 * Absent map -> defaults; invalid (traversal/absolute) values are dropped
 * so the default for that role is kept.
 */
export function loadVaultMap(vault: string): Record<string, string> {
  const map: Record<string, string> = { ...DEFAULT_ROLE_TOKENS };
  const text = vaultMapText(vault);
  if (text === null) return map;
  let raw: Record<string, string>;
  try {
    raw = parseVaultMapText(text);
  } catch {
    return map;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" && isSafeFolder(value)) {
      map[key] = value.trim();
    }
  }
  return map;
}

/**
 * Resolve a single `{{role}}` (or bare `role`) token to a folder name.
 * Unknown tokens resolve to their own literal name.
 */
export function resolveRoleToken(map: Record<string, string>, token: string): string {
  const key = tokenKey(token);
  return map[key] ?? key;
}

/** Replace every `{{role}}` occurrence in `text` via {@link resolveRoleToken}. */
export function resolveTokens(map: Record<string, string>, text: string): string {
  return text.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_full, inner: string) =>
    resolveRoleToken(map, inner),
  );
}
