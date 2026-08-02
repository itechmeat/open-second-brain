import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { appendAuditRecord } from "../reliability/audit.ts";
import { atomicWriteText } from "../fs-atomic.ts";
import { withFileLock } from "../reliability/lock.ts";
import { brainConfigPath, brainDirsForWrite } from "./paths.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";
import {
  loadSchemaPack,
  parseSchemaPack,
  renderSchemaBlock,
  replaceSchemaBlock,
  schemaPackTokens,
  validateEndpointPair,
  FRONTMATTER_TIERS,
  type FrontmatterTier,
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
  | {
      readonly op: "add_alias" | "remove_alias";
      readonly token: string;
      readonly alias: string;
    }
  | {
      readonly op: "add_prefix";
      readonly prefix: string;
      readonly token: string;
    }
  | { readonly op: "remove_prefix"; readonly prefix: string }
  | {
      readonly op: "add_link_type" | "remove_link_type";
      readonly token: string;
    }
  | {
      readonly op: "set_extractable";
      readonly token: string;
      readonly enabled: boolean;
    }
  | {
      readonly op: "set_expert_routing";
      readonly token: string;
      readonly expert: string | null;
    }
  | {
      readonly op: "add_label_dimension";
      readonly dimension: string;
      readonly values: ReadonlyArray<string>;
    }
  | { readonly op: "remove_label_dimension"; readonly dimension: string }
  | {
      readonly op: "add_link_constraint" | "remove_link_constraint";
      readonly link_type: string;
      readonly source: string;
      readonly target: string;
    }
  | {
      readonly op: "set_attribute_field";
      readonly type: string;
      readonly field: string;
      readonly description: string;
    }
  | {
      readonly op: "remove_attribute_field";
      readonly type: string;
      readonly field: string;
    }
  | {
      readonly op: "set_frontmatter_tier";
      readonly kind: string;
      readonly field: string;
      readonly tier: FrontmatterTier;
    }
  | {
      readonly op: "remove_frontmatter_tier";
      readonly kind: string;
      readonly field: string;
    };

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

/**
 * One leaf-level difference between two schema packs.
 *
 * `before === null` means the leaf would appear, `after === null` means it
 * would disappear, and two non-null values mean a scalar leaf's value would
 * change. A `path` is the dotted address of the leaf inside the pack
 * (`declarations.preference_types`, `prefixes.pref`, `attributes.paper.doi`);
 * list-valued paths report one entry per member, so a rename shows as a
 * removal and an addition under the same path rather than as a mutation of
 * an anonymous list.
 */
export interface SchemaPackDiffEntry {
  readonly path: string;
  readonly before: string | null;
  readonly after: string | null;
}

/**
 * The result of {@link previewSchemaMutations}. Deliberately NOT the shape of
 * {@link ApplySchemaMutationsResult}: a preview has no `audit_path` because it
 * wrote no audit record, and it reports `would_apply` rather than `applied`
 * because nothing was applied. A caller can therefore never mistake a dry run
 * for a real mutation.
 */
export interface PreviewSchemaMutationsResult {
  readonly dry_run: true;
  /** How many mutations were submitted; see `diff` for what would change. */
  readonly would_apply: number;
  readonly pack: SchemaPack;
  readonly diff: ReadonlyArray<SchemaPackDiffEntry>;
}

/**
 * Separates a leaf's path from its value when keying a list MEMBER, so two
 * members of the same list do not collide in the flat map the diff walks. A
 * NUL byte cannot occur in a schema token, an endpoint pair, or a rendered
 * single-line description, so the key is unambiguous.
 */
const LEAF_KEY_SEPARATOR = "\u0000";

interface PackLeaf {
  readonly path: string;
  readonly value: string;
}

interface MutableSchemaPack {
  declarations: Record<SchemaVocabularyCategory, string[]>;
  aliases: Record<string, string[]>;
  prefixes: Record<string, string>;
  link_types: string[];
  extractable: string[];
  expert_routing: Record<string, string>;
  labels: Record<string, string[]>;
  link_constraints: Record<string, string[]>;
  attributes: Record<string, Record<string, string>>;
  frontmatter_tiers: Record<string, Record<string, FrontmatterTier>>;
}

export async function applySchemaMutations(
  vault: string,
  mutations: ReadonlyArray<SchemaMutation>,
  opts: ApplySchemaMutationsOptions,
): Promise<ApplySchemaMutationsResult> {
  // Vault-identity write guard (context-integrity-gates, Unit J), ahead
  // of the `_brain.yaml` rewrite - the trailing audit append is far too
  // late to stop a schema landing in the wrong store.
  assertVaultIdentityForWrite(vault);
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
    const auditPath = appendAuditRecord(join(brainDirsForWrite(vault).log, "schema-mutations"), {
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
    return {
      applied: mutations.length,
      audit_path: auditPath,
      pack: nextPack,
    };
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

/**
 * Build the pack {@link applySchemaMutations} would persist for this batch,
 * WITHOUT touching disk, together with its difference from the pack currently
 * on disk.
 *
 * The preview runs the same {@link applyMutationsToPack} the write path runs,
 * so a batch the validator rejects raises here exactly what it would raise
 * there, and a batch it accepts yields exactly the pack that would land. A
 * preview that were more permissive than the apply it previews would be worse
 * than no preview at all.
 *
 * Two deliberate asymmetries with the write path, both because nothing is
 * written: no file lock is taken (a lock is a file, and a preview creates no
 * files), and the vault-identity WRITE guard is not run - its job is to refuse
 * a write to a store this process did not open, and running it here would pin
 * this process's identity as a side effect of a read.
 */
export function previewSchemaMutations(
  vault: string,
  mutations: ReadonlyArray<SchemaMutation>,
): PreviewSchemaMutationsResult {
  const current = loadSchemaPack(vault);
  const next = applyMutationsToPack(current, mutations);
  return {
    dry_run: true,
    would_apply: mutations.length,
    pack: next,
    diff: diffSchemaPacks(current, next),
  };
}

/**
 * Leaf-level difference between two schema packs, ordered by path so the same
 * two packs always produce the same list.
 *
 * `vocabulary` is excluded: it is the closure of `declarations` over the
 * built-in vocabulary, so every difference in it is already reported under
 * `declarations` and listing both would double-count one change.
 */
export function diffSchemaPacks(
  before: SchemaPack,
  after: SchemaPack,
): ReadonlyArray<SchemaPackDiffEntry> {
  const left = flattenPack(before);
  const right = flattenPack(after);
  const entries: SchemaPackDiffEntry[] = [];
  for (const [key, leaf] of left) {
    const next = right.get(key);
    if (next === undefined) {
      entries.push({ path: leaf.path, before: leaf.value, after: null });
    } else if (next.value !== leaf.value) {
      entries.push({ path: leaf.path, before: leaf.value, after: next.value });
    }
  }
  for (const [key, leaf] of right) {
    if (!left.has(key)) entries.push({ path: leaf.path, before: null, after: leaf.value });
  }
  // Ordered by path, then by the value each entry is about - so a rename
  // under one path reports the departing member before the arriving one.
  return entries.toSorted(
    (a, b) => a.path.localeCompare(b.path) || diffEntryValue(a).localeCompare(diffEntryValue(b)),
  );
}

/** The value a diff entry is about: what left, or - for an addition - what arrived. */
function diffEntryValue(entry: SchemaPackDiffEntry): string {
  return entry.before ?? entry.after ?? "";
}

/** Flatten every authored leaf of a pack to `key -> {path, value}`. */
function flattenPack(pack: SchemaPack): Map<string, PackLeaf> {
  const leaves = new Map<string, PackLeaf>();
  for (const category of SCHEMA_VOCAB_CATEGORIES) {
    addMembers(leaves, `declarations.${category}`, pack.declarations[category] ?? []);
  }
  addRecordMembers(leaves, "aliases", pack.aliases);
  addScalars(leaves, "prefixes", pack.prefixes);
  addMembers(leaves, "link_types", pack.link_types);
  addMembers(leaves, "extractable", pack.extractable);
  addScalars(leaves, "expert_routing", pack.expert_routing);
  addRecordMembers(leaves, "labels", pack.labels);
  addRecordMembers(leaves, "link_constraints", pack.link_constraints);
  addNestedScalars(leaves, "attributes", pack.attributes);
  addNestedScalars(leaves, "frontmatter_tiers", pack.frontmatter_tiers);
  return leaves;
}

/**
 * List members: the value is part of the key, so membership changes read as
 * an addition or a removal and never as an in-place edit of a list slot.
 */
function addMembers(
  leaves: Map<string, PackLeaf>,
  path: string,
  values: ReadonlyArray<string>,
): void {
  for (const value of values) {
    leaves.set(`${path}${LEAF_KEY_SEPARATOR}${value}`, { path, value });
  }
}

/** Scalar map: the key is the leaf path, so a changed value reads as an edit. */
function addScalars(
  leaves: Map<string, PackLeaf>,
  prefix: string,
  record: Readonly<Record<string, string>>,
): void {
  for (const [key, value] of Object.entries(record)) {
    const path = `${prefix}.${key}`;
    leaves.set(path, { path, value });
  }
}

function addRecordMembers(
  leaves: Map<string, PackLeaf>,
  prefix: string,
  record: Readonly<Record<string, ReadonlyArray<string>>>,
): void {
  for (const [key, values] of Object.entries(record))
    addMembers(leaves, `${prefix}.${key}`, values);
}

function addNestedScalars(
  leaves: Map<string, PackLeaf>,
  prefix: string,
  record: Readonly<Record<string, Readonly<Record<string, string>>>>,
): void {
  for (const [key, inner] of Object.entries(record)) addScalars(leaves, `${prefix}.${key}`, inner);
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
      delete pack.attributes[token];
      return;
    }
    case "update_type": {
      const token = validateSchemaToken(mutation.token, `schema.${mutation.category}`);
      const next = validateSchemaToken(mutation.new_token, `schema.${mutation.category}`);
      replaceDeclaredValue(pack.declarations[mutation.category], token, next, mutation.category);
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
      if (pack.attributes[token]) {
        pack.attributes[next] = pack.attributes[token]!;
        delete pack.attributes[token];
      }
      for (const [linkType, pairs] of Object.entries(pack.link_constraints)) {
        pack.link_constraints[linkType] = pairs.map((pair) => {
          const [source, target] = pair.split("->");
          const nextSource = source === token ? next : source!;
          const nextTarget = target === token ? next : target!;
          return `${nextSource}->${nextTarget}`;
        });
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
      delete pack.link_constraints[token];
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
      const expert = mutation.expert?.trim() ?? "";
      if (mutation.expert === null || expert === "") {
        delete pack.expert_routing[token];
      } else if (/[\r\n]/.test(mutation.expert)) {
        throw new Error(`schema.expert_routing.${token}: expert must be a single line`);
      } else {
        pack.expert_routing[token] = expert;
      }
      return;
    }
    case "add_label_dimension": {
      const dimension = validateSchemaToken(mutation.dimension, "schema.labels");
      const values = mutation.values.map((value, index) =>
        validateSchemaToken(value, `schema.labels.${dimension}[${index}]`),
      );
      if (values.length === 0) {
        throw new Error(`schema.labels.${dimension}: at least one value is required`);
      }
      pack.labels[dimension] = pack.labels[dimension] ?? [];
      for (const value of values) addUnique(pack.labels[dimension]!, value);
      return;
    }
    case "remove_label_dimension": {
      const dimension = validateSchemaToken(mutation.dimension, "schema.labels");
      delete pack.labels[dimension];
      return;
    }
    case "add_link_constraint": {
      const linkType = validateSchemaToken(mutation.link_type, "schema.link_constraints");
      const pair = validateEndpointPair(
        `${mutation.source}->${mutation.target}`,
        `schema.link_constraints.${linkType}`,
      );
      pack.link_constraints[linkType] = pack.link_constraints[linkType] ?? [];
      addUnique(pack.link_constraints[linkType]!, pair);
      return;
    }
    case "remove_link_constraint": {
      const linkType = validateSchemaToken(mutation.link_type, "schema.link_constraints");
      const pair = validateEndpointPair(
        `${mutation.source}->${mutation.target}`,
        `schema.link_constraints.${linkType}`,
      );
      removeValue(pack.link_constraints[linkType] ?? [], pair);
      if ((pack.link_constraints[linkType]?.length ?? 0) === 0) {
        delete pack.link_constraints[linkType];
      }
      return;
    }
    case "set_attribute_field": {
      const type = validateSchemaToken(mutation.type, "schema.attributes");
      const field = validateSchemaToken(mutation.field, `schema.attributes.${type}`);
      const description = mutation.description.trim();
      if (description.length === 0) {
        throw new Error(`schema.attributes.${type}.${field}: description must not be empty`);
      }
      if (/[\r\n]/.test(mutation.description)) {
        throw new Error(`schema.attributes.${type}.${field}: description must be a single line`);
      }
      pack.attributes[type] = pack.attributes[type] ?? {};
      pack.attributes[type]![field] = description;
      return;
    }
    case "remove_attribute_field": {
      const type = validateSchemaToken(mutation.type, "schema.attributes");
      const field = validateSchemaToken(mutation.field, `schema.attributes.${type}`);
      delete pack.attributes[type]?.[field];
      if (Object.keys(pack.attributes[type] ?? {}).length === 0) delete pack.attributes[type];
      return;
    }
    case "set_frontmatter_tier": {
      const kind = validateSchemaToken(mutation.kind, "schema.frontmatter_tiers");
      const field = validateSchemaToken(mutation.field, `schema.frontmatter_tiers.${kind}`);
      if (!FRONTMATTER_TIERS.includes(mutation.tier)) {
        throw new Error(
          `schema.frontmatter_tiers.${kind}.${field}: tier must be one of ${FRONTMATTER_TIERS.join(", ")}`,
        );
      }
      pack.frontmatter_tiers[kind] = pack.frontmatter_tiers[kind] ?? {};
      pack.frontmatter_tiers[kind]![field] = mutation.tier;
      return;
    }
    case "remove_frontmatter_tier": {
      const kind = validateSchemaToken(mutation.kind, "schema.frontmatter_tiers");
      const field = validateSchemaToken(mutation.field, `schema.frontmatter_tiers.${kind}`);
      delete pack.frontmatter_tiers[kind]?.[field];
      if (Object.keys(pack.frontmatter_tiers[kind] ?? {}).length === 0) {
        delete pack.frontmatter_tiers[kind];
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
    labels: mapArrayRecord(pack.labels),
    link_constraints: mapArrayRecord(pack.link_constraints),
    attributes: mapNestedRecord(pack.attributes),
    frontmatter_tiers: mapNestedRecord(pack.frontmatter_tiers),
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
      labels: freezeArrayRecord(input.labels),
      link_constraints: freezeArrayRecord(input.link_constraints),
      attributes: freezeNestedRecord(input.attributes),
      frontmatter_tiers: freezeNestedRecord(input.frontmatter_tiers),
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
  for (const linkType of Object.keys(pack.link_constraints)) {
    if (!pack.link_types.includes(linkType)) {
      throw new Error(`schema.link_constraints.${linkType}: link type is not declared`);
    }
  }
  for (const type of Object.keys(pack.attributes)) {
    if (!tokens.has(type)) {
      throw new Error(`schema.attributes.${type}: token is not declared`);
    }
  }
}

function mapNestedRecord<T extends string>(
  record: Readonly<Record<string, Readonly<Record<string, T>>>>,
): Record<string, Record<string, T>> {
  const out: Record<string, Record<string, T>> = {};
  for (const [key, inner] of Object.entries(record)) out[key] = { ...inner };
  return out;
}

function freezeNestedRecord<T extends string>(
  record: Record<string, Record<string, T>>,
): Readonly<Record<string, Readonly<Record<string, T>>>> {
  const out: Record<string, Readonly<Record<string, T>>> = {};
  for (const [key, inner] of Object.entries(record)) out[key] = Object.freeze({ ...inner });
  return Object.freeze(out);
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

function replaceDeclaredValue(
  values: string[],
  token: string,
  next: string,
  category: SchemaVocabularyCategory,
): void {
  const index = values.indexOf(token);
  if (index < 0) throw new Error(`schema.${category}: ${token} is not declared`);
  values[index] = next;
}

function replaceExistingValue(values: string[], token: string, next: string): void {
  const index = values.indexOf(token);
  if (index >= 0) values[index] = next;
}
