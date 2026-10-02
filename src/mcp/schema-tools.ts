import {
  applySchemaAdminMutations,
  buildSchemaGraph,
  buildSchemaLint,
  buildSchemaStats,
  coerceSchemaMutations,
  explainSchemaToken,
  getActiveSchemaPack,
  listSchemaPacks,
  reviewSchemaOrphans,
} from "../core/brain/schema-admin.ts";
import { previewSchemaMutations, type SchemaMutation } from "../core/brain/schema-mutate.ts";
import { buildSchemaReport, type SchemaReportFinding } from "../core/brain/schema-report.ts";
import { reachView } from "../core/brain/reach-view.ts";
import { TRANSPORT_REACH } from "../core/graph/transport-reach.ts";
import { resolveSearchConfig } from "../core/search/index.ts";
import { INVALID_PARAMS, MCPError } from "./protocol.ts";
import { coerceBool, coerceStr } from "./coerce.ts";
import { MCP_PREVIEW_BUDGET } from "./preview-budget.ts";
import { contextReach, type ServerContext, type ToolDefinition } from "./tool-contract.ts";

/**
 * The pages a schema finding names, as references the reach view judges.
 * A declaration nobody uses names no page.
 */
function findingRefs(finding: SchemaReportFinding): ReadonlyArray<string> {
  switch (finding.kind) {
    case "unknown-token":
    case "unreadable-artifact":
      return [finding.path];
    case "link-constraint-violation":
      return [finding.source, finding.target];
    case "unused-declaration":
      return [];
  }
}

/**
 * The findings a caller may see at its reach. Every finding that names a
 * record names it by path, so below local reach a record the caller may
 * not read is reported by no view, and `stats` counts what `lint` lists:
 * a malformed private page answers as an absent one.
 */
function visibleFindings<T extends SchemaReportFinding>(
  ctx: ServerContext,
  findings: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const view = reachView(ctx.vault, contextReach(ctx));
  return view.filtersNothing ? findings : view.keep(findings, findingRefs);
}

// Read-side handlers behind the consolidated `schema_inspect` views.
// The per-view alias tools were removed in 1.0.0 (tombstones in
// `REMOVED_TOOLS`, src/mcp/tools.ts).
const SCHEMA_INSPECT_VIEWS: Readonly<
  Record<string, (ctx: ServerContext, args: Record<string, unknown>) => Promise<unknown> | unknown>
> = Object.freeze({
  graph: (ctx: ServerContext) => buildSchemaGraph(ctx.vault),
  lint: (ctx: ServerContext) => {
    const lint = buildSchemaLint(ctx.vault, {
      dbPath: resolveSearchConfig({ vault: ctx.vault, configPath: ctx.configPath ?? undefined })
        .dbPath,
    });
    return { ...lint, findings: visibleFindings(ctx, lint.findings) };
  },
  stats: (ctx: ServerContext) => {
    const stats = buildSchemaStats(ctx.vault);
    if (contextReach(ctx) === TRANSPORT_REACH.local) return stats;
    return {
      ...stats,
      findings: visibleFindings(ctx, buildSchemaReport(ctx.vault).findings).length,
    };
  },
  orphans: (ctx: ServerContext) => {
    const orphans = reviewSchemaOrphans(ctx.vault);
    return { ...orphans, orphans: visibleFindings(ctx, orphans.orphans) };
  },
  explain_type: (ctx: ServerContext, args: Record<string, unknown>) =>
    explainSchemaToken(ctx.vault, coerceStr(args, "token")!),
  active_pack: (ctx: ServerContext) => getActiveSchemaPack(ctx.vault),
  packs: (ctx: ServerContext) => listSchemaPacks(ctx.vault),
});

function toolSchemaInspect(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<unknown> | unknown {
  const view = typeof args["view"] === "string" ? args["view"] : "";
  const handler = SCHEMA_INSPECT_VIEWS[view];
  if (handler === undefined) {
    throw new MCPError(
      INVALID_PARAMS,
      `view must be one of ${Object.keys(SCHEMA_INSPECT_VIEWS).join(", ")}; got ${JSON.stringify(
        args["view"],
      )}`,
    );
  }
  return handler(ctx, args);
}

export const SCHEMA_TOOLS: ReadonlyArray<ToolDefinition> = [
  {
    name: "schema_inspect",
    previewBudget: MCP_PREVIEW_BUDGET,
    description:
      "Read-only Brain schema inspection, one tool for every view: graph, lint, stats, orphans, explain_type (needs token), active_pack, or packs. Replaces the per-view schema read tools.",
    inputSchema: {
      type: "object",
      properties: {
        view: {
          type: "string",
          enum: ["graph", "lint", "stats", "orphans", "explain_type", "active_pack", "packs"],
          description: "Which schema view to produce.",
        },
        token: { type: "string", description: "view=explain_type: schema token to explain." },
      },
      required: ["view"],
      additionalProperties: false,
    },
    handler: toolSchemaInspect,
  },
  {
    name: "schema_apply_mutations",
    description:
      "Apply an atomic batch of schema mutations to Brain/_brain.yaml and write an audit record. With dry_run, returns the pack that would result and its diff instead, writing nothing.",
    inputSchema: {
      type: "object",
      properties: {
        mutations: {
          type: "array",
          description: "Array of schema mutation objects.",
          items: { type: "object" },
        },
        actor: {
          type: "string",
          description: "Audit actor label. Defaults to mcp.",
        },
        reason: {
          type: "string",
          description: "Optional audit reason.",
        },
        dry_run: {
          type: "boolean",
          description:
            "Preview WITHOUT writing: the pack that would result plus its diff, same validator rejections, no config write, no audit record. Absent by default.",
        },
      },
      required: ["mutations"],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      let mutations: SchemaMutation[];
      let actor: string;
      let reason: string | undefined;
      let dryRun: boolean;
      try {
        mutations = coerceSchemaMutations(args["mutations"]);
        actor = coerceStr(args, "actor", false, "mcp")!;
        reason = coerceStr(args, "reason", false) ?? undefined;
        dryRun = coerceBool(args, "dry_run");
      } catch (err) {
        throw new MCPError(INVALID_PARAMS, (err as Error).message);
      }
      // The preview shape carries no `audit_path` and no `applied` count, so
      // a dry run can never be read back as a mutation that landed.
      if (dryRun) return previewSchemaMutations(ctx.vault, mutations);
      return await applySchemaAdminMutations(ctx.vault, mutations, {
        actor,
        reason,
      });
    },
  },
];
