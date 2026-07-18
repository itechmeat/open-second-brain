/**
 * Cross-type tombstone + supersede lifecycle MCP tool (Belief lifecycle
 * suite, Track A anchor, t_7d5a3589).
 *
 * One tool, `brain_lifecycle`, dispatching on `action`:
 *   - `tombstone`  mark a memory `_status: tombstoned` in place
 *   - `supersede`  tombstone a predecessor and record its successor
 *   - `tip`        resolve a supersede chain to its live tip
 *   - `curator`    read slices over observed-use verdicts
 *
 * MCP mirror of the `o2b brain lifecycle` CLI verb; both delegate to the
 * core lifecycle module so the on-disk shape cannot drift.
 */

import { curatorSlices } from "../../core/brain/lifecycle/curator.ts";
import {
  resolveChainTipInVault,
  supersede,
  tombstone,
  TombstoneError,
} from "../../core/brain/lifecycle/tombstone.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import { MCP_PREVIEW_BUDGET } from "../preview-budget.ts";
import type { ServerContext, ToolDefinition } from "../tool-contract.ts";
import { coerceStr } from "../coerce.ts";
import { coerceNonNegativeInteger, wrapToolErrors } from "./shared.ts";

const TOOL = "brain_lifecycle";

/** Project curator slice rows into the tool's snake_cased response shape. */
function renderCuratorRows(
  rows: ReadonlyArray<{
    key: string;
    reuse: { used: number; ignored: number; contradicted: number };
  }>,
): Array<Record<string, unknown>> {
  return rows.map((r) => ({
    key: r.key,
    used: r.reuse.used,
    ignored: r.reuse.ignored,
    contradicted: r.reuse.contradicted,
  }));
}

async function toolBrainLifecycle(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return wrapToolErrors(TOOL, [TombstoneError], async () => {
    const action = coerceStr(args, "action", true)!;
    const agent = coerceStr(args, "agent", false) ?? undefined;

    switch (action) {
      case "tombstone": {
        const path = coerceStr(args, "path", true)!;
        const reason = coerceStr(args, "reason", true)!;
        const supersededBy = coerceStr(args, "superseded_by", false) ?? undefined;
        const res = tombstone({
          vault: ctx.vault,
          path,
          reason,
          ...(supersededBy ? { supersededBy } : {}),
          ...(agent ? { agent } : {}),
        });
        return {
          action,
          changed: res.changed,
          path: res.path,
          tombstoned: res.state.tombstoned,
          superseded_by: res.state.supersededBy,
        };
      }
      case "supersede": {
        const predecessor = coerceStr(args, "predecessor", true)!;
        const successor = coerceStr(args, "successor", true)!;
        const reason = coerceStr(args, "reason", false) ?? undefined;
        const res = supersede({
          vault: ctx.vault,
          predecessor,
          successor,
          ...(reason ? { reason } : {}),
          ...(agent ? { agent } : {}),
        });
        return {
          action,
          changed: res.changed,
          path: res.path,
          superseded_by: res.state.supersededBy,
        };
      }
      case "tip": {
        const id = coerceStr(args, "id", true)!;
        const res = resolveChainTipInVault(ctx.vault, id);
        return {
          action,
          tip: res.tip,
          steps: res.steps,
          cycle: res.cycle,
          resolved_all: res.resolvedAll,
        };
      }
      case "curator": {
        const highUseMin = coerceNonNegativeInteger(TOOL, "high_use_min", args["high_use_min"]);
        const slices = curatorSlices(ctx.vault, highUseMin !== undefined ? { highUseMin } : {});
        return {
          action,
          injected_never_used: renderCuratorRows(slices.injectedNeverUsed),
          contradicted: renderCuratorRows(slices.contradicted),
          high_used: renderCuratorRows(slices.highUsed),
        };
      }
      default:
        throw new MCPError(
          INVALID_PARAMS,
          `${TOOL}: 'action' must be one of tombstone, supersede, tip, curator`,
        );
    }
  });
}

export const LIFECYCLE_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: TOOL,
    description:
      "Cross-type tombstone + supersede lifecycle. action: tombstone marks a memory `_status: tombstoned` in place (leaves recall/inject/active.md, kept for audit); supersede tombstones a predecessor and points it at a successor; tip resolves a chain to its tip; curator slices observed-use verdicts.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["tombstone", "supersede", "tip", "curator"],
          description: "Which lifecycle operation to run.",
        },
        path: {
          type: "string",
          description: "tombstone: vault-relative path of the target memory file.",
        },
        reason: {
          type: "string",
          description: "tombstone/supersede: operator-facing reason for the change.",
        },
        superseded_by: {
          type: "string",
          description: "tombstone: optional successor id/wikilink stored as superseded_by.",
        },
        predecessor: {
          type: "string",
          description: "supersede: vault-relative path of the predecessor being replaced.",
        },
        successor: {
          type: "string",
          description: "supersede: successor id/wikilink that supersedes the predecessor.",
        },
        id: { type: "string", description: "tip: id/wikilink whose chain tip to resolve." },
        high_use_min: {
          type: "integer",
          minimum: 0,
          description: "curator: minimum USED count for the high-used slice.",
        },
        agent: {
          type: "string",
          description: "Optional agent identity override; defaults to the server-resolved name.",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    previewBudget: MCP_PREVIEW_BUDGET,
    handler: toolBrainLifecycle,
  },
]);
