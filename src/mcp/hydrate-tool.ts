/**
 * Two-pass tool catalog hydration (Agent Surface Suite, t_e8011a89).
 *
 * Under the `catalog` scope the server advertises a compact first-pass
 * surface; every other tool keeps the token-diet `hidden` semantics -
 * callable via `tools/call`, absent from `tools/list`. `tool_hydrate`
 * is the second pass: with no arguments it returns the deterministic
 * sorted catalog (name, one-line description, group), and with a
 * `names` batch it returns the full input/output schemas for exactly
 * the requested tools. Unknown names are reported per-name; one typo
 * never fails the batch.
 *
 * The MCP server is static per process (no `listChanged`), so hydrated
 * schemas arrive as tool-result data rather than a mutated tools/list -
 * the closest faithful mapping of upstream two-pass hydration onto
 * this transport.
 */

import { toolDescriptors } from "../core/surface/descriptor.ts";
import { coerceStrList } from "./coerce.ts";
import type { ToolDefinition } from "./tool-contract.ts";

export const TOOL_HYDRATE_NAME = "tool_hydrate";

/**
 * Build the `tool_hydrate` definition over a late-bound tool table.
 * The getter indirection avoids a module cycle: `tools.ts` assembles
 * the table and hands it to this builder, which only dereferences it
 * inside the handler (by which time the table is complete, including
 * this very tool).
 */
export function buildHydrateTool(getTable: () => ReadonlyArray<ToolDefinition>): ToolDefinition {
  return {
    name: TOOL_HYDRATE_NAME,
    description:
      "Two-pass tool discovery: no arguments returns the compact tool catalog (name, one-line description, group); names returns full schemas for the requested tools. Hidden tools stay callable via tools/call.",
    inputSchema: {
      type: "object",
      properties: {
        names: {
          type: "array",
          items: { type: "string" },
          description: "Tool names to hydrate full schemas for. Omit to get the catalog.",
        },
      },
      additionalProperties: false,
    },
    handler: (_ctx, args) => {
      const table = getTable();
      const names = coerceStrList(args, "names");
      if (names.length === 0) {
        const catalog = toolDescriptors(table);
        return {
          count: catalog.length,
          catalog: catalog.map((d) => ({
            name: d.name,
            description: d.description,
            group: d.group,
          })),
        };
      }
      const byName = new Map(table.map((t) => [t.name, t]));
      const hydrated: Record<string, unknown>[] = [];
      const unknown: string[] = [];
      for (const name of names) {
        const tool = byName.get(name);
        if (tool === undefined) {
          unknown.push(name);
          continue;
        }
        hydrated.push({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
        });
      }
      return { tools: hydrated, unknown };
    },
  };
}
