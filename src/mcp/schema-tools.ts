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
import { resolveSearchConfig } from "../core/search/index.ts";
import { INVALID_PARAMS, MCPError } from "./protocol.ts";
import { coerceStr } from "./coerce.ts";
import { MCP_PREVIEW_BUDGET } from "./preview-budget.ts";
import type { ServerContext, ToolDefinition } from "./tool-contract.ts";

// Read-side handlers behind the consolidated `schema_inspect` views.
// The per-view alias tools were removed in 1.0.0 (tombstones in
// `REMOVED_TOOLS`, src/mcp/tools.ts).
const SCHEMA_INSPECT_VIEWS: Readonly<
  Record<string, (ctx: ServerContext, args: Record<string, unknown>) => Promise<unknown> | unknown>
> = Object.freeze({
  graph: (ctx: ServerContext) => buildSchemaGraph(ctx.vault),
  lint: (ctx: ServerContext) =>
    buildSchemaLint(ctx.vault, {
      dbPath: resolveSearchConfig({ vault: ctx.vault, configPath: ctx.configPath ?? undefined })
        .dbPath,
    }),
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
];
