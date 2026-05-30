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
import type { ToolDefinition } from "./tools.ts";

export const SCHEMA_TOOLS: ReadonlyArray<ToolDefinition> = [
  {
    name: "get_active_schema_pack",
    description: "Return the active Brain schema pack from Brain/_brain.yaml. Read-only.",
    inputSchema: emptySchema(),
    handler: (ctx) => getActiveSchemaPack(ctx.vault),
  },
  {
    name: "list_schema_packs",
    description: "List available Brain schema packs. Read-only.",
    inputSchema: emptySchema(),
    handler: (ctx) => listSchemaPacks(ctx.vault),
  },
  {
    name: "schema_stats",
    description: "Return Brain schema declaration, usage, metadata, and finding counts. Read-only.",
    inputSchema: emptySchema(),
    handler: (ctx) => buildSchemaStats(ctx.vault),
  },
  {
    name: "schema_lint",
    description:
      "Return schema lint findings for unknown tokens and unused declarations. Read-only.",
    inputSchema: emptySchema(),
    handler: (ctx) => buildSchemaLint(ctx.vault),
  },
  {
    name: "schema_graph",
    description:
      "Return schema graph nodes and edges for types, aliases, prefixes, and routing. Read-only.",
    inputSchema: emptySchema(),
    handler: (ctx) => buildSchemaGraph(ctx.vault),
  },
  {
    name: "schema_explain_type",
    description:
      "Explain one schema token across declarations, usage, aliases, prefixes, and routing. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "Schema token to explain." },
      },
      required: ["token"],
      additionalProperties: false,
    },
    handler: (ctx, args) => explainSchemaToken(ctx.vault, coerceStr(args, "token")!),
  },
  {
    name: "schema_review_orphans",
    description: "Return declared schema tokens that are currently unused. Read-only.",
    inputSchema: emptySchema(),
    handler: (ctx) => reviewSchemaOrphans(ctx.vault),
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
  {
    name: "reload_schema_pack",
    description: "Reload and return the active Brain schema pack from disk. Read-only.",
    inputSchema: emptySchema(),
    handler: (ctx) => getActiveSchemaPack(ctx.vault),
  },
];

function emptySchema(): Record<string, unknown> {
  return { type: "object", properties: {}, additionalProperties: false };
}
