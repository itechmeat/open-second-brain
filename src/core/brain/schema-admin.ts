import { linkConstraintAllows, readBlockedRelationRows } from "../search/link-constraints.ts";
import {
  buildSchemaReport,
  type BrainSchemaReport,
  type SchemaReportFinding,
} from "./schema-report.ts";
import { assessSchemaPackIntegrity, type SchemaPackIntegrity } from "./schema-integrity.ts";
import {
  FRONTMATTER_TIERS,
  loadSchemaPack,
  readSchemaPackSource,
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

/**
 * The one schema pack this vault has, described honestly: where it is,
 * whether that file is actually on disk, what it declares, and whether it
 * is still the pack the last audited apply produced.
 *
 * `exists` is not redundant with `integrity`. A reader that only renders
 * the path needs to know the path names a real file; a reader that cares
 * about tampering needs the verdict. Reporting a path nothing checked was
 * the defect this field closes.
 */
export interface ActiveSchemaPack {
  readonly path: string;
  readonly exists: boolean;
  readonly pack: SchemaPack;
  readonly integrity: SchemaPackIntegrity;
}

/** One entry of {@link listSchemaPacks}. */
export interface SchemaPackListing {
  readonly name: string;
  readonly path: string;
  readonly active: boolean;
  readonly exists: boolean;
  readonly integrity: SchemaPackIntegrity;
}

/** Name of the single pack; there is no registry and no second entry. */
const ACTIVE_SCHEMA_PACK_NAME = "active";

export function getActiveSchemaPack(vault: string): ActiveSchemaPack {
  const source = readSchemaPackSource(vault);
  return {
    path: source.path,
    exists: source.present,
    pack: source.pack,
    integrity: assessSchemaPackIntegrity(vault),
  };
}

export function listSchemaPacks(vault: string): {
  active: string;
  packs: ReadonlyArray<SchemaPackListing>;
} {
  const source = readSchemaPackSource(vault);
  return {
    active: source.path,
    packs: [
      {
        name: ACTIVE_SCHEMA_PACK_NAME,
        path: source.path,
        active: true,
        exists: source.present,
        integrity: assessSchemaPackIntegrity(vault),
      },
    ],
  };
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

/**
 * The declarations nothing uses - and, beside them, the artifacts this
 * scan could not read.
 *
 * The second half is not a courtesy: "nothing uses this token" is a
 * claim about every artifact in the vault, so an artifact that could not
 * be read makes it provisional. Filtering the unreadable rows out would
 * hand the caller a confident orphan list computed over a partial
 * corpus, which is the shape a-label-is-not-a-boundary exists to remove.
 */
export function reviewSchemaOrphans(vault: string): SchemaOrphanReport {
  const reported: ReadonlyArray<SchemaReportFinding["kind"]> = [
    "unused-declaration",
    "unreadable-artifact",
  ];
  return {
    orphans: buildSchemaReport(vault).findings.filter((finding) => reported.includes(finding.kind)),
  };
}

export async function applySchemaAdminMutations(
  vault: string,
  mutations: ReadonlyArray<SchemaMutation>,
  opts: { actor: string; reason?: string },
): Promise<ApplySchemaMutationsResult> {
  return await applySchemaMutations(vault, mutations, opts);
}

/**
 * `o2b brain schema sync` asked for a backfill that was never written.
 *
 * The verb returned `{updated: 0, skipped: 0, note: "no backfill was
 * required"}` unconditionally - it did not read the vault, and it did not
 * even take one: a caller could not tell "nothing needed doing" from
 * "nothing was done". A success report from a function that performed no
 * work is the exact failure this wave exists to remove, so the verb now
 * refuses.
 *
 * Refusing rather than implementing the backfill is deliberate. What
 * `sync` should write is undefined: no design says which frontmatter
 * fields a schema change is supposed to propagate into existing notes,
 * and inventing one inside an integrity unit would ship a vault-wide
 * rewrite nobody specified. An explicit refusal costs an operator one
 * error message; a guessed backfill costs them their notes.
 */
export class SchemaSyncUnavailableError extends Error {
  /** The vault the caller asked to sync, echoed so a log names the store. */
  readonly vault: string;

  constructor(vault: string) {
    super(
      `schema sync is not implemented: no schema backfill is defined for ${vault}, ` +
        "and the verb will not report success for work it did not do",
    );
    this.name = "SchemaSyncUnavailableError";
    this.vault = vault;
  }
}

/**
 * Refuse the schema sync, naming the vault it would have operated on. The
 * parameter is what the previous signature was missing: an implementation
 * can land behind this entry point without every caller changing.
 */
export function buildSchemaSyncResult(vault: string): never {
  throw new SchemaSyncUnavailableError(vault);
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
