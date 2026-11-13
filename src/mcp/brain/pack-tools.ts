/**
 * Context packing surfaces: token-budgeted context pack, context
 * receipts, preset diagnostics, and the pre-compress / pre-compact
 * extraction paths.
 *
 * Extracted from the former brain-tools.ts monolith; registration
 * happens through the aggregator, which preserves the public
 * BRAIN_TOOLS surface.
 */

import { CONTEXT_PACK_QUERY_MODES } from "../../core/brain/context-pack.ts";
import { PACKING_POLICIES } from "../../core/brain/recall-budget.ts";
import { CONTEXT_RECEIPT_TRIGGERS } from "../../core/brain/context-receipts.ts";
import { CURSOR_SCHEMA } from "./pagination.ts";
import type { ToolDefinition } from "../tool-contract.ts";
import { MCP_QUERY_MAX_CHARS } from "../search-tools.ts";
import { MCP_PREVIEW_BUDGET } from "../preview-budget.ts";
import {
  AGENT_SCOPE_SCHEMA,
  MATCH_QUALITY_ARG_NAME,
  matchQualitySchema,
  RECALL_SCORES_SCHEMA,
  DECISION_ANSWERABLE_ARG_NAME,
  decisionAnswerablePairing,
  decisionAnswerableSchema,
  recallAdequacyPairing,
} from "../coerce.ts";
import { RECALL_SCORES_ARG_NAME } from "./pack-shared.ts";
import { toolBrainContextPack } from "./pack-context-tools.ts";
import { toolBrainContextReceipts, toolBrainEventTrace } from "./pack-receipt-tools.ts";
import {
  toolBrainAnticipatoryContext,
  toolBrainContextPresets,
  toolBrainPreCompactExtract,
  toolBrainPreCompressPack,
} from "./pack-preset-tools.ts";

export type { ReceiptVerifyRefusalReason, ReceiptVerifyRefusal } from "./pack-receipt-tools.ts";
export {
  RECEIPT_VERIFY_OPERATION,
  RECEIPT_VERIFY_REACH_REASON,
  RECEIPT_VERIFY_WITHHELD_REASON,
  isOperatorRuleItem,
  isRuleOnlyInjection,
} from "./pack-receipt-tools.ts";

export const PACK_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: "brain_context_pack",
    kind: "read",
    previewBudget: MCP_PREVIEW_BUDGET,
    description:
      "Return the highest-tier, most recent vault slice under `max_tokens` - derived from the model context window when omitted, refused when nothing resolves. Ordered core → supporting → peripheral, newest first; stops when the next page would exceed the budget. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        max_tokens: {
          type: "integer",
          minimum: 1,
          description:
            "Token cap for the slice. Omitted: derives from the resolved window (channel in `max_tokens_source`; `default` defers to the preset hint). Nothing resolvable is refused.",
        },
        model: {
          type: "string",
          description:
            "Model id. `max_tokens` omitted: the context window resolves (config, env, table, `1m` suffix); an unplaced id is refused (pass max_tokens or set context.window_tokens).",
        },
        query: {
          type: "string",
          maxLength: MCP_QUERY_MAX_CHARS,
          description:
            "Optional query. Read as a case/Unicode-insensitive substring filter on topic + principle unless `query_mode` says otherwise.",
        },
        query_mode: {
          type: "string",
          enum: [...CONTEXT_PACK_QUERY_MODES],
          description:
            "How `query` is read: `substring` (default) drops misses; `ranked` orders by token overlap; `semantic` orders by stored belief vectors, embedding the query once.",
        },
        packing_policy: {
          type: "string",
          enum: [...PACKING_POLICIES],
          description:
            "Budget claim order: `facts_first` or `retired_first`. Neither is the omitted default; a vault where one lane has no candidate is refused. Requires `query`.",
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
        [RECALL_SCORES_ARG_NAME]: RECALL_SCORES_SCHEMA,
        [MATCH_QUALITY_ARG_NAME]: matchQualitySchema(RECALL_SCORES_ARG_NAME),
        [DECISION_ANSWERABLE_ARG_NAME]: decisionAnswerableSchema(RECALL_SCORES_ARG_NAME),
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
        agent_scope: AGENT_SCOPE_SCHEMA,
      },
      // `max_tokens` used to be the one required argument; the resolver
      // (t_a567cc12) made it optional behind a derivation contract
      // instead, so `required` is gone - the nothing-resolvable refusal
      // is enforced beside the handler, not expressible as `required`.
      //
      // Pairings, stated declaratively so a schema-driven client can
      // discover them instead of learning them from an INVALID_PARAMS at
      // call time. Built beside the enforcement; see
      // `recallAdequacyPairing`. `query_mode` joins it one-directionally:
      // a mode needs a query, a query needs no mode. `packing_policy`
      // joins the same way: a policy with nothing to order is inert, so
      // it is refused beside its `dependentRequired` entry.
      dependentRequired: {
        ...recallAdequacyPairing(RECALL_SCORES_ARG_NAME),
        ...decisionAnswerablePairing(RECALL_SCORES_ARG_NAME),
        query_mode: ["query"],
        packing_policy: ["query"],
      },
      additionalProperties: false,
    },
    handler: toolBrainContextPack,
  },
  {
    name: "brain_context_receipts",
    kind: "read",
    description:
      "List receipt summaries, show one receipt, fold a window into a retrieval summary " +
      "(distinct items, frequency, token cost, observed use), or re-hash-verify a receipt " +
      "against its vault (match/changed/unavailable; local reach; withheld refused). " +
      "Append-only records from opt-in injectors. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["list", "show", "summary", "verify"],
          description:
            "list returns summaries, show returns one full receipt by id, summary folds a " +
            "window into a retrieval report, verify re-hashes one receipt against the vault.",
        },
        id: {
          type: "string",
          description: "Receipt id required when operation is show or verify.",
        },
        trigger: {
          type: "string",
          enum: [...CONTEXT_RECEIPT_TRIGGERS],
          description: "Optional list filter by injection trigger.",
        },
        host: {
          type: "string",
          description: "Optional list filter by host/runtime name.",
        },
        session_id: {
          type: "string",
          description: "Optional list/summary filter by recorded session id.",
        },
        since: {
          type: "string",
          description:
            "Summary only: inclusive lower bound on receipt createdAt. Canonical UTC only (YYYY-MM-DDTHH:MM:SS[.sss]Z); anything else is rejected, not filtered to empty.",
        },
        until: {
          type: "string",
          description:
            "Summary only: inclusive upper bound on receipt createdAt. Canonical UTC only (YYYY-MM-DDTHH:MM:SS[.sss]Z); anything else is rejected, not filtered to empty.",
        },
        max_receipts: {
          type: "integer",
          minimum: 1,
          description:
            "Summary only: how many matching receipts are AGGREGATED (a fold bound, not a read bound - narrow the read with since/until). Exceeding it sets `truncated`.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          description:
            "Maximum summaries to return (list) or item rows to return (summary; `distinct_items` still reports the full count).",
        },
        cursor: CURSOR_SCHEMA,
      },
      required: ["operation"],
      additionalProperties: false,
    },
    handler: toolBrainContextReceipts,
  },
  {
    name: "brain_event_trace",
    kind: "read",
    description:
      "Join logged Brain events to their attached continuity records (recall telemetry, context receipts, generation reports) by shared correlation ids. Defaults to today. `total`/`trace_total` are exact once the walk exhausts; mid-walk they report the page's scan bound, never a silent cap. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        date: {
          type: "string",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          description: "Log day to read (YYYY-MM-DD, UTC). Defaults to today.",
        },
        at: {
          type: "string",
          pattern: "^\\d{2}:\\d{2}:\\d{2}$",
          description: "Pin a single event by its HH:MM:SS UTC stamp.",
        },
        kind: {
          type: "string",
          description:
            "Optional filter by Brain log event kind (e.g. write-session, apply-evidence).",
        },
        session_id: {
          type: "string",
          description: "Restrict to events whose body carries this session id.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          description: "Optional maximum number of events to return.",
        },
        cursor: CURSOR_SCHEMA,
        keep_private: {
          type: "boolean",
          description: "Keep continuity records flagged private (default: drop them).",
        },
      },
      additionalProperties: false,
    },
    handler: toolBrainEventTrace,
  },
  {
    name: "brain_context_presets",
    kind: "read",
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
          description:
            "Optional model for suggest. With `context_window_tokens` absent the window resolves first (table, `1m` suffix); a hint answers only when nothing places the id.",
        },
        context_window_tokens: {
          type: "integer",
          minimum: 1,
          description:
            "Optional context-window size hint for suggest. Wins over model-derived resolution.",
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
    // is bounded by its own per-entry / total character caps - now also
    // derived from the resolved context window when absent (t_a567cc12).
    name: "brain_pre_compress_pack",
    kind: "read",
    description:
      "Return a compact system-prompt addendum (top-K confirmed preferences plus the head of the active digest) for a host to inject right before context compression. Char-budgeted: absent caps derive from the resolved model context window, so the addendum is bounded whenever a window resolves. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        top_k: {
          type: "integer",
          minimum: 1,
          description:
            "Maximum number of preferences to include, highest-confidence first (default 10).",
        },
        model: {
          type: "string",
          description:
            "Model id. When a char cap is absent the context window resolves from this id (table, `1m` suffix, or default); a preset hint sizes caps only when nothing places it.",
        },
        max_chars_per_memory: {
          type: "integer",
          minimum: 1,
          description:
            "Optional per-entry character cap; trimmed entries carry `trimmed: true`. Absent: the preset cap applies when a window resolves; nothing resolvable stays unbounded.",
        },
        max_total_chars: {
          type: "integer",
          minimum: 1,
          description:
            "Optional total character cap; lowest-priority overflow drops first. Absent: the preset cap applies when a window resolves; nothing resolvable stays unbounded.",
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
        agent_scope: AGENT_SCOPE_SCHEMA,
      },
      additionalProperties: false,
    },
    handler: toolBrainPreCompressPack,
  },
  {
    name: "brain_pre_compact_extract",
    kind: "write",
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
        interrupted: {
          type: "boolean",
          description:
            "When true, mark the extracted records as flushed by an interrupted close (SIGHUP/SIGTERM/force-quit/restart-drain). Absent by default.",
        },
        dry_run: {
          type: "boolean",
          description:
            "Preview the candidate records extraction would append WITHOUT writing to the vault (no continuity record, no dream/retire trigger). Absent by default.",
        },
      },
      required: ["session_id", "turn_start", "turn_end", "text"],
      additionalProperties: false,
    },
    handler: toolBrainPreCompactExtract,
  },
  {
    name: "brain_anticipatory_context",
    kind: "write",
    previewBudget: MCP_PREVIEW_BUDGET,
    description:
      "Turn-specific context bundle kept warm by lifecycle hooks: the active context pack plus session-recall hits, keyed by the session's lineage root. Returns the warm cache inside the TTL or a live fallback, reporting `cache_state`. `refresh: true` forces a refresh first.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Session id (any segment of a compression chain resolves to its root).",
        },
        refresh: {
          type: "boolean",
          description: "Refresh the cache before reading (TTL debounce still applies).",
        },
        signal_text: {
          type: "string",
          description: "Latest prompt/signal text steering the refreshed bundle.",
        },
        agent_scope: AGENT_SCOPE_SCHEMA,
      },
      required: ["session_id"],
      additionalProperties: false,
    },
    handler: toolBrainAnticipatoryContext,
  },
]);
