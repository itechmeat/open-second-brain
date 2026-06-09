/**
 * Context packing surfaces: token-budgeted context pack, context
 * receipts, preset diagnostics, and the pre-compress / pre-compact
 * extraction paths.
 *
 * Extracted from the former brain-tools.ts monolith; registration
 * happens through the aggregator, which preserves the public
 * BRAIN_TOOLS surface.
 */

import { resolveSearchFocusContextPack } from "../../core/config.ts";
import { resolveSearchConfig } from "../../core/search/index.ts";
import { readActiveSessionFocus } from "../../core/search/session-focus.ts";
import { packContext } from "../../core/brain/context-pack.ts";
import { buildPreCompressPack } from "../../core/brain/pre-compress-pack.ts";
import {
  getContextReceipt,
  isContextReceiptTrigger,
  listContextReceipts,
  summarizeContextReceipt,
  type ContextReceiptOptions,
} from "../../core/brain/context-receipts.ts";
import {
  diffContextPreset,
  getContextPreset,
  listContextPresets,
  suggestContextPreset,
  type ContextPresetCurrentConfig,
} from "../../core/brain/context-presets.ts";
import { extractPreCompactRecords } from "../../core/brain/pre-compact-extract.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import type { ServerContext, ToolDefinition } from "../tools.ts";
import { MCP_PREVIEW_BUDGET } from "../preview-budget.ts";
import { coerceStr, coerceStrList, coerceBool } from "../coerce.ts";
import {
  coercePositiveInteger,
  optionalPositiveInt,
  optionalStringArg,
  requiredStringArg,
  telemetryOptionsFromArgs,
} from "./shared.ts";

/**
 * Bounded-token vault slice ordered by importance tier then recency.
 * Lets an agent prime its context window under a strict budget.
 */
async function toolBrainContextPack(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const maxRaw = args["max_tokens"];
  const maxTokens =
    typeof maxRaw === "number"
      ? maxRaw
      : typeof maxRaw === "string" && /^[0-9]+$/.test(maxRaw.trim())
        ? Number.parseInt(maxRaw.trim(), 10)
        : Number.NaN;
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    throw new MCPError(INVALID_PARAMS, "brain_context_pack: max_tokens must be a positive integer");
  }
  const query = typeof args["query"] === "string" ? (args["query"] as string) : undefined;
  const includeLanes = coerceBool(args, "lanes");
  const cacheStable = coerceBool(args, "cache_stable");
  const dedupRepeated = coerceBool(args, "dedup_repeated");
  const attentionFlowIds = coerceStrList(args, "attention_flow_ids");
  const maxCharsPerMemory = optionalPositiveInt(args, "max_chars_per_memory", "brain_context_pack");
  const maxTotalChars = optionalPositiveInt(args, "max_total_chars", "brain_context_pack");
  const receipt = receiptOptionsFromArgs("brain_context_pack", args, "context_pack", "mcp");
  const telemetry = telemetryOptionsFromArgs("brain_context_pack", args, "mcp");
  // Focus wiring (Agent Surface Suite, t_5b478e47): gated on the
  // search_focus_context_pack config key (default off) so the default
  // pack stays byte-identical. Fail-soft - a broken search config
  // never breaks the pack.
  let sessionFocus: ReturnType<typeof readActiveSessionFocus> = null;
  if (resolveSearchFocusContextPack(ctx.configPath ?? undefined)) {
    // Argument validation stays OUTSIDE the fail-soft block: an invalid
    // focus_session is a caller error (INVALID_PARAMS), not a config
    // read to swallow.
    const focusSession = coerceStr(args, "focus_session", false) ?? undefined;
    try {
      const searchConfig = resolveSearchConfig({
        vault: ctx.vault,
        configPath: ctx.configPath ?? undefined,
      });
      sessionFocus = readActiveSessionFocus(searchConfig, focusSession);
    } catch {
      sessionFocus = null;
    }
  }
  const report = packContext(ctx.vault, {
    maxTokens,
    ...(sessionFocus !== null ? { sessionFocus } : {}),
    ...(query ? { query } : {}),
    ...(includeLanes ? { includeLanes: true } : {}),
    ...(receipt !== undefined ? { receipt } : {}),
    ...(cacheStable || dedupRepeated
      ? {
          transforms: {
            ...(cacheStable ? { cacheStableOrdering: true } : {}),
            ...(dedupRepeated ? { deduplicateRepeatedContext: true } : {}),
          },
        }
      : {}),
    ...(maxCharsPerMemory !== undefined ? { maxCharsPerMemory } : {}),
    ...(maxTotalChars !== undefined ? { maxTotalChars } : {}),
    ...(telemetry !== undefined ? { telemetry } : {}),
    ...(attentionFlowIds.length > 0 ? { attentionFlowIds } : {}),
  });
  return {
    vault_path: ctx.vault,
    max_tokens: report.maxTokens,
    tokens_used: report.tokensUsed,
    items: report.items.map((i) => ({
      id: i.id,
      path: i.path,
      tier: i.tier,
      tokens: i.tokens,
      body: i.body,
      trimmed: i.trimmed,
      ...(i.originalRank !== undefined ? { original_rank: i.originalRank } : {}),
      ...(i.stableRank !== undefined ? { stable_rank: i.stableRank } : {}),
      ...(i.dedupedFrom !== undefined ? { deduped_from: i.dedupedFrom } : {}),
      ...(i.referenceHint !== undefined ? { reference_hint: i.referenceHint } : {}),
      ...(i.safety ? { safety: i.safety } : {}),
    })),
    skipped: report.skipped.map((s) => ({
      id: s.id,
      tokens: s.tokens,
      reason: s.reason,
    })),
    ...(report.receiptId ? { receipt_id: report.receiptId } : {}),
    ...(report.telemetryId ? { telemetry_id: report.telemetryId } : {}),
    ...(report.lanes ? { lanes: report.lanes } : {}),
  };
}

// ----- brain_context_receipts ---------------------------------------------

async function toolBrainContextReceipts(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const operation = optionalStringArg("brain_context_receipts", args, "operation");
  if (operation === "list") {
    const trigger = optionalStringArg("brain_context_receipts", args, "trigger");
    if (trigger !== undefined && !isContextReceiptTrigger(trigger)) {
      throw new MCPError(
        INVALID_PARAMS,
        "brain_context_receipts: trigger must be context_pack or pre_compress",
      );
    }
    const host = optionalStringArg("brain_context_receipts", args, "host");
    const sessionId = optionalStringArg("brain_context_receipts", args, "session_id");
    const limit = coercePositiveInteger("brain_context_receipts", "limit", args["limit"]);
    const receipts = listContextReceipts(ctx.vault, {
      ...(trigger !== undefined ? { trigger } : {}),
      ...(host !== undefined ? { host } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    const summaries = receipts.map(summarizeContextReceipt);
    return {
      vault_path: ctx.vault,
      total: summaries.length,
      receipts: summaries,
    };
  }

  if (operation === "show") {
    const id = optionalStringArg("brain_context_receipts", args, "id");
    if (id === undefined) {
      throw new MCPError(INVALID_PARAMS, "brain_context_receipts: id is required for show");
    }
    const receipt = getContextReceipt(ctx.vault, id);
    if (receipt === null) {
      throw new MCPError(INVALID_PARAMS, `brain_context_receipts: receipt not found: ${id}`);
    }
    return {
      id: receipt.id,
      kind: receipt.kind,
      createdAt: receipt.createdAt,
      sourceRefs: receipt.sourceRefs,
      payload: receipt.payload,
      private: receipt.private,
      redacted: receipt.redacted,
    };
  }

  throw new MCPError(INVALID_PARAMS, "brain_context_receipts: operation must be list or show");
}

function receiptOptionsFromArgs(
  tool: string,
  args: Record<string, unknown>,
  trigger: "context_pack" | "pre_compress",
  defaultHost: string,
): ContextReceiptOptions | undefined {
  if (!coerceBool(args, "receipt")) return undefined;
  return {
    host: optionalStringArg(tool, args, "receipt_host") ?? defaultHost,
    trigger,
    ...(optionalStringArg(tool, args, "session_id") !== undefined
      ? { sessionId: optionalStringArg(tool, args, "session_id") }
      : {}),
    ...(optionalStringArg(tool, args, "turn_id") !== undefined
      ? { turnId: optionalStringArg(tool, args, "turn_id") }
      : {}),
  };
}

async function toolBrainContextPresets(
  _ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const operation = optionalStringArg("brain_context_presets", args, "operation");
  if (operation === "show") {
    const presetId = optionalStringArg("brain_context_presets", args, "preset_id");
    const result =
      presetId === undefined ? { presets: listContextPresets() } : getContextPreset(presetId);
    if (result === null) {
      throw new MCPError(INVALID_PARAMS, `brain_context_presets: unknown preset ${presetId}`);
    }
    return Array.isArray(result) ? { presets: result } : { ...result };
  }
  if (operation === "suggest") {
    const model = optionalStringArg("brain_context_presets", args, "model");
    const window = coercePositiveInteger(
      "brain_context_presets",
      "context_window_tokens",
      args["context_window_tokens"],
    );
    return {
      ...suggestContextPreset({
        ...(model !== undefined ? { model } : {}),
        ...(window !== undefined ? { contextWindowTokens: window } : {}),
      }),
    };
  }
  if (operation === "diff") {
    const presetId = optionalStringArg("brain_context_presets", args, "preset_id");
    if (presetId === undefined) {
      throw new MCPError(INVALID_PARAMS, "brain_context_presets: preset_id is required for diff");
    }
    return {
      ...diffContextPreset(presetId, contextPresetCurrentConfig(args["current"])),
    };
  }
  throw new MCPError(
    INVALID_PARAMS,
    "brain_context_presets: operation must be show, suggest, or diff",
  );
}

function contextPresetCurrentConfig(raw: unknown): ContextPresetCurrentConfig {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new MCPError(INVALID_PARAMS, "brain_context_presets: current must be an object");
  }
  return raw as ContextPresetCurrentConfig;
}

// ----- brain_pre_compact_extract ------------------------------------------

/**
 * Read-only bundle of the highest-confidence confirmed preferences plus
 * the head of active.md, rendered as a system-prompt addendum for a host
 * runtime to inject just before a context-compression event.
 */
async function toolBrainPreCompressPack(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const topK = optionalPositiveInt(args, "top_k", "brain_pre_compress_pack") ?? 10;
  const maxCharsPerMemory = optionalPositiveInt(
    args,
    "max_chars_per_memory",
    "brain_pre_compress_pack",
  );
  const maxTotalChars = optionalPositiveInt(args, "max_total_chars", "brain_pre_compress_pack");
  const receipt = receiptOptionsFromArgs("brain_pre_compress_pack", args, "pre_compress", "mcp");
  const telemetry = telemetryOptionsFromArgs("brain_pre_compress_pack", args, "mcp");
  const pack = buildPreCompressPack(ctx.vault, {
    topK,
    ...(maxCharsPerMemory !== undefined ? { maxCharsPerMemory } : {}),
    ...(maxTotalChars !== undefined ? { maxTotalChars } : {}),
    ...(receipt !== undefined ? { receipt } : {}),
    ...(telemetry !== undefined ? { telemetry } : {}),
  });
  return {
    vault_path: ctx.vault,
    text: pack.text,
    active_head_included: pack.activeHeadIncluded,
    ...(pack.activeHeadSafety ? { active_head_safety: pack.activeHeadSafety } : {}),
    total_chars: pack.totalChars,
    ...(pack.receiptId ? { receipt_id: pack.receiptId } : {}),
    ...(pack.telemetryId ? { telemetry_id: pack.telemetryId } : {}),
    items: pack.items.map((i) => ({
      id: i.id,
      principle: i.principle,
      trimmed: i.trimmed,
      ...(i.safety ? { safety: i.safety } : {}),
    })),
  };
}

async function toolBrainPreCompactExtract(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const sessionId = requiredStringArg("brain_pre_compact_extract", args, "session_id");
  const turnStart = requiredStringArg("brain_pre_compact_extract", args, "turn_start");
  const turnEnd = requiredStringArg("brain_pre_compact_extract", args, "turn_end");
  const text = requiredStringArg("brain_pre_compact_extract", args, "text");
  const maxChars = coercePositiveInteger(
    "brain_pre_compact_extract",
    "max_chars",
    args["max_chars"],
  );
  const result = extractPreCompactRecords(ctx.vault, {
    sessionId,
    turnStart,
    turnEnd,
    text,
    ...(optionalStringArg("brain_pre_compact_extract", args, "host") !== undefined
      ? { host: optionalStringArg("brain_pre_compact_extract", args, "host") }
      : {}),
    ...(maxChars !== undefined ? { maxChars } : {}),
  });
  return { count: result.records.length, ...result };
}

// ----- session recall DAG --------------------------------------------------

export const PACK_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: "brain_context_pack",
    previewBudget: MCP_PREVIEW_BUDGET,
    description:
      "Return the highest-tier, most recent vault slice that fits under `max_tokens`. Ordered core → supporting → peripheral, newest first; stops adding pages when the next page would exceed the budget. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        max_tokens: {
          type: "integer",
          minimum: 1,
          description: "Strict upper bound on the returned slice's token count.",
        },
        query: {
          type: "string",
          description: "Optional case/Unicode-insensitive substring filter on topic + principle.",
        },
        focus_session: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description:
            "Session id whose bound search focus boosts matching memories (requires search_focus_context_pack).",
        },
        max_chars_per_memory: {
          type: "integer",
          minimum: 1,
          description:
            "Optional per-page character cap so one huge page cannot crowd out the rest; trimmed pages carry `trimmed: true`.",
        },
        max_total_chars: {
          type: "integer",
          minimum: 1,
          description:
            "Optional second ceiling (code points) on the cumulative size of the returned slice. Lowest-priority overflow is dropped with an `over-char-budget` skip reason.",
        },
        lanes: {
          type: "boolean",
          description:
            "When true, also return polarity-aware directives, constraints, and consider lanes. Legacy flat `items` remains present.",
        },
        cache_stable: {
          type: "boolean",
          description:
            "When true, reorder the selected items by stable id and annotate their original rank.",
        },
        dedup_repeated: {
          type: "boolean",
          description:
            "When true, replace repeated context bodies with reference hints to an earlier emitted item.",
        },
        attention_flow_ids: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional declarative attention flow ids to inject as a synthetic context block.",
        },
        receipt: {
          type: "boolean",
          description: "When true, emit an opt-in context receipt for this context-pack run.",
        },
        receipt_host: {
          type: "string",
          description: "Optional host/runtime name for emitted receipts; defaults to `mcp`.",
        },
        telemetry: {
          type: "boolean",
          description:
            "When true, emit an opt-in recall telemetry record for this context-pack run.",
        },
        telemetry_host: {
          type: "string",
          description: "Optional host/runtime name for emitted telemetry; defaults to `mcp`.",
        },
        session_id: {
          type: "string",
          description: "Optional session id recorded on emitted telemetry.",
        },
        turn_id: {
          type: "string",
          description: "Optional turn id recorded on emitted telemetry.",
        },
      },
      required: ["max_tokens"],
      additionalProperties: false,
    },
    handler: toolBrainContextPack,
  },
  {
    name: "brain_context_receipts",
    description:
      "List context receipt summaries or show one full receipt by id. Receipts are append-only continuity records emitted by opt-in context injection callers. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["list", "show"],
          description: "Use list for summaries, show for one full receipt by id.",
        },
        id: {
          type: "string",
          description: "Receipt id required when operation is show.",
        },
        trigger: {
          type: "string",
          enum: ["context_pack", "pre_compress"],
          description: "Optional list filter by injection trigger.",
        },
        host: {
          type: "string",
          description: "Optional list filter by host/runtime name.",
        },
        session_id: {
          type: "string",
          description: "Optional list filter by recorded session id.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          description: "Optional maximum number of summaries to return.",
        },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    handler: toolBrainContextReceipts,
  },
  {
    name: "brain_context_presets",
    description:
      "Show, suggest, or diff read-only context budget presets. Diagnostics only; never writes configuration.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["show", "suggest", "diff"],
          description:
            "show returns presets, suggest chooses by model/window, diff compares current values.",
        },
        preset_id: {
          type: "string",
          description: "Preset id for show/diff, e.g. tight-context or long-context.",
        },
        model: {
          type: "string",
          description: "Optional model name hint for suggest.",
        },
        context_window_tokens: {
          type: "integer",
          minimum: 1,
          description: "Optional context-window size hint for suggest.",
        },
        current: {
          type: "object",
          description:
            "Optional current values for diff: { context_pack, pre_compress, overrides }. Overrides preserve caller-managed paths.",
        },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    handler: toolBrainContextPresets,
  },
  {
    // No preview budget: the addendum is meant to be injected whole and
    // is already bounded by its own per-entry / total character caps.
    name: "brain_pre_compress_pack",
    description:
      "Return a compact system-prompt addendum (top-K confirmed preferences plus the head of active.md) for a host to inject right before context compression. Char-budgeted. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        top_k: {
          type: "integer",
          minimum: 1,
          description:
            "Maximum number of preferences to include, highest-confidence first (default 10).",
        },
        max_chars_per_memory: {
          type: "integer",
          minimum: 1,
          description:
            "Optional per-entry character cap (code points); trimmed entries carry `trimmed: true`.",
        },
        max_total_chars: {
          type: "integer",
          minimum: 1,
          description:
            "Optional total character cap (code points) across the addendum; lowest-priority overflow is dropped.",
        },
        receipt: {
          type: "boolean",
          description: "When true, emit an opt-in context receipt for this pre-compress run.",
        },
        receipt_host: {
          type: "string",
          description: "Optional host/runtime name for emitted receipts; defaults to `mcp`.",
        },
        telemetry: {
          type: "boolean",
          description:
            "When true, emit an opt-in recall telemetry record for this pre-compress run.",
        },
        telemetry_host: {
          type: "string",
          description: "Optional host/runtime name for emitted telemetry; defaults to `mcp`.",
        },
        session_id: {
          type: "string",
          description: "Optional session id recorded on emitted telemetry.",
        },
        turn_id: {
          type: "string",
          description: "Optional turn id recorded on emitted telemetry.",
        },
      },
      additionalProperties: false,
    },
    handler: toolBrainPreCompressPack,
  },
  {
    name: "brain_pre_compact_extract",
    description:
      "Extract typed Decision/Commitment/Outcome/Rule/Open question records from bounded text into continuity storage.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Session identifier used for idempotency and source refs.",
        },
        turn_start: {
          type: "string",
          description: "First source turn id in the extracted segment.",
        },
        turn_end: {
          type: "string",
          description: "Last source turn id in the extracted segment.",
        },
        text: {
          type: "string",
          description: "Bounded text segment to scan for labeled extraction lines.",
        },
        host: { type: "string", description: "Optional host/client label." },
        max_chars: {
          type: "integer",
          minimum: 1,
          description: "Optional maximum input characters to scan before extracting.",
        },
      },
      required: ["session_id", "turn_start", "turn_end", "text"],
      additionalProperties: false,
    },
    handler: toolBrainPreCompactExtract,
  },
]);
