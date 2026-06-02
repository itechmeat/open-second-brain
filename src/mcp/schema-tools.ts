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
import type { SchemaMutation } from "../core/brain/schema-mutate.ts";
import { INVALID_PARAMS, MCPError } from "./protocol.ts";
import { coerceStr } from "./coerce.ts";
import { MCP_PREVIEW_BUDGET } from "./preview-budget.ts";
import { deprecatedAlias, type ServerContext, type ToolDefinition } from "./tools.ts";

// Read-side handlers shared by the consolidated `schema_inspect` and
// its deprecated per-view aliases (token-diet, t_3920db77).
const SCHEMA_INSPECT_VIEWS: Readonly<
  Record<string, (ctx: ServerContext, args: Record<string, unknown>) => Promise<unknown> | unknown>
> = Object.freeze({
  graph: (ctx: ServerContext) => buildSchemaGraph(ctx.vault),
  lint: (ctx: ServerContext) => buildSchemaLint(ctx.vault),
  stats: (ctx: ServerContext) => buildSchemaStats(ctx.vault),
  orphans: (ctx: ServerContext) => reviewSchemaOrphans(ctx.vault),
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
    throw new Error(
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
  deprecatedAlias({
    name: "get_active_schema_pack",
    target: "schema_inspect",
    view: "active_pack",
    handler: SCHEMA_INSPECT_VIEWS["active_pack"]!,
  }),
  deprecatedAlias({
    name: "list_schema_packs",
    target: "schema_inspect",
    view: "packs",
    handler: SCHEMA_INSPECT_VIEWS["packs"]!,
  }),
  deprecatedAlias({
    name: "schema_stats",
    target: "schema_inspect",
    view: "stats",
    handler: SCHEMA_INSPECT_VIEWS["stats"]!,
  }),
  deprecatedAlias({
    name: "schema_lint",
    target: "schema_inspect",
    view: "lint",
    handler: SCHEMA_INSPECT_VIEWS["lint"]!,
  }),
  deprecatedAlias({
    name: "schema_graph",
    target: "schema_inspect",
    view: "graph",
    handler: SCHEMA_INSPECT_VIEWS["graph"]!,
  }),
  deprecatedAlias({
    name: "schema_explain_type",
    target: "schema_inspect",
    view: "explain_type",
    handler: SCHEMA_INSPECT_VIEWS["explain_type"]!,
  }),
  deprecatedAlias({
    name: "schema_review_orphans",
    target: "schema_inspect",
    view: "orphans",
    handler: SCHEMA_INSPECT_VIEWS["orphans"]!,
  }),
  {
    name: "schema_apply_mutations",
    description:
      "Apply an atomic batch of schema mutations to Brain/_brain.yaml and write an audit record.",
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
      },
      required: ["mutations"],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      let mutations: SchemaMutation[];
      let actor: string;
      let reason: string | undefined;
      try {
        mutations = coerceSchemaMutations(args["mutations"]);
        actor = coerceStr(args, "actor", false, "mcp")!;
        reason = coerceStr(args, "reason", false) ?? undefined;
      } catch (err) {
        throw new MCPError(INVALID_PARAMS, (err as Error).message);
      }
      return await applySchemaAdminMutations(ctx.vault, mutations, {
        actor,
        reason,
      });
    },
  },
  deprecatedAlias({
    name: "reload_schema_pack",
    target: "schema_inspect",
    view: "active_pack",
    handler: SCHEMA_INSPECT_VIEWS["active_pack"]!,
  }),
];
