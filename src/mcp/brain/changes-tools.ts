/**
 * `brain_changes`: the change probe over the brain store (design D5, task
 * 1.9). One builder serves both front doors, this tool and
 * `o2b brain changes --since <watermark>`; see
 * `../../core/search/brain-store/changes.ts` for the watermark contract.
 *
 * It is a cheap poll for agents and hooks: an index query after catch-up,
 * returning record ids only, never bodies. Below local reach it answers
 * nothing, by name: brain store records reach local callers only, the
 * same rule search applies to them (`isPathReadableAtReach`).
 */

import {
  brainChanges,
  CHANGES_DEFAULT_LIMIT,
  CHANGES_MAX_LIMIT,
  type BrainChanges,
} from "../../core/search/brain-store/changes.ts";
import { resolveSearchConfig } from "../../core/search/index.ts";
import { SearchError } from "../../core/search/types.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../core/graph/transport-reach.ts";
import { coerceInt, coerceStr } from "../coerce.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import {
  contextReach,
  contextVault,
  type ServerContext,
  type ToolDefinition,
} from "../tool-contract.ts";

/** The reason a probe below local reach names. */
export const CHANGES_REACH_REASON = "reach" as const;

/** The answer a caller below local reach receives. */
export interface BrainChangesRefusal {
  readonly measured: false;
  readonly reason: typeof CHANGES_REACH_REASON;
  readonly detail: string;
}

export type BrainChangesView = (BrainChanges & { readonly measured: true }) | BrainChangesRefusal;

export interface BuildBrainChangesOptions {
  /** The vault, or `null` with none: the index is then keyed by the store id (D14). */
  readonly vault: string | null;
  readonly reach: TransportReach;
  readonly configPath?: string;
  readonly since?: string;
  readonly limit?: number;
}

/** Run the probe, or name the reach refusal. Throws `SearchError` for bad input. */
export async function buildBrainChanges(opts: BuildBrainChangesOptions): Promise<BrainChangesView> {
  if (opts.reach !== TRANSPORT_REACH.local) {
    return {
      measured: false,
      reason: CHANGES_REACH_REASON,
      detail: "brain store records are reported at local reach only",
    };
  }
  const config = resolveSearchConfig({
    vault: opts.vault,
    ...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}),
  });
  const changes = await brainChanges(config, {
    ...(opts.since !== undefined ? { since: opts.since } : {}),
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
  });
  return { measured: true, ...changes };
}

async function toolBrainChanges(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const since = coerceStr(args, "since", false) ?? undefined;
  const limit = coerceInt(args, "limit", CHANGES_DEFAULT_LIMIT, 1, CHANGES_MAX_LIMIT);
  try {
    const view = await buildBrainChanges({
      vault: contextVault(ctx),
      reach: contextReach(ctx),
      ...(ctx.configPath ? { configPath: ctx.configPath } : {}),
      ...(since !== undefined ? { since } : {}),
      limit,
    });
    return { ...view };
  } catch (e) {
    if (e instanceof SearchError && e.code === "INVALID_INPUT") {
      throw new MCPError(INVALID_PARAMS, `brain_changes: ${e.message}`);
    }
    throw e;
  }
}

export const CHANGES_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: "brain_changes",
    kind: "read",
    description:
      "Change probe over the brain store: record ids new since a watermark, grouped by partition, stream, scope and topic, with the watermark to pass next. An index query after catch-up; ids only, no bodies. Local reach only.",
    inputSchema: {
      type: "object",
      properties: {
        since: {
          type: "string",
          maxLength: 64,
          description:
            "Watermark from an earlier brain_changes answer. Absent starts from the first record; one from a replaced index starts over with reset: true.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: CHANGES_MAX_LIMIT,
          description: `Most record ids to return (default ${CHANGES_DEFAULT_LIMIT}). A cut page sets truncated: true; pass its watermark to read on.`,
        },
      },
      additionalProperties: false,
    },
    // No previewBudget: the answer is ids only, bounded by `limit`, and
    // it declares its own cut (`truncated` plus the watermark to pass
    // next). A head preview would drop the watermark, which sorts last.
    handler: toolBrainChanges,
  },
]);
