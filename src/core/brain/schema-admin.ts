import { brainConfigPath } from "./paths.ts";
import { linkConstraintAllows, readBlockedRelationRows } from "../search/link-constraints.ts";
import {
  buildSchemaReport,
  type BrainSchemaReport,
  type SchemaReportFinding,
} from "./schema-report.ts";
import {
  FRONTMATTER_TIERS,
  loadSchemaPack,
  type FrontmatterTier,
  type SchemaPack,
} from "./schema-pack.ts";
import {
  applySchemaMutations,
  type ApplySchemaMutationsResult,
  type SchemaMutation,
} from "./schema-mutate.ts";
import {
  DEFAULT_SCHEMA_VOCAB,
  SCHEMA_VOCAB_CATEGORIES,
  normalizeSchemaToken,
  type SchemaVocabularyCategory,
} from "./schema-vocab.ts";

export interface SchemaStats {
  readonly declared: Record<SchemaVocabularyCategory, number>;
  readonly vocabulary: Record<SchemaVocabularyCategory, number>;
  readonly used: Record<SchemaVocabularyCategory, number>;
  readonly metadata: {
    readonly aliases: number;
    readonly prefixes: number;
    readonly link_types: number;
    readonly extractable: number;
    readonly expert_routing: number;
  };
  readonly findings: number;
}

export interface SchemaGraphNode {
  readonly id: string;
  readonly kind: "type" | "link_type" | "expert";
  readonly category?: SchemaVocabularyCategory;
  readonly builtin?: boolean;
}

export interface SchemaGraphEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: "alias" | "prefix" | "extractable" | "expert_routing";
  readonly label?: string;
}

export interface SchemaGraph {
  readonly nodes: ReadonlyArray<SchemaGraphNode>;
  readonly edges: ReadonlyArray<SchemaGraphEdge>;
}

export interface SchemaExplanation {
  readonly token: string;
  readonly categories: ReadonlyArray<SchemaVocabularyCategory>;
  readonly declared: ReadonlyArray<SchemaVocabularyCategory>;
  readonly builtin: ReadonlyArray<SchemaVocabularyCategory>;
  readonly usage: Record<SchemaVocabularyCategory, number>;
  readonly aliases: ReadonlyArray<string>;
  readonly prefixes: ReadonlyArray<string>;
  readonly link_type: boolean;
  readonly extractable: boolean;
  readonly expert: string | null;
  /**
   * Declared attribute fields for this type with their natural-language
   * descriptions (write-time-integrity-governance) - the vocabulary an
   * agent should populate when capturing this type.
   */
  readonly attributes: Readonly<Record<string, string>>;
}

export interface SchemaOrphanReport {
  readonly orphans: ReadonlyArray<SchemaReportFinding>;
}

export interface SchemaSyncResult {
  readonly dry_run: boolean;
  readonly batch_size: number;
  readonly updated: number;
  readonly skipped: number;
  readonly note: string;
}

export function getActiveSchemaPack(vault: string): {
  path: string;
  pack: SchemaPack;
} {
  return { path: brainConfigPath(vault), pack: loadSchemaPack(vault) };
}

export function listSchemaPacks(vault: string): {
  active: string;
  packs: ReadonlyArray<{ name: string; path: string; active: boolean }>;
} {
  const active = brainConfigPath(vault);
  return { active, packs: [{ name: "active", path: active, active: true }] };
}

export function buildSchemaStats(vault: string): SchemaStats {
  const pack = loadSchemaPack(vault);
  const report = buildSchemaReport(vault);
  const declared = emptyCounts();
  const vocabulary = emptyCounts();
  const used = emptyCounts();
  for (const category of SCHEMA_VOCAB_CATEGORIES) {
    declared[category] = (pack.declarations[category] ?? []).length;
    vocabulary[category] = pack.vocabulary[category].length;
    used[category] = sumUsage(report, category);
  }
  return {
    declared,
    vocabulary,
    used,
    metadata: {
      aliases: Object.values(pack.aliases).reduce((sum, values) => sum + values.length, 0),
      prefixes: Object.keys(pack.prefixes).length,
      link_types: pack.link_types.length,
      extractable: pack.extractable.length,
      expert_routing: Object.keys(pack.expert_routing).length,
    },
    findings: report.findings.length,
  };
}

export function buildSchemaLint(
  vault: string,
  opts: { readonly dbPath?: string } = {},
): {
  findings: ReadonlyArray<SchemaReportFinding>;
} {
  const findings: SchemaReportFinding[] = [...buildSchemaReport(vault).findings];
  if (opts.dbPath !== undefined) {
    // Link-constraint enforcement happens in the indexer's
    // materialization post-pass; lint reads the blocked edges back
    // from the index (fail-soft: no index file = no findings) and
    // re-checks each one against the CURRENT pack, so a `schema
    // apply` that removed or relaxed a constraint stops reporting
    // stale violations immediately - the next index run unblocks the
    // edges themselves.
    const constraints = loadSchemaPack(vault).link_constraints;
    for (const row of readBlockedRelationRows(opts.dbPath)) {
      if (linkConstraintAllows(constraints, row.relation, row.sourceType, row.targetType)) {
        continue; // stale flag; the next index run clears it
      }
      findings.push({
        kind: "link-constraint-violation",
        relation: row.relation,
        source: row.sourcePath,
        target: row.targetPath,
        source_type: row.sourceType,
        target_type: row.targetType,
      });
    }
  }
  return { findings };
}

export function buildSchemaGraph(vault: string): SchemaGraph {
  const pack = loadSchemaPack(vault);
  const nodes = new Map<string, SchemaGraphNode>();
  const edges: SchemaGraphEdge[] = [];
  for (const category of SCHEMA_VOCAB_CATEGORIES) {
    const builtin = new Set(DEFAULT_SCHEMA_VOCAB[category]);
    for (const token of pack.vocabulary[category]) {
      nodes.set(token, {
        id: token,
        kind: "type",
        category,
        builtin: builtin.has(token),
      });
    }
  }
  for (const token of pack.link_types) {
    nodes.set(`link:${token}`, { id: `link:${token}`, kind: "link_type" });
  }
  for (const [token, aliases] of Object.entries(pack.aliases)) {
    for (const alias of aliases) {
      nodes.set(alias, nodes.get(alias) ?? { id: alias, kind: "type" });
      edges.push({ from: alias, to: token, kind: "alias" });
    }
  }
  for (const [prefix, token] of Object.entries(pack.prefixes)) {
    edges.push({ from: prefix, to: token, kind: "prefix" });
  }
  for (const token of pack.extractable) {
    edges.push({ from: token, to: token, kind: "extractable" });
  }
  for (const [token, expert] of Object.entries(pack.expert_routing)) {
    nodes.set(`expert:${expert}`, { id: expert, kind: "expert" });
    edges.push({ from: token, to: expert, kind: "expert_routing" });
  }
  return {
    nodes: [...nodes.values()].toSorted((left, right) => left.id.localeCompare(right.id)),
    edges: edges.toSorted(
      (left, right) =>
        left.kind.localeCompare(right.kind) ||
        left.from.localeCompare(right.from) ||
        left.to.localeCompare(right.to),
    ),
  };
}

export function explainSchemaToken(vault: string, rawToken: string): SchemaExplanation {
  const token = normalizeSchemaToken(rawToken);
  const pack = loadSchemaPack(vault);
  const report = buildSchemaReport(vault);
  const categories = SCHEMA_VOCAB_CATEGORIES.filter((category) =>
    pack.vocabulary[category].includes(token),
  );
  const declared = SCHEMA_VOCAB_CATEGORIES.filter((category) =>
    (pack.declarations[category] ?? []).includes(token),
  );
  const builtin = SCHEMA_VOCAB_CATEGORIES.filter((category) =>
    DEFAULT_SCHEMA_VOCAB[category].includes(token),
  );
  const usage = emptyCounts();
  for (const category of SCHEMA_VOCAB_CATEGORIES)
    usage[category] = usageCount(report, category, token);
  return {
    token,
    categories,
    declared,
    builtin,
    usage,
    aliases: pack.aliases[token] ?? [],
    prefixes: Object.entries(pack.prefixes)
      .filter(([, value]) => value === token)
      .map(([prefix]) => prefix)
      .toSorted(),
    link_type: pack.link_types.includes(token),
    extractable: pack.extractable.includes(token),
    expert: pack.expert_routing[token] ?? null,
    attributes: pack.attributes[token] ?? {},
  };
}

export function reviewSchemaOrphans(vault: string): SchemaOrphanReport {
  return {
    orphans: buildSchemaReport(vault).findings.filter(
      (finding) => finding.kind === "unused-declaration",
    ),
  };
}

export async function applySchemaAdminMutations(
  vault: string,
  mutations: ReadonlyArray<SchemaMutation>,
  opts: { actor: string; reason?: string },
): Promise<ApplySchemaMutationsResult> {
  return await applySchemaMutations(vault, mutations, opts);
}

export function buildSchemaSyncResult(
  opts: { dryRun?: boolean; batchSize?: number } = {},
): SchemaSyncResult {
  return {
    dry_run: opts.dryRun ?? true,
    batch_size: opts.batchSize ?? 100,
    updated: 0,
    skipped: 0,
    note: "schema_type metadata is already stored in vault files; no backfill was required",
  };
}

export function parseSchemaMutationPayloads(payloads: ReadonlyArray<string>): SchemaMutation[] {
  const out: SchemaMutation[] = [];
  for (const payload of payloads) {
    const parsed = JSON.parse(payload) as unknown;
    if (Array.isArray(parsed)) {
      for (const item of parsed) out.push(coerceSchemaMutation(item));
    } else {
      out.push(coerceSchemaMutation(parsed));
    }
  }
  return out;
}

export function coerceSchemaMutations(value: unknown): SchemaMutation[] {
  if (!Array.isArray(value)) throw new Error("mutations must be an array");
  return value.map(coerceSchemaMutation);
}

function coerceSchemaMutation(value: unknown): SchemaMutation {
  if (!isRecord(value)) throw new Error("schema mutation must be an object");
  const op = readString(value, "op");
  switch (op) {
    case "add_type":
    case "remove_type":
      return {
        op,
        category: readCategory(value),
        token: readString(value, "token"),
      };
    case "update_type":
      return {
        op,
        category: readCategory(value),
        token: readString(value, "token"),
        new_token: readString(value, "new_token"),
      };
    case "add_alias":
    case "remove_alias":
      return {
        op,
        token: readString(value, "token"),
        alias: readString(value, "alias"),
      };
    case "add_prefix":
      return {
        op,
        prefix: readString(value, "prefix"),
        token: readString(value, "token"),
      };
    case "remove_prefix":
      return { op, prefix: readString(value, "prefix") };
    case "add_link_type":
    case "remove_link_type":
      return { op, token: readString(value, "token") };
    case "set_extractable":
      return {
        op,
        token: readString(value, "token"),
        enabled: readBoolean(value, "enabled"),
      };
    case "set_expert_routing": {
      const expert = value["expert"];
      if (expert !== null && typeof expert !== "string")
        throw new Error("mutation.expert must be a string or null");
      return { op, token: readString(value, "token"), expert };
    }
    case "add_label_dimension":
      return {
        op,
        dimension: readString(value, "dimension"),
        values: readStringArray(value, "values"),
      };
    case "remove_label_dimension":
      return { op, dimension: readString(value, "dimension") };
    case "add_link_constraint":
    case "remove_link_constraint":
      return {
        op,
        link_type: readString(value, "link_type"),
        source: readString(value, "source"),
        target: readString(value, "target"),
      };
    case "set_attribute_field":
      return {
        op,
        type: readString(value, "type"),
        field: readString(value, "field"),
        description: readString(value, "description"),
      };
    case "remove_attribute_field":
      return { op, type: readString(value, "type"), field: readString(value, "field") };
    case "set_frontmatter_tier": {
      const tier = readString(value, "tier");
      if (!(FRONTMATTER_TIERS as ReadonlyArray<string>).includes(tier)) {
        throw new Error(`mutation.tier must be one of ${FRONTMATTER_TIERS.join(", ")}`);
      }
      return {
        op,
        kind: readString(value, "kind"),
        field: readString(value, "field"),
        tier: tier as FrontmatterTier,
      };
    }
    case "remove_frontmatter_tier":
      return { op, kind: readString(value, "kind"), field: readString(value, "field") };
    default:
      throw new Error(`unsupported schema mutation op: ${op}`);
  }
}

function readStringArray(value: Record<string, unknown>, key: string): string[] {
  const raw = value[key];
  if (!Array.isArray(raw) || !raw.every((item): item is string => typeof item === "string")) {
    throw new Error(`mutation.${key} must be an array of strings`);
  }
  return raw;
}

function readCategory(value: Record<string, unknown>): SchemaVocabularyCategory {
  const raw = readString(value, "category");
  if (!(SCHEMA_VOCAB_CATEGORIES as ReadonlyArray<string>).includes(raw)) {
    throw new Error(`mutation.category must be one of ${SCHEMA_VOCAB_CATEGORIES.join(", ")}`);
  }
  return raw as SchemaVocabularyCategory;
}

function readString(value: Record<string, unknown>, key: string): string {
  const raw = value[key];
  if (typeof raw !== "string" || raw.trim() === "")
    throw new Error(`mutation.${key} must be a non-empty string`);
  return raw;
}

function readBoolean(value: Record<string, unknown>, key: string): boolean {
  const raw = value[key];
  if (typeof raw !== "boolean") throw new Error(`mutation.${key} must be a boolean`);
  return raw;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyCounts(): Record<SchemaVocabularyCategory, number> {
  return {
    preference_types: 0,
    signal_types: 0,
    page_types: 0,
    log_event_kinds: 0,
  };
}

function sumUsage(report: BrainSchemaReport, category: SchemaVocabularyCategory): number {
  return report.usage[category].reduce((sum, item) => sum + item.count, 0);
}

function usageCount(
  report: BrainSchemaReport,
  category: SchemaVocabularyCategory,
  token: string,
): number {
  return report.usage[category].find((item) => item.token === token)?.count ?? 0;
}
