/**
 * Cross-type tombstone + supersede lifecycle MCP tool (Belief lifecycle
 * suite, Track A anchor, t_7d5a3589).
 *
 * One tool, `brain_lifecycle`, dispatching on `action`:
 *   - `tombstone`         mark a memory `_status: tombstoned` in place
 *   - `supersede`         tombstone a predecessor and record its successor
 *   - `temporal-replace`  close one fact and open another at a shared instant
 *   - `tip`               resolve a supersede chain to its live tip
 *   - `curator`           read slices over observed-use verdicts
 *
 * MCP mirror of the `o2b brain lifecycle` CLI verb; both delegate to the
 * core lifecycle module so the on-disk shape cannot drift.
 */

import { everyArtifactRefView } from "../../core/brain/artifact-ref-view.ts";
import { curatorSlices, type CuratorEntry } from "../../core/brain/lifecycle/curator.ts";
import {
  temporalReplace,
  TemporalReplaceError,
} from "../../core/brain/lifecycle/temporal-replace.ts";
import {
  resolveChainTipInVault,
  supersede,
  tombstone,
  TombstoneError,
} from "../../core/brain/lifecycle/tombstone.ts";
import { gatedOwnerScopeView } from "../../core/brain/owner-scope-view.ts";
import { reachView } from "../../core/brain/reach-view.ts";
import { MCP_PREVIEW_BUDGET } from "../preview-budget.ts";
import { contextReach, type ServerContext, type ToolDefinition } from "../tool-contract.ts";
import { coerceStr, unknownOperationError } from "../coerce.ts";
import { readableAtContextReachOrUndefined } from "./reach-readable.ts";
import { coerceNonNegativeInteger, wrapToolErrors } from "./shared.ts";

const TOOL = "brain_lifecycle";

/** Project curator slice rows into the tool's snake_cased response shape. */
function renderCuratorRows(rows: ReadonlyArray<CuratorEntry>): Array<Record<string, unknown>> {
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
  return wrapToolErrors(TOOL, [TombstoneError, TemporalReplaceError], async () => {
    const action = coerceStr(args, "action", true)!;
    const agent = coerceStr(args, "agent", false) ?? undefined;
    // Every write answers at the caller's reach: a page it may not read is
    // refused as a missing one, before anything is written.
    const readable = readableAtContextReachOrUndefined(ctx);
    const reachOpt = readable !== undefined ? { readable } : {};

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
          ...reachOpt,
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
          ...reachOpt,
        });
        return {
          action,
          changed: res.changed,
          path: res.path,
          superseded_by: res.state.supersededBy,
        };
      }
      case "temporal-replace": {
        const predecessor = coerceStr(args, "predecessor", true)!;
        const successor = coerceStr(args, "successor", true)!;
        const at = coerceStr(args, "at", true)!;
        const res = temporalReplace({
          vault: ctx.vault,
          predecessor,
          successor,
          at,
          ...(agent ? { agent } : {}),
          ...reachOpt,
        });
        return {
          action,
          at: res.at,
          predecessor: res.predecessor,
          successor: res.successor,
          agent: res.agent,
        };
      }
      case "tip": {
        const id = coerceStr(args, "id", true)!;
        // A page the caller may not read is no chain node: it reads as an
        // unknown id, and a walk never steps onto or through it.
        const res = resolveChainTipInVault(ctx.vault, id, reachOpt);
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
        // A row's key is the page path or the memory id; a row naming a
        // page the caller may not see is left out.
        const view = everyArtifactRefView(
          gatedOwnerScopeView(ctx.vault, ctx.agentName),
          reachView(ctx.vault, contextReach(ctx)),
        );
        const rows = (entries: ReadonlyArray<CuratorEntry>) =>
          renderCuratorRows(view.keep(entries, (e) => [e.key]));
        return {
          action,
          injected_never_used: rows(slices.injectedNeverUsed),
          contradicted: rows(slices.contradicted),
          high_used: rows(slices.highUsed),
        };
      }
      default:
        throw unknownOperationError(
          `${TOOL}: 'action' must be one of tombstone, supersede, temporal-replace, tip, curator`,
        );
    }
  });
}

export const LIFECYCLE_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: TOOL,
    description:
      "Cross-type lifecycle. action: tombstone marks a memory tombstoned in place (kept for audit); supersede tombstones a predecessor and links a successor; temporal-replace closes one fact and opens a successor at a shared instant; tip resolves a chain tip; curator slices observed-use verdicts.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["tombstone", "supersede", "temporal-replace", "tip", "curator"],
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
          description:
            "supersede/temporal-replace: vault-relative path of the predecessor being replaced.",
        },
        successor: {
          type: "string",
          description:
            "supersede: successor id/wikilink. temporal-replace: vault-relative path of the successor.",
        },
        at: {
          type: "string",
          description:
            "temporal-replace: shared instant T (ISO-8601 UTC instant or YYYY-MM-DD date).",
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
