/**
 * Workspace intent chains and the proactive trigger queue.
 *
 * Extracted from the former brain-tools.ts monolith; registration
 * happens through the aggregator, which preserves the public
 * BRAIN_TOOLS surface.
 */

import { resolveAgentName, resolveTriggerCooldownDays } from "../../core/config.ts";
import { scanTriggers } from "../../core/brain/triggers/scan.ts";
import { listTriggers, transitionTrigger } from "../../core/brain/triggers/store.ts";
import { isTriggerStatus, type TriggerRecord } from "../../core/brain/triggers/types.ts";
import {
  listIntentions,
  moveIntentionToHistory,
  setIntention,
  showIntention,
} from "../../core/brain/intentions.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import type { ServerContext, ToolDefinition } from "../tools.ts";
import { MCP_PREVIEW_BUDGET } from "../preview-budget.ts";
import { coerceStr } from "../coerce.ts";

function toolBrainIntention(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const operation = coerceStr(args, "operation", true)!;
  if (operation === "list") {
    return {
      intentions: listIntentions(ctx.vault).map((chain) => ({
        scope: chain.scope,
        version: chain.version,
        updated_at: chain.updatedAt,
        text: chain.text,
      })),
    };
  }
  const scope = coerceStr(args, "scope", true)!;
  if (operation === "set") {
    const text = coerceStr(args, "text", true)!;
    const chain = setIntention(ctx.vault, {
      scope,
      text,
      agent: resolveAgentName(ctx.configPath ?? undefined),
    });
    return { operation, scope: chain.scope, version: chain.version, path: chain.path };
  }
  if (operation === "show") {
    const chain = showIntention(ctx.vault, scope);
    if (chain === null) return { operation, scope, present: false };
    return {
      operation,
      scope: chain.scope,
      present: true,
      version: chain.version,
      updated_at: chain.updatedAt,
      text: chain.text,
      history: chain.history,
      path: chain.path,
    };
  }
  if (operation === "move") {
    const moved = moveIntentionToHistory(ctx.vault, { scope });
    return { operation, scope: moved.scope, archive_path: moved.archivePath };
  }
  throw new MCPError(
    INVALID_PARAMS,
    "brain_intention operation must be one of: set, show, list, move",
  );
}

// ----- brain_trigger (Workspace Insight Suite) ------------------------------

function triggerToJson(record: TriggerRecord): Record<string, unknown> {
  return {
    id: record.id,
    kind: record.kind,
    status: record.effectiveStatus,
    urgency: record.urgency,
    reason: record.reason,
    suggested_action: record.suggestedAction,
    source_artifacts: record.sourceArtifacts,
    cooldown_key: record.cooldownKey,
    created_at: record.createdAt,
    expires_at: record.expiresAt,
    delivered_at: record.deliveredAt,
    resolved_at: record.resolvedAt,
  };
}

const TRIGGER_TERMINAL = new Set(["acted", "dismissed", "expired"]);

function toolBrainTrigger(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const operation = coerceStr(args, "operation", true)!;
  const now = new Date();
  if (operation === "scan") {
    const cooldownDays = resolveTriggerCooldownDays(ctx.configPath ?? undefined);
    const result = scanTriggers(ctx.vault, { now, cooldownDays });
    return {
      operation,
      candidates: result.candidates,
      created: result.created.map(triggerToJson),
      skipped: result.skipped.map((skip) => ({
        cooldown_key: skip.cooldownKey,
        reason: skip.reason,
      })),
    };
  }
  if (operation === "list" || operation === "history") {
    const statusRaw = coerceStr(args, "status", false);
    if (statusRaw !== null && statusRaw !== undefined && !isTriggerStatus(statusRaw)) {
      throw new MCPError(INVALID_PARAMS, `brain_trigger: unknown status '${statusRaw}'`);
    }
    let records = listTriggers(ctx.vault, {
      now,
      ...(statusRaw ? { status: statusRaw } : {}),
    });
    if (operation === "history") {
      records = records.filter((record) => TRIGGER_TERMINAL.has(record.effectiveStatus));
    } else if (!statusRaw) {
      records = records.filter((record) => !TRIGGER_TERMINAL.has(record.effectiveStatus));
    }
    return { operation, triggers: records.map(triggerToJson) };
  }
  if (operation === "acknowledge" || operation === "dismiss" || operation === "act") {
    const id = coerceStr(args, "id", true)!;
    try {
      return {
        operation,
        trigger: triggerToJson(transitionTrigger(ctx.vault, id, operation, { now })),
      };
    } catch (err) {
      throw new MCPError(INVALID_PARAMS, `brain_trigger: ${(err as Error).message}`);
    }
  }
  throw new MCPError(
    INVALID_PARAMS,
    "brain_trigger operation must be one of: scan, list, history, acknowledge, dismiss, act",
  );
}

// ----- brain_deep_synthesis (Workspace Insight Suite) -----------------------

export const WORKSPACE_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: "brain_intention",
    description:
      "Scoped current-intention chains under Brain/intentions/: set updates a workstream's now-document (prior text lands in its history trail), show/list read, move retires the chain into history/.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["set", "show", "list", "move"],
          description: "Operation to perform.",
        },
        scope: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description: "Workstream or session label (normalised to a scope slug).",
        },
        text: {
          type: "string",
          minLength: 1,
          maxLength: 4000,
          description: "Intention text for the set operation.",
        },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    previewBudget: MCP_PREVIEW_BUDGET,
    handler: toolBrainIntention,
  },
  {
    name: "brain_trigger",
    description:
      "Grounded proactive trigger queue under Brain/triggers/: scan generates deduped triggers from health/retention data, list/history read by lifecycle status, acknowledge/dismiss/act transition one trigger. Anti-nag: cooldown keys keep the same issue from reappearing every run.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["scan", "list", "history", "acknowledge", "dismiss", "act"],
          description: "Operation to perform.",
        },
        id: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description: "Trigger id for acknowledge/dismiss/act.",
        },
        status: {
          type: "string",
          enum: ["pending", "delivered", "acknowledged", "acted", "dismissed", "expired"],
          description: "Effective-status filter for list.",
        },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    previewBudget: MCP_PREVIEW_BUDGET,
    handler: toolBrainTrigger,
  },
]);
