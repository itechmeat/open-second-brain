/**
 * The schema pack of a store-only machine (design D14 item 3, task 2.11):
 * the `schema:` block of `_brain.yaml` lives in the shared settings
 * records `brain.schema.<field>`, each holding the field's list exactly as
 * the migration imported it (one entry per rendered list line). A machine
 * with no vault reads the same records.
 *
 *  - {@link storeSchemaConfigText} renders those records back into the
 *    config text the pack parser (`./schema-pack.ts`) reads, so every
 *    reader of the pack works unchanged on a store-only machine.
 *  - {@link writeSchemaPackToStore} writes a pack the mutation lane
 *    already validated as one store operation through the shared settings
 *    writer (`./policy/settings-write.ts`): changed fields as
 *    `setting-set`, fields the pack no longer has as `setting-unset`.
 *    Nothing under the vault's `Brain/` is written.
 */

import { foldSettings } from "../store/fold-settings.ts";
import { configuredStore } from "../store/read/store-entities.ts";
import { readStreamRecords } from "../store/read/stream-read.ts";
import { brainSettingKey } from "./policy/settings-keys.ts";
import { writeSharedSettingRecords, type SettingAuthority } from "./policy/settings-write.ts";

/** The settings block the pack lives in. */
const SCHEMA_BLOCK = "schema";

/** What a store-only machine names as the place its schema pack lives. */
export const STORE_SCHEMA_PACK_SOURCE = `store:shared/settings/${brainSettingKey(SCHEMA_BLOCK)}`;

/** The `brain.schema.<field>` values in force, by field. */
export function storeSchemaFields(configPath?: string): Record<string, ReadonlyArray<string>> {
  const store = configuredStore(configPath);
  if (store === null || !store.partitions.has("shared")) return {};
  const fold = foldSettings(
    readStreamRecords(store.root, "shared", { stream: "settings" }).records,
  );
  const prefix = `${brainSettingKey(SCHEMA_BLOCK)}.`;
  const out: Record<string, ReadonlyArray<string>> = {};
  for (const [key, state] of fold.settings) {
    if (!key.startsWith(prefix) || state.removed) continue;
    const field = key.slice(prefix.length);
    if (field.includes(".") || !Array.isArray(state.value)) continue;
    out[field] = state.value.map(String);
  }
  return out;
}

/**
 * The config text of the store's schema pack, or `null` when no schema
 * field is set (the pack is then the built-in vocabulary alone).
 */
export function storeSchemaConfigText(configPath?: string): string | null {
  const fields = storeSchemaFields(configPath);
  const names = Object.keys(fields).toSorted();
  if (names.length === 0) return null;
  const lines = ["schema_version: 1", `${SCHEMA_BLOCK}:`];
  for (const name of names) {
    const entries = fields[name]!;
    if (entries.length === 0) continue;
    lines.push(`  ${name}:`);
    for (const entry of entries) lines.push(`    - ${entry}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The `schema:` block text of a rendered pack, as per-field lists of the
 * entries exactly as rendered (`    - <entry>`). Split line by line, the
 * inverse of {@link storeSchemaConfigText}, so an entry the general YAML
 * parser would read otherwise (a `: ` or ` #` inside it, quotes) round-
 * trips byte for byte to the pack's own line parser.
 */
function fieldsOfSchemaBlock(schemaBlock: string): Record<string, ReadonlyArray<string>> {
  const out: Record<string, string[]> = {};
  let field: string | null = null;
  for (const line of schemaBlock.replace(/\r\n?/g, "\n").split("\n")) {
    const header = /^ {2}([A-Za-z0-9_]+):\s*$/.exec(line);
    if (header !== null) {
      field = header[1]!;
      continue;
    }
    const entry = /^ {4}- (.*)$/.exec(line);
    if (entry !== null && field !== null) (out[field] ??= []).push(entry[1]!);
  }
  return out;
}

export interface SchemaPackStoreWrite {
  readonly vault: string | null;
  readonly configPath?: string;
  readonly authority: SettingAuthority;
  readonly agent: string;
}

/**
 * Write the pack whose rendered `schema:` block is `schemaBlock` over the
 * pack in force: one `setting-set` per changed field, one `setting-unset`
 * per field the new pack drops. Returns the ids of the records written.
 */
export function writeSchemaPackToStore(ctx: SchemaPackStoreWrite, schemaBlock: string): string[] {
  const next = fieldsOfSchemaBlock(schemaBlock);
  const current = storeSchemaFields(ctx.configPath);
  const names = [...new Set([...Object.keys(current), ...Object.keys(next)])].toSorted();
  return writeSharedSettingRecords(
    {
      vault: ctx.vault,
      authority: ctx.authority,
      agent: ctx.agent,
      ...(ctx.configPath !== undefined ? { configPath: ctx.configPath } : {}),
    },
    names.map((field) => ({
      name: `${SCHEMA_BLOCK}.${field}`,
      value: next[field] ?? null,
    })),
  );
}
