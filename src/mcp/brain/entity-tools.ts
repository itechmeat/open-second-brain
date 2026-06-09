/**
 * Canonical entity registry lookups and vault profile switching.
 *
 * Extracted from the former brain-tools.ts monolith; registration
 * happens through the aggregator, which preserves the public
 * BRAIN_TOOLS surface.
 */

import {
  EntityAmbiguityError,
  getEntity,
  listEntities,
} from "../../core/brain/entities/registry.ts";
import { validateEntityCategory } from "../../core/brain/entities/canonical.ts";
import { switchProfile, listProfiles } from "../../core/brain/portability/profiles.ts";
import { defaultConfigPath } from "../../core/config.ts";
import { INTERNAL_ERROR, INVALID_PARAMS, MCPError } from "../protocol.ts";
import type { ServerContext, ToolDefinition } from "../tools.ts";
import { MCP_PREVIEW_BUDGET } from "../preview-budget.ts";
import { coerceStr } from "../coerce.ts";

/** Serialize one entity for the MCP payload (no absolute paths). */
function entityToPayload(
  entity: import("../../core/brain/entities/types.ts").BrainEntity,
): Record<string, unknown> {
  return {
    id: entity.id,
    category: entity.category,
    name: entity.name,
    aliases: [...entity.aliases],
    status: entity.status,
    ...(entity.source_agent !== undefined ? { source_agent: entity.source_agent } : {}),
    ...(entity.confidence !== undefined ? { confidence: entity.confidence } : {}),
    created_at: entity.created_at,
    updated_at: entity.updated_at,
    ...(entity.archived_at !== undefined ? { archived_at: entity.archived_at } : {}),
    relations: entity.relations.map((r) => ({ relation: r.relation, target: r.target })),
    body: entity.body,
  };
}

async function toolBrainEntity(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // Argument validation happens at the boundary so INVALID_PARAMS is
  // reserved for genuine client-input errors; unexpected registry
  // failures (malformed entity file, I/O) surface as INTERNAL_ERROR.
  const view = coerceStr(args, "view", true)!;
  if (view !== "get" && view !== "list") {
    throw new MCPError(INVALID_PARAMS, `brain_entity: unknown view '${view}' (get | list)`);
  }
  const category = coerceStr(args, "category", false);
  if (category !== null) {
    try {
      validateEntityCategory(category);
    } catch (err) {
      throw new MCPError(INVALID_PARAMS, `brain_entity: ${(err as Error).message}`);
    }
  }
  const status = coerceStr(args, "status", false);
  if (status !== null && status !== "active" && status !== "archived") {
    throw new MCPError(INVALID_PARAMS, "brain_entity: status must be 'active' or 'archived'");
  }
  const query = view === "get" ? coerceStr(args, "query", true)! : null;

  try {
    if (view === "get") {
      const entity = getEntity(ctx.vault, {
        query: query!,
        ...(category !== null ? { category } : {}),
      });
      if (entity === null) return { found: false, query: query! };
      return { found: true, ...entityToPayload(entity) };
    }
    const entities = listEntities(ctx.vault, {
      ...(category !== null ? { category } : {}),
      ...(status !== null ? { status } : {}),
    });
    return { entities: entities.map(entityToPayload), total: entities.length };
  } catch (err) {
    if (err instanceof MCPError) throw err;
    if (err instanceof EntityAmbiguityError) {
      // A category-less query hitting several categories is a
      // client-resolvable input problem, not a server fault.
      throw new MCPError(INVALID_PARAMS, `brain_entity: ${err.message}`);
    }
    throw new MCPError(INTERNAL_ERROR, `brain_entity: ${(err as Error).message}`);
  }
}

async function toolBrainSwitchVault(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const name = coerceStr(args, "name", true)!;
  const configPath = ctx.configPath ?? defaultConfigPath();
  try {
    switchProfile(configPath, name);
  } catch (err) {
    throw new Error(`brain_switch_vault: ${(err as Error).message ?? String(err)}`, {
      cause: err,
    });
  }
  // The running server keeps its already-resolved vault; the switch
  // takes effect for the next server launch / CLI invocation.
  return {
    active: name,
    profiles: listProfiles(configPath).profiles,
    note: "active profile updated; takes effect on next server launch",
  };
}

// ----- brain_doctor --------------------------------------------------------

export const ENTITY_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: "brain_entity",
    previewBudget: MCP_PREVIEW_BUDGET,
    description:
      "Look up (view: get) or list (view: list) canonical entities from the Brain/entities/ registry. Aliases resolve to the canonical record. Read-only; writes go through the o2b CLI.",
    inputSchema: {
      type: "object",
      properties: {
        view: {
          type: "string",
          enum: ["get", "list"],
          description: "get: resolve one entity by name or alias. list: enumerate the registry.",
        },
        query: {
          type: "string",
          description: "Name or alias to resolve (required for view: get).",
        },
        category: {
          type: "string",
          description: "Optional category filter (slug, e.g. `people`).",
        },
        status: {
          type: "string",
          enum: ["active", "archived"],
          description: "Optional status filter for view: list.",
        },
      },
      required: ["view"],
      additionalProperties: false,
    },
    handler: toolBrainEntity,
  },
  {
    name: "brain_switch_vault",
    description:
      "Activate a named vault profile (from the profiles registry). Updates the active pointer; the change takes effect on the next server launch - the running server keeps its already-resolved vault.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Profile name to activate." },
      },
      required: ["name"],
      additionalProperties: false,
    },
    handler: toolBrainSwitchVault,
  },
]);
