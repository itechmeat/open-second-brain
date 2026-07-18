/**
 * Tension-object lifecycle MCP tool (Belief lifecycle suite, S2,
 * t_0e3f2bee).
 *
 * One tool, `brain_tension`, dispatching on `action`:
 *   - `detect`    scan the note corpus and persist detected contradictions
 *   - `list`      list persisted tensions (optionally unresolved only)
 *   - `show`      read one tension
 *   - `confirm`   open -> confirmed
 *   - `dismiss`   open|confirmed -> dismissed
 *   - `resolve`   open|confirmed -> resolved
 *
 * MCP mirror of the `o2b brain tension` CLI verb; both delegate to the
 * core tensions module so the on-disk shape cannot drift.
 */

import {
  confirmTension,
  detectTensionsInVault,
  dismissTension,
  listTensions,
  listUnresolvedTensions,
  resolveTension,
  showTension,
  TensionError,
  type TensionRecord,
} from "../../core/brain/tensions.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import { MCP_PREVIEW_BUDGET } from "../preview-budget.ts";
import type { ServerContext, ToolDefinition } from "../tool-contract.ts";
import { coerceBool, coerceStr } from "../coerce.ts";
import { wrapToolErrors } from "./shared.ts";

const TOOL = "brain_tension";

/** Project a tension record into the tool's snake_cased response shape. */
function renderRow(t: TensionRecord): Record<string, unknown> {
  return {
    id: t.id,
    slug: t.slug,
    status: t.status,
    subject_a: t.subjectA,
    subject_b: t.subjectB,
    stance_a: t.stanceA,
    stance_b: t.stanceB,
    detected_count: t.detectedCount,
    resolution_reason: t.resolutionReason,
  };
}

async function toolBrainTension(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return wrapToolErrors(TOOL, [TensionError], async () => {
    const action = coerceStr(args, "action", true)!;
    const agent = coerceStr(args, "agent", false) ?? undefined;
    const reason = coerceStr(args, "reason", false) ?? undefined;

    switch (action) {
      case "detect":
      case "scan": {
        const rawJaccard = args["jaccard"];
        let jaccard: number | undefined;
        if (rawJaccard !== undefined && rawJaccard !== null) {
          if (typeof rawJaccard !== "number" || !Number.isFinite(rawJaccard)) {
            throw new MCPError(INVALID_PARAMS, `${TOOL}: 'jaccard' must be a number`);
          }
          if (rawJaccard <= 0 || rawJaccard > 1) {
            throw new MCPError(INVALID_PARAMS, `${TOOL}: 'jaccard' must be in (0, 1]`);
          }
          jaccard = rawJaccard;
        }
        const res = detectTensionsInVault(ctx.vault, {
          ...(jaccard !== undefined ? { jaccard } : {}),
          ...(agent ? { agent } : {}),
        });
        return {
          action,
          created: res.created,
          updated: res.updated,
          scanned_files: res.scannedFiles,
          tensions: res.records.map(renderRow),
        };
      }
      case "list": {
        const unresolved = coerceBool(args, "unresolved");
        const rows = unresolved ? listUnresolvedTensions(ctx.vault) : listTensions(ctx.vault);
        return { action, tensions: rows.map(renderRow) };
      }
      case "show": {
        const slug = coerceStr(args, "slug", true)!;
        const t = showTension(ctx.vault, slug);
        if (t === null) throw new TensionError(`no tension: ${slug}`);
        return {
          action,
          ...renderRow(t),
          subject: t.subject,
          jaccard: t.jaccard,
          quote_a: t.quoteA,
          quote_b: t.quoteB,
          created_at: t.createdAt,
          detected_at: t.detectedAt,
          status_changed_at: t.statusChangedAt,
        };
      }
      case "confirm":
      case "dismiss":
      case "resolve": {
        const slug = coerceStr(args, "slug", true)!;
        const opts = {
          ...(reason ? { reason } : {}),
          ...(agent ? { agent } : {}),
        };
        const fn =
          action === "confirm"
            ? confirmTension
            : action === "dismiss"
              ? dismissTension
              : resolveTension;
        const t = fn(ctx.vault, slug, opts);
        return { action, ...renderRow(t) };
      }
      default:
        throw new MCPError(
          INVALID_PARAMS,
          `${TOOL}: 'action' must be one of detect, list, show, confirm, dismiss, resolve`,
        );
    }
  });
}

export const TENSION_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: TOOL,
    description:
      "Persisted-contradiction (tension) lifecycle. action: detect scans notes.read_paths and persists contradictions as open tensions (idempotent); list/show read; confirm=open->confirmed; dismiss/resolve close. Invalid transitions error. Unresolved tensions warn at context-pack injection.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["detect", "list", "show", "confirm", "dismiss", "resolve"],
          description: "Which tension operation to run.",
        },
        slug: {
          type: "string",
          description: "show/confirm/dismiss/resolve: the tension slug.",
        },
        jaccard: {
          type: "number",
          description:
            "detect: minimum prose token overlap (0, 1] for two notes to count as the same subject. Defaults to the shared health threshold.",
        },
        unresolved: {
          type: "boolean",
          description: "list: return only open/confirmed (unresolved) tensions.",
        },
        reason: {
          type: "string",
          description: "dismiss/resolve: operator reason recorded on the transition.",
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
    handler: toolBrainTension,
  },
]);
