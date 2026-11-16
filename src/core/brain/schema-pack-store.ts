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
 *    writer (`./policy/settings-write.ts`): one `setting-entry` record per
 *    entry the pack adds or drops (task 3.12, design D19 item 1), never the
 *    whole list, so an entry another device adds or removes meanwhile is
 *    kept by the per-entry fold (`../store/fold-setting-lists.ts`).
 *    Nothing under the vault's `Brain/` is written.
 *  - {@link schemaDecidingRecords} names the records that decide the pack
 *    in force, which an apply's audit row attests, each bound to its
 *    content ({@link schemaRecordAttestation}).
 *  - {@link readStoreSchemaRecords} returns the field lists, their text and
 *    their deciding records from one read, for a caller that must hold all
 *    three to one snapshot (an apply, the integrity read).
 */

import { canonicalJson, sha256Hex } from "../integrity/digest.ts";
import type { StoreRecord } from "../store/envelope.ts";
import { settingEntrySlot } from "../store/fold-setting-lists.ts";
import type { RegisterState } from "../store/fold.ts";
import { foldSettings, type SettingsFold } from "../store/fold-settings.ts";
import { configuredStore } from "../store/read/store-entities.ts";
import { readStreamRecords } from "../store/read/stream-read.ts";
import { brainSettingKey } from "./policy/settings-keys.ts";
import {
  writeSharedSettingEntries,
  type SettingAuthority,
  type SharedSettingEntryChange,
} from "./policy/settings-write.ts";
import { SCHEMA_VOCAB_CATEGORIES } from "./schema-vocab.ts";

/** The settings block the pack lives in. */
const SCHEMA_BLOCK = "schema";

/** What a store-only machine names as the place its schema pack lives. */
export const STORE_SCHEMA_PACK_SOURCE = `store:shared/settings/${brainSettingKey(SCHEMA_BLOCK)}`;

/** The shared settings fold the pack is read from (empty without `shared`). */
function schemaFold(configPath?: string): SettingsFold {
  const store = configuredStore(configPath);
  if (store === null || !store.partitions.has("shared")) return foldSettings([]);
  return foldSettings(readStreamRecords(store.root, "shared", { stream: "settings" }).records);
}

const SCHEMA_PREFIX = `${brainSettingKey(SCHEMA_BLOCK)}.`;

/**
 * The fields of the `schema:` block the pack parser reads
 * (`parseSchemaPack` in `./schema-pack.ts`). A record under
 * `brain.schema.` for any other name changes no pack, so it is neither
 * rendered into the pack's text nor attested.
 */
export const SCHEMA_PACK_FIELDS: ReadonlySet<string> = new Set([
  ...SCHEMA_VOCAB_CATEGORIES,
  "aliases",
  "prefixes",
  "link_types",
  "extractable",
  "expert_routing",
  "labels",
  "link_constraints",
  "attributes",
  "frontmatter_tiers",
]);

/** One record that decides the pack in force. */
export interface SchemaDecidingRecord {
  readonly id: string;
  /** What an audit row names to attest this record: {@link schemaRecordAttestation}. */
  readonly attestation: string;
}

/**
 * What an audit row names to attest one record: `<id>:<digest>`, the
 * digest the sha256 of the record's canonical JSON (envelope and body).
 * The id alone is not enough: a record's checksum covers its body, never
 * its id, so another version under an attested id (a different body with
 * a matching checksum) would pass as attested. A row attests the one
 * version it saw.
 */
export function schemaRecordAttestation(record: StoreRecord): string {
  return `${record.id}:${sha256Hex(canonicalJson(record))}`;
}

/**
 * The schema records of the store as one read of the shared settings
 * stream (task 3.12, design D19 item 1): the field lists in force, the
 * config text they render to, and the records deciding them. An apply and
 * the integrity read take all three from this one fold, so a record that
 * syncs in meanwhile can neither change the pack without being among its
 * deciding records nor reach the entries a repair removes.
 */
export interface StoreSchemaRecords {
  /** The `brain.schema.<field>` values in force, by field. */
  readonly fields: Readonly<Record<string, ReadonlyArray<string>>>;
  /** {@link storeSchemaConfigText} of those fields. */
  readonly text: string | null;
  /** {@link schemaDecidingRecords} of the same fold. */
  readonly deciding: ReadonlyArray<SchemaDecidingRecord>;
  /**
   * The id of the record deciding each entry of {@link fields}, by field
   * and entry: what a repair of that entry checks the slot against when
   * it writes (`writeSharedSettingEntries`).
   */
  readonly decidedBy: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/** Read the store's schema records once: see {@link StoreSchemaRecords}. */
export function readStoreSchemaRecords(configPath?: string): StoreSchemaRecords {
  const fold = schemaFold(configPath);
  const fields = fieldsOf(fold);
  return {
    fields,
    text: configTextOf(fields),
    deciding: decidingOf(fold),
    decidedBy: decidedByOf(fold, fields),
  };
}

function decidedByOf(
  fold: SettingsFold,
  fields: Readonly<Record<string, ReadonlyArray<string>>>,
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [field, entries] of Object.entries(fields)) {
    const key = `${SCHEMA_PREFIX}${field}`;
    const slots = fold.lists.get(key);
    const whole = fold.settings.get(key)!.winner.record.id;
    out[field] = Object.fromEntries(
      entries.map((entry) => [
        entry,
        slots?.get(settingEntrySlot(key, entry))?.winner.record.id ?? whole,
      ]),
    );
  }
  return out;
}

/**
 * The records that decide the pack in force, sorted by id: for a field
 * folded per entry each entry's deciding record (removals included, so a
 * removal nobody audited is seen), else the field's winning record. An
 * apply's audit row names them (`decided`), so a pack merged from applies
 * on two devices is still attested (`./schema-integrity.ts`).
 */
export function schemaDecidingRecords(configPath?: string): SchemaDecidingRecord[] {
  return decidingOf(schemaFold(configPath));
}

function decidingOf(fold: SettingsFold): SchemaDecidingRecord[] {
  const records = new Map<string, StoreRecord>();
  const add = (record: StoreRecord) => records.set(record.id, record);
  for (const [key, state] of fold.settings) {
    if (!isPackField(key, state)) continue;
    const slots = fold.lists.get(key);
    if (slots === undefined) add(state.winner.record);
    else for (const slot of slots.values()) add(slot.winner.record);
  }
  return [...records.keys()]
    .toSorted()
    .map((id) => ({ id, attestation: schemaRecordAttestation(records.get(id)!) }));
}

/** The `brain.schema.<field>` values in force, by field. */
export function storeSchemaFields(configPath?: string): Record<string, ReadonlyArray<string>> {
  return fieldsOf(schemaFold(configPath));
}

function fieldsOf(fold: SettingsFold): Record<string, ReadonlyArray<string>> {
  const out: Record<string, ReadonlyArray<string>> = {};
  for (const [key, state] of fold.settings) {
    if (!isPackField(key, state) || state.removed) continue;
    out[key.slice(SCHEMA_PREFIX.length)] = (state.value as unknown[]).map(String);
  }
  return out;
}

/**
 * Whether the settings key `key` is a field of the pack: a name under
 * `brain.schema.` the pack parser reads ({@link SCHEMA_PACK_FIELDS}),
 * holding a list or removed (a removal decides the field too). The pack
 * reader and the attestation use this one filter, so a record the pack
 * never reads cannot change what is attested.
 */
function isPackField(key: string, state: RegisterState<unknown>): boolean {
  if (!key.startsWith(SCHEMA_PREFIX)) return false;
  if (!SCHEMA_PACK_FIELDS.has(key.slice(SCHEMA_PREFIX.length))) return false;
  return state.removed || Array.isArray(state.value);
}

/**
 * The config text of the store's schema pack, or `null` when no schema
 * field is set (the pack is then the built-in vocabulary alone).
 */
export function storeSchemaConfigText(configPath?: string): string | null {
  return configTextOf(storeSchemaFields(configPath));
}

function configTextOf(fields: Readonly<Record<string, ReadonlyArray<string>>>): string | null {
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
 * pack in force, rendered as `currentBlock`: a `setting-entry` record
 * adding each entry the new pack has and the one in force lacks, and one
 * removing each entry it drops (a keyed entry whose value changed is
 * replaced by its new entry alone). Entries are compared by slot, the
 * normalised form the pack parser reads, so a stored entry in another
 * spelling of the same token is no change. An entry the records still
 * hold but the pack in force dropped on read (a reference to an undeclared
 * token, `dropDanglingReferences` in `./schema-pack.ts`) is removed too,
 * as a repair: skipped where this authority may not remove it, since every
 * reader drops it anyway. `stored` holds the field lists `currentBlock` was
 * read from ({@link readStoreSchemaRecords}): the same read, so a repair
 * removes only an entry the pack in force dropped, never one that synced
 * in after the pack was read; and a repair is skipped when another record
 * decides the entry's slot by the time it is written (`decidedBy`), so a
 * replacement another device wrote meanwhile is kept. Returns the ids of
 * the records written.
 */
export function writeSchemaPackToStore(
  ctx: SchemaPackStoreWrite,
  schemaBlock: string,
  currentBlock: string,
  stored: Pick<StoreSchemaRecords, "fields" | "decidedBy">,
): string[] {
  const next = fieldsOfSchemaBlock(schemaBlock);
  const current = fieldsOfSchemaBlock(currentBlock);
  const names = [
    ...new Set([...Object.keys(stored.fields), ...Object.keys(current), ...Object.keys(next)]),
  ].toSorted();
  const changes: SharedSettingEntryChange[] = [];
  for (const field of names) {
    const name = `${SCHEMA_BLOCK}.${field}`;
    const key = `${SCHEMA_PREFIX}${field}`;
    const slot = (entry: string) => settingEntrySlot(key, entry);
    const before = current[field] ?? [];
    const after = next[field] ?? [];
    const kept = new Set(after.map(slot));
    const shown = new Set(before.map(slot));
    for (const entry of after) {
      if (!before.includes(entry)) changes.push({ name, entry, present: true });
    }
    for (const entry of before) {
      if (!kept.has(slot(entry))) changes.push({ name, entry, present: false });
    }
    for (const entry of stored.fields[field] ?? []) {
      const s = slot(entry);
      if (!shown.has(s) && !kept.has(s)) {
        // An entry with no deciding record named is never repaired.
        const decidedBy = stored.decidedBy[field]?.[entry] ?? "";
        changes.push({ name, entry, present: false, repair: { decidedBy } });
      }
    }
  }
  return writeSharedSettingEntries(
    {
      vault: ctx.vault,
      authority: ctx.authority,
      agent: ctx.agent,
      ...(ctx.configPath !== undefined ? { configPath: ctx.configPath } : {}),
    },
    changes,
  );
}
