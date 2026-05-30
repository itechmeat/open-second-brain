import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { appendAuditRecord } from "../reliability/audit.ts";
import { atomicWriteText } from "../reliability/atomic.ts";
import { withFileLock } from "../reliability/lock.ts";
import { brainConfigPath, brainDirs } from "./paths.ts";
import {
  parseSchemaPack,
  renderSchemaBlock,
  replaceSchemaBlock,
  schemaPackTokens,
  type SchemaPack,
} from "./schema-pack.ts";
import {
  SCHEMA_VOCAB_CATEGORIES,
  validateSchemaDeclarations,
  validateSchemaToken,
  type BrainSchemaDeclarations,
  type SchemaVocabularyCategory,
} from "./schema-vocab.ts";

export type SchemaMutation =
  | {
      readonly op: "add_type" | "remove_type";
      readonly category: SchemaVocabularyCategory;
      readonly token: string;
    }
  | {
      readonly op: "update_type";
      readonly category: SchemaVocabularyCategory;
      readonly token: string;
      readonly new_token: string;
    }
  | { readonly op: "add_alias" | "remove_alias"; readonly token: string; readonly alias: string }
  | { readonly op: "add_prefix"; readonly prefix: string; readonly token: string }
  | { readonly op: "remove_prefix"; readonly prefix: string }
  | { readonly op: "add_link_type" | "remove_link_type"; readonly token: string }
  | { readonly op: "set_extractable"; readonly token: string; readonly enabled: boolean }
  | { readonly op: "set_expert_routing"; readonly token: string; readonly expert: string | null };

export interface ApplySchemaMutationsOptions {
  readonly actor: string;
  readonly now?: Date;
  readonly reason?: string;
  readonly lockStaleMs?: number;
}

export interface ApplySchemaMutationsResult {
  readonly applied: number;
  readonly audit_path: string;
  readonly pack: SchemaPack;
}

interface MutableSchemaPack {
  declarations: Record<SchemaVocabularyCategory, string[]>;
  aliases: Record<string, string[]>;
  prefixes: Record<string, string>;
  link_types: string[];
  extractable: string[];
  expert_routing: Record<string, string>;
}

export async function applySchemaMutations(
  vault: string,
  mutations: ReadonlyArray<SchemaMutation>,
  opts: ApplySchemaMutationsOptions,
): Promise<ApplySchemaMutationsResult> {
  const configPath = brainConfigPath(vault);
  const now = opts.now ?? new Date();
  return await withFileLock(configPath, { staleMs: opts.lockStaleMs ?? 30_000, retries: 3 }, () => {
    const before = existsSync(configPath)
      ? readFileSync(configPath, "utf8")
      : "schema_version: 1\n";
    const nextPack = applyMutationsToPack(parseSchemaPack(before), mutations);
    const nextText = replaceSchemaBlock(before, renderSchemaBlock(nextPack));
    atomicWriteText(configPath, nextText, {
      validate: (candidate) => {
        parseSchemaPack(candidate);
      },
    });
    const auditPath = appendAuditRecord(join(brainDirs(vault).log, "schema-mutations"), {
      timestamp: now.toISOString(),
      actor: opts.actor,
      action: "schema_apply_mutations",
      target: "Brain/_brain.yaml",
      ok: true,
      details: {
        applied: mutations.length,
        mutations,
        ...(opts.reason ? { reason: opts.reason } : {}),
      },
    });
    return { applied: mutations.length, audit_path: auditPath, pack: nextPack };
  });
}

export function applyMutationsToPack(
  pack: SchemaPack,
  mutations: ReadonlyArray<SchemaMutation>,
): SchemaPack {
  const mutable = clonePack(pack);
  for (const mutation of mutations) {
    applyOne(mutable, mutation);
  }
  const next = freezeMutable(mutable);
  validateSchemaPackReferences(next);
  return next;
}

function applyOne(pack: MutableSchemaPack, mutation: SchemaMutation): void {
  switch (mutation.op) {
    case "add_type": {
      const token = validateSchemaToken(mutation.token, `schema.${mutation.category}`);
      addUnique(pack.declarations[mutation.category], token);
      return;
    }
    case "remove_type": {
      const token = validateSchemaToken(mutation.token, `schema.${mutation.category}`);
      removeValue(pack.declarations[mutation.category], token);
      delete pack.aliases[token];
      for (const [prefix, target] of Object.entries(pack.prefixes)) {
        if (target === token) delete pack.prefixes[prefix];
      }
      removeValue(pack.extractable, token);
      delete pack.expert_routing[token];
      return;
    }
    case "update_type": {
      const token = validateSchemaToken(mutation.token, `schema.${mutation.category}`);
      const next = validateSchemaToken(mutation.new_token, `schema.${mutation.category}`);
      replaceDeclaredValue(pack.declarations[mutation.category], token, next);
      if (pack.aliases[token]) {
        pack.aliases[next] = pack.aliases[token]!;
        delete pack.aliases[token];
      }
      for (const [prefix, target] of Object.entries(pack.prefixes)) {
        if (target === token) pack.prefixes[prefix] = next;
      }
      replaceExistingValue(pack.extractable, token, next);
      if (pack.expert_routing[token]) {
        pack.expert_routing[next] = pack.expert_routing[token]!;
        delete pack.expert_routing[token];
      }
      return;
    }
    case "add_alias": {
      const token = validateSchemaToken(mutation.token, "schema.aliases");
      const alias = validateSchemaToken(mutation.alias, `schema.aliases.${token}`);
      pack.aliases[token] = pack.aliases[token] ?? [];
      addUnique(pack.aliases[token]!, alias);
      return;
    }
    case "remove_alias": {
      const token = validateSchemaToken(mutation.token, "schema.aliases");
      const alias = validateSchemaToken(mutation.alias, `schema.aliases.${token}`);
      removeValue(pack.aliases[token] ?? [], alias);
      if ((pack.aliases[token]?.length ?? 0) === 0) delete pack.aliases[token];
      return;
    }
    case "add_prefix": {
      const prefix = validateSchemaToken(mutation.prefix, "schema.prefixes");
      const token = validateSchemaToken(mutation.token, `schema.prefixes.${prefix}`);
      pack.prefixes[prefix] = token;
      return;
    }
    case "remove_prefix": {
      const prefix = validateSchemaToken(mutation.prefix, "schema.prefixes");
      delete pack.prefixes[prefix];
      return;
    }
    case "add_link_type": {
      const token = validateSchemaToken(mutation.token, "schema.link_types");
      addUnique(pack.link_types, token);
      return;
    }
    case "remove_link_type": {
      const token = validateSchemaToken(mutation.token, "schema.link_types");
      removeValue(pack.link_types, token);
      return;
    }
    case "set_extractable": {
      const token = validateSchemaToken(mutation.token, "schema.extractable");
      if (mutation.enabled) addUnique(pack.extractable, token);
      else removeValue(pack.extractable, token);
      return;
    }
    case "set_expert_routing": {
      const token = validateSchemaToken(mutation.token, "schema.expert_routing");
      if (mutation.expert === null || mutation.expert.trim() === "") {
        delete pack.expert_routing[token];
      } else {
        pack.expert_routing[token] = mutation.expert.trim();
      }
      return;
    }
  }
}

function clonePack(pack: SchemaPack): MutableSchemaPack {
  return {
    declarations: {
      preference_types: [...(pack.declarations.preference_types ?? [])],
      signal_types: [...(pack.declarations.signal_types ?? [])],
      page_types: [...(pack.declarations.page_types ?? [])],
      log_event_kinds: [...(pack.declarations.log_event_kinds ?? [])],
    },
    aliases: mapArrayRecord(pack.aliases),
    prefixes: { ...pack.prefixes },
    link_types: [...pack.link_types],
    extractable: [...pack.extractable],
    expert_routing: { ...pack.expert_routing },
  };
}

function freezeMutable(input: MutableSchemaPack): SchemaPack {
  const declarations = validateSchemaDeclarations(pruneDeclarations(input.declarations));
  return parseSchemaPack(
    renderSchemaBlock({
      declarations,
      vocabulary: {} as never,
      aliases: freezeArrayRecord(input.aliases),
      prefixes: Object.freeze({ ...input.prefixes }),
      link_types: Object.freeze([...input.link_types]),
      extractable: Object.freeze([...input.extractable]),
      expert_routing: Object.freeze({ ...input.expert_routing }),
    }),
  );
}

function validateSchemaPackReferences(pack: SchemaPack): void {
  const tokens = schemaPackTokens(pack);
  for (const token of Object.keys(pack.aliases)) {
    if (!tokens.has(token)) throw new Error(`schema.aliases.${token}: token is not declared`);
  }
  for (const [prefix, token] of Object.entries(pack.prefixes)) {
    if (!tokens.has(token)) throw new Error(`schema.prefixes.${prefix}: token is not declared`);
  }
  for (const token of pack.extractable) {
    if (!tokens.has(token)) throw new Error(`schema.extractable.${token}: token is not declared`);
  }
  for (const token of Object.keys(pack.expert_routing)) {
    if (!tokens.has(token)) {
      throw new Error(`schema.expert_routing.${token}: token is not declared`);
    }
  }
}

function pruneDeclarations(
  declarations: Record<SchemaVocabularyCategory, string[]>,
): BrainSchemaDeclarations {
  const out: Partial<Record<SchemaVocabularyCategory, ReadonlyArray<string>>> = {};
  for (const category of SCHEMA_VOCAB_CATEGORIES) {
    const values = declarations[category];
    if (values.length > 0) out[category] = values;
  }
  return out as BrainSchemaDeclarations;
}

function mapArrayRecord(
  record: Readonly<Record<string, ReadonlyArray<string>>>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, values] of Object.entries(record)) out[key] = [...values];
  return out;
}

function freezeArrayRecord(
  record: Record<string, string[]>,
): Readonly<Record<string, ReadonlyArray<string>>> {
  const out: Record<string, ReadonlyArray<string>> = {};
  for (const [key, values] of Object.entries(record)) out[key] = Object.freeze([...values]);
  return Object.freeze(out);
}

function addUnique(values: string[], token: string): void {
  if (!values.includes(token)) values.push(token);
}

function removeValue(values: string[], token: string): void {
  const index = values.indexOf(token);
  if (index >= 0) values.splice(index, 1);
}

function replaceDeclaredValue(values: string[], token: string, next: string): void {
  const index = values.indexOf(token);
  if (index >= 0) values[index] = next;
  else values.push(next);
}

function replaceExistingValue(values: string[], token: string, next: string): void {
  const index = values.indexOf(token);
  if (index >= 0) values[index] = next;
}
