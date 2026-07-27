/**
 * The `schema:` block — the runtime schema-pack vocabulary a vault adds
 * on top of the built-in taxonomy.
 *
 * One reason to change: which vocabulary categories and metadata forms a
 * vault may declare. Token-level validation itself belongs to
 * `schema-vocab.ts`; this module only shapes the YAML into the
 * declarations that validator accepts and re-labels its failures as
 * config errors.
 */

import type { BrainSchemaConfig } from "../../types.ts";
import { BrainConfigError } from "../errors.ts";
import { requireArrayField } from "../field-checks.ts";
import { openBlock, warnUnknownKeys, type BlockParseContext } from "../key-index.ts";
import {
  SCHEMA_VOCAB_CATEGORIES,
  SchemaVocabularyError,
  validateSchemaDeclarations,
} from "../../schema-vocab.ts";

const BLOCK = "schema";

/**
 * Keys carrying `name=value`-style metadata rather than bare tokens.
 * Unlike the vocabulary categories they are not passed to
 * `validateSchemaDeclarations`, so their entries are checked here.
 */
const SCHEMA_META_KEYS = [
  "aliases",
  "prefixes",
  "link_types",
  "extractable",
  "expert_routing",
] as const;

/**
 * Shape:
 *   schema:
 *     preference_types: [research, decision]
 *     signal_types: [observation]
 *     page_types: [paper]
 *     log_event_kinds: [milestone]
 *     aliases: [decision=choice]
 *     prefixes: [pref=decision]
 *     link_types: [supports]
 *     extractable: [decision]
 *     expert_routing: [decision=schema-author]
 *
 * Absent block leaves `cfg.schema` undefined; consumers merge built-ins
 * through `resolveSchemaVocabulary`.
 */
export function parseSchemaBlock(ctx: BlockParseContext): BrainSchemaConfig | undefined {
  const schemaObj = openBlock(ctx, BLOCK);
  if (schemaObj === undefined) return undefined;

  const partial: Partial<Record<keyof BrainSchemaConfig, ReadonlyArray<string>>> = {};
  for (const category of SCHEMA_VOCAB_CATEGORIES) {
    if (!(category in schemaObj)) continue;
    partial[category] = requireArrayField(
      schemaObj[category],
      `schema.${category}`,
      ctx.source,
      "must be an array of schema tokens",
    ) as ReadonlyArray<string>;
  }
  for (const key of SCHEMA_META_KEYS) {
    if (!(key in schemaObj)) continue;
    const value = requireArrayField(
      schemaObj[key],
      `schema.${key}`,
      ctx.source,
      "must be an array of schema metadata entries",
    );
    partial[key] = value.map((entry, index) =>
      cleanMetaEntry(entry, `schema.${key}[${index}]`, ctx.source),
    );
  }
  warnUnknownKeys(
    ctx,
    schemaObj,
    [...(SCHEMA_VOCAB_CATEGORIES as ReadonlyArray<string>), ...SCHEMA_META_KEYS],
    BLOCK,
  );

  try {
    const declarations = validateSchemaDeclarations(partial);
    return {
      ...declarations,
      ...(partial.aliases ? { aliases: partial.aliases } : {}),
      ...(partial.prefixes ? { prefixes: partial.prefixes } : {}),
      ...(partial.link_types ? { link_types: partial.link_types } : {}),
      ...(partial.extractable ? { extractable: partial.extractable } : {}),
      ...(partial.expert_routing ? { expert_routing: partial.expert_routing } : {}),
    } as BrainSchemaConfig;
  } catch (err) {
    if (err instanceof SchemaVocabularyError) {
      // `SchemaVocabularyError` already prefixes its field; strip it so
      // `BrainConfigError` does not render the field name twice.
      const detail = err.message.startsWith(`${err.field}: `)
        ? err.message.slice(err.field.length + 2)
        : err.message;
      throw new BrainConfigError(detail, err.field, ctx.source);
    }
    throw err;
  }
}

function cleanMetaEntry(entry: unknown, field: string, source: string | null): string {
  if (typeof entry !== "string") {
    throw new BrainConfigError("must be a string schema metadata entry", field, source);
  }
  const trimmed = entry.trim();
  if (trimmed.length === 0) {
    throw new BrainConfigError("must be a non-empty schema metadata entry", field, source);
  }
  return trimmed;
}
