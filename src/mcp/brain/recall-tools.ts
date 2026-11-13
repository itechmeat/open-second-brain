/**
 * Recall quality: benchmark, self-tuning, recall telemetry, and imported-session recall (grep/describe/expand).
 *
 * Extracted from the former brain-tools.ts monolith; registration
 * happens through the aggregator, which preserves the public
 * BRAIN_TOOLS surface.
 */

import {
  RECALL_CHANNELS,
  RECALL_TELEMETRY_MODES,
  RECALL_TELEMETRY_STATUSES,
} from "../../core/brain/recall-telemetry.ts";
import { TOKEN_COUNT_METHODS } from "../../core/brain/token-impact.ts";
import type { ToolDefinition } from "../tool-contract.ts";
import { MCP_PREVIEW_BUDGET } from "../preview-budget.ts";
import { CURSOR_SCHEMA } from "./pagination.ts";
import { AGENT_SCOPE_SCHEMA } from "../coerce.ts";
import {
  toolBrainBenchmark,
  toolBrainRecallTelemetry,
  toolBrainTune,
} from "./recall-bench-tools.ts";
import {
  toolBrainRetrievalPlan,
  toolBrainRouteMetrics,
  toolBrainTokenImpact,
} from "./recall-coerce-tools.ts";
import { toolBrainContextPackOutcome, toolBrainKnowledgeGaps } from "./recall-outcome-tools.ts";
import {
  toolBrainSessionDescribe,
  toolBrainSessionExpand,
  toolBrainSessionGrep,
} from "./recall-session-tools.ts";

export const RECALL_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: "brain_benchmark",
    kind: "read",
    description:
      "Recall-quality benchmark: score the vault's live hybrid recall against a fixed dataset ({queries: [{id, query, expected: [paths]}]}) - hit@k and MRR per query and aggregate - and record one recall_benchmark metric so quality is chartable over time.",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["run"], description: "Tool operation." },
        dataset: {
          type: "object",
          description: "Benchmark dataset: {queries: [{id, query, expected, k?}]}.",
        },
        k: { type: "integer", minimum: 1, description: "Rank depth (default 5)." },
        expand: { type: "boolean", description: "Route queries through deterministic expansion." },
      },
      required: ["operation", "dataset"],
      additionalProperties: false,
    },
    handler: toolBrainBenchmark,
    previewBudget: MCP_PREVIEW_BUDGET,
  },
  {
    name: "brain_tune",
    kind: "write",
    description:
      "Opt-in self-tuning recall: run grid-evaluates bounded parameters (pool multiplier, traversal depth, learned weights, expansion) against a benchmark dataset and persists the winner as the tuning state; status shows the validated state; reset deletes it. Search honors it only when enabled.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["run", "status", "reset"],
          description: "Tool operation.",
        },
        dataset: { type: "object", description: "Benchmark dataset (run)." },
        k: { type: "integer", minimum: 1, description: "Rank depth (run, default 5)." },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    handler: toolBrainTune,
    previewBudget: MCP_PREVIEW_BUDGET,
  },
  {
    name: "brain_recall_telemetry",
    kind: "read",
    previewBudget: MCP_PREVIEW_BUDGET,
    description:
      "List recall telemetry records or summarize recall coverage and gaps; cost folds write volume against reads per period; dead_weight reports in-scope pages no recall ever surfaced, hidden pages dropped before totals, dead list capped (limit; default 50, max 500). Opt-in emit; read-only.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: [
            "list",
            "summary",
            "gate_list",
            "gate_summary",
            "observed_reuse",
            "cost",
            "dead_weight",
          ],
          description:
            "list/summary telemetry; gate_list/gate_summary gate decisions; observed_reuse use ranking; cost the cost meter; dead_weight the never-surfaced view.",
        },
        mode: {
          type: "string",
          enum: [...RECALL_TELEMETRY_MODES],
          description: "Optional filter by recall mode.",
        },
        status: {
          type: "string",
          enum: [...RECALL_TELEMETRY_STATUSES],
          description: "Optional filter by telemetry status.",
        },
        channel: {
          type: "string",
          enum: [...RECALL_CHANNELS],
          description: "Optional filter by delivery channel.",
        },
        host: {
          type: "string",
          description: "Optional filter by host/runtime name.",
        },
        since: {
          type: "string",
          description: "Optional inclusive lower timestamp bound.",
        },
        until: {
          type: "string",
          description: "Optional inclusive upper timestamp bound.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          description:
            "Optional maximum record count for list; dead_weight: the dead preview cap (default 50, max 500).",
        },
        write_cost: {
          type: "number",
          minimum: 0,
          description: "cost: weight charged per write op (default 1).",
        },
        read_cost: {
          type: "number",
          minimum: 0,
          description: "cost: weight charged per read op (default 1).",
        },
        write_heavy_ratio: {
          type: "number",
          minimum: 0,
          description:
            "cost: write/read ratio above which the period is flagged write-heavy (default 1).",
        },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    handler: toolBrainRecallTelemetry,
  },
  {
    name: "brain_route_metrics",
    kind: "read",
    previewBudget: MCP_PREVIEW_BUDGET,
    description:
      "Route-level MCP latency: list mcp_route_latency records or summarize per-tool latency (count, errors, min/avg/max, p50/p95/p99, per-stage count/avg/p95) slowest-first. Emitted only when mcp_route_metrics_enabled is on; payload-safe (tool, scope, status, duration, arg keys, stage names). Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["list", "summary"],
          description: "list for raw records; summary for per-tool latency roll-up.",
        },
        tool: {
          type: "string",
          description: "Optional filter by MCP tool name.",
        },
        status: {
          type: "string",
          enum: ["ok", "error"],
          description: "Optional filter by call status.",
        },
        since: {
          type: "string",
          description: "Optional inclusive lower timestamp bound.",
        },
        until: {
          type: "string",
          description: "Optional inclusive upper timestamp bound.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          description: "Optional maximum record count for list.",
        },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    handler: toolBrainRouteMetrics,
  },
  {
    name: "brain_retrieval_plan",
    kind: "read",
    previewBudget: MCP_PREVIEW_BUDGET,
    description:
      "Shadow-only retrieval planner for a question: composes query intent/weights, summary-surface route, context-pack density allocation, token-impact ledger, and route p95 latency into a strategy, token-budget allocation, graph-expansion advice, reliability, and a marginal-value stop. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description:
            "The question to plan retrieval for; drives intent, surface, and expansion advice.",
        },
        token_budget: {
          type: "integer",
          minimum: 1,
          description: "Optional context-pack token budget to model (default 2000).",
        },
        agent_scope: AGENT_SCOPE_SCHEMA,
      },
      required: ["question"],
      additionalProperties: false,
    },
    handler: toolBrainRetrievalPlan,
  },
  {
    name: "brain_token_impact",
    kind: "write",
    previewBudget: MCP_PREVIEW_BUDGET,
    description:
      "Durable value-of-memory ledger. `record`: a pack's tokenizer-exact prompt-token delta (baseline−packed; method exact|fallback) + optional modeled inference-avoidance. `outcome` calibrates the model. `summary` keeps EXACT separate from MODELED; `list` reads samples. Gated write; payload-safe.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["record", "outcome", "list", "summary"],
          description: "record/outcome write opt-in samples; list/summary read the durable ledger.",
        },
        baseline_tokens: {
          type: "integer",
          minimum: 0,
          description: "record: prompt-token cost WITHOUT the memory layer's compaction/selection.",
        },
        packed_tokens: {
          type: "integer",
          minimum: 0,
          description: "record: prompt-token cost the memory layer actually shipped.",
        },
        method: {
          type: "string",
          enum: [...TOKEN_COUNT_METHODS],
          description:
            "How the CALLER produced the counts, never how accurate they are - the server counts nothing. Defaults to 'heuristic'. Also a list/summary filter.",
        },
        modeled_avoided_inferences: {
          type: "number",
          minimum: 0,
          description:
            "record (optional): modeled count of inferences (repairs/retries) the layer avoided.",
        },
        modeled_tokens_per_inference: {
          type: "number",
          minimum: 0,
          description: "record (optional): modeled average prompt tokens per avoided inference.",
        },
        outcome: {
          type: "string",
          enum: ["first_pass", "repair", "retry"],
          description: "outcome: the observed result used to calibrate the modeled ledger.",
        },
        tokens_per_inference: {
          type: "number",
          minimum: 0,
          description: "outcome (optional): observed prompt tokens for this inference.",
        },
        pack_id: {
          type: "string",
          description:
            "Opaque correlation id (a receipt id or request hash) — never a raw prompt. Also a list/summary filter.",
        },
        host: { type: "string", description: "Optional host/runtime label; also a filter." },
        session_id: { type: "string", description: "Optional session id recorded on the sample." },
        turn_id: { type: "string", description: "Optional turn id recorded on the sample." },
        since: { type: "string", description: "Optional inclusive lower timestamp bound." },
        until: { type: "string", description: "Optional inclusive upper timestamp bound." },
        limit: {
          type: "integer",
          minimum: 1,
          description: "Optional maximum record count for list.",
        },
        max_samples: {
          type: "integer",
          minimum: 1,
          description: "Optional cap on the most-recent samples aggregated by summary.",
        },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    handler: toolBrainTokenImpact,
  },
  {
    name: "brain_context_pack_outcome",
    kind: "write",
    previewBudget: MCP_PREVIEW_BUDGET,
    description:
      "Context-pack outcome loop. `post` records an outcome row for a carried sample id — first-pass/repair/retry counters plus three SEPARATE token signals (exact, modeled, observed) — calibrates the token-impact ledger, and records the kernel's on-disk evidence. `list`/`summary` read rows. Gated.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["post", "list", "summary"],
          description: "post writes one opt-in outcome row; list/summary read the durable ledger.",
        },
        sample_id: {
          type: "string",
          description:
            "post: the carried recall/context-pack quality-sample id (a context-receipt id or opaque request hash) — never a raw prompt. Also a list/summary filter.",
        },
        first_pass_success: {
          type: "boolean",
          description: "post: whether the packed context led to a first-pass success.",
        },
        repair_required: {
          type: "boolean",
          description: "post (optional): whether the agent had to repair the first completion.",
        },
        retry_count: {
          type: "integer",
          minimum: 0,
          description: "post (optional): how many retries the completion needed.",
        },
        follow_up_tokens: {
          type: "integer",
          minimum: 0,
          description: "post (optional): tokens spent on follow-up turns after the first pass.",
        },
        exact_prompt_token_savings: {
          type: "number",
          minimum: 0,
          description:
            "post (optional): EXACT tokenizer-aware prompt-token savings (a measurement). Kept separate from the modeled and observed signals.",
        },
        modeled_inference_avoidance: {
          type: "number",
          minimum: 0,
          description:
            "post (optional): MODELED confidence-banded inference-avoidance estimate (a model). Kept separate from the exact and observed signals.",
        },
        observed_provider_tokens: {
          type: "number",
          minimum: 0,
          description:
            "post (optional): OBSERVED provider-reported token usage. Kept separate from the exact and modeled signals; also calibrates the token-impact ledger.",
        },
        evidence_claim: {
          type: "object",
          // Every client pays for this string on every request (the
          // registry guard caps it at 160 chars), so the reasoning lives
          // on `contextPackEvidenceClaim` below and the wire text states
          // only what a caller must know to use the field correctly: the
          // FOUR verdicts it can produce, and that a malformed member is
          // refused rather than downgraded - the earlier "Never rejects"
          // described the disagreement path and read as covering both.
          description:
            "post (optional): what you assert about this sample; kernel reads its receipt off disk, records match|mismatch|unclaimed|unresolved. Malformed = INVALID_PARAMS.",
          properties: {
            final_text_hash: {
              type: "string",
              description: "Claimed SHA-256 of the assembled pack text.",
            },
            item_count: {
              type: "integer",
              minimum: 0,
              description: "Claimed number of artifacts the pack injected.",
            },
            final_text_chars: {
              type: "integer",
              minimum: 0,
              description: "Claimed codepoint length of the assembled pack text.",
            },
          },
          additionalProperties: false,
        },
        host: { type: "string", description: "Optional host/runtime label; also a filter." },
        session_id: { type: "string", description: "Optional session id recorded on the row." },
        turn_id: { type: "string", description: "Optional turn id recorded on the row." },
        agent_id: {
          type: "string",
          description:
            "post (optional): the ACTING agent, recorded on all three rows this post lands. Self-asserted, never a verifier; omitted records no actor rather than a guess.",
        },
        since: { type: "string", description: "Optional inclusive lower timestamp bound." },
        until: { type: "string", description: "Optional inclusive upper timestamp bound." },
        limit: {
          type: "integer",
          minimum: 1,
          description: "Optional maximum record count for list.",
        },
        max_samples: {
          type: "integer",
          minimum: 1,
          description: "Optional cap on the most-recent rows aggregated by summary.",
        },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    handler: toolBrainContextPackOutcome,
  },
  {
    name: "brain_knowledge_gaps",
    kind: "read",
    previewBudget: MCP_PREVIEW_BUDGET,
    description:
      "Cross-query demand gaps: aggregate the persisted recall demand log into recurring queries the vault answers poorly, ranked by frequency × (1 − IDF-weighted coverage). Read-only; log written only by opt-in recall telemetry.",
    inputSchema: {
      type: "object",
      properties: {
        min_occurrences: {
          type: "integer",
          minimum: 1,
          description: "Minimum times a query must recur to surface (default 2).",
        },
        max_satisfaction: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description:
            "Surface only queries at/below this mean satisfaction (default 0.8) — i.e. not already answered well.",
        },
        since: { type: "string", description: "Optional inclusive lower timestamp bound." },
        until: { type: "string", description: "Optional inclusive upper timestamp bound." },
        limit: { type: "integer", minimum: 1, description: "Optional maximum gaps to return." },
      },
      additionalProperties: false,
    },
    handler: toolBrainKnowledgeGaps,
  },
  {
    name: "brain_session_grep",
    kind: "read",
    previewBudget: MCP_PREVIEW_BUDGET,
    description:
      "Search imported session recall raw turns and summary nodes, bounded by an optional time window (since/before). With operation=coverage, runs the coverage-first thread selection instead: facets fanned out under the topic budget, selected under char_budget, returned chronologically with diagnostics.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["match", "coverage"],
          description:
            "match (default) greps records for `query` (required here). coverage: `query` absent, `char_budget` required, `entity_key` optionally seeds the fan-out.",
        },
        query: { type: "string", description: "Search text (operation=match)." },
        session_id: {
          type: "string",
          description: "Optional session id filter.",
        },
        char_budget: {
          type: "integer",
          minimum: 1,
          description:
            "With operation=coverage: total character budget for the selected evidence. A budget that cannot hold the selection is refused, naming the required chars.",
        },
        entity_key: {
          type: "string",
          description:
            "With operation=coverage: seed the fan-out from sessions whose mined records mention this entity. An entity no record mentions is refused by name.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          description: "Maximum hits to return (operation=match).",
        },
        cursor: CURSOR_SCHEMA,
        snippet_chars: {
          type: "integer",
          minimum: 1,
          description: "Maximum chars per hit snippet (operation=match).",
        },
        since: {
          type: "string",
          description:
            "Optional inclusive lower time bound on turn authoring time (ISO date/datetime, today/yesterday/last week/last month, or <n>h/<n>d/<n>w).",
        },
        before: {
          type: "string",
          description:
            "Optional inclusive upper time bound on turn authoring time (same grammar as since).",
        },
        include_raw: {
          type: "boolean",
          description:
            "Inline the original raw captures beside each derived record and stamp an extracted discriminator. Omitted: byte-identical response.",
        },
        raw_budget_chars: {
          type: "integer",
          minimum: 1,
          description:
            "With include_raw, clip each inlined raw payload to this many chars; protected identity keys always survive.",
        },
      },
      additionalProperties: false,
    },
    handler: toolBrainSessionGrep,
  },
  {
    name: "brain_session_describe",
    kind: "read",
    description:
      "Describe counts and summary depths for an imported session recall DAG. With topics, also render the adaptive topic-budget report the coverage operation fans out under.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session id to describe." },
        topics: {
          type: "boolean",
          description:
            "Include the coverage topic report: detected facets, the adaptive topic budget (floor 12, cap 16) and the realized topics. Omitted: byte-identical response.",
        },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
    handler: toolBrainSessionDescribe,
  },
  {
    name: "brain_session_expand",
    kind: "read",
    previewBudget: MCP_PREVIEW_BUDGET,
    description:
      "Expand a session recall raw or summary node to immediate sources and paginated exact raw turn content. With payload instead of id, page the exact content behind an [payload: osb-payload://<sha256> chars=N] placeholder.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Session recall record id (omit when paging a payload).",
        },
        raw_limit: {
          type: "integer",
          minimum: 1,
          description: "Maximum raw turn items to return.",
        },
        cursor: {
          type: "string",
          description:
            "Pagination cursor from a previous response (raw turns, or payload chars with payload).",
        },
        payload: {
          type: "string",
          description:
            "An osb-payload://<sha256> ref from a placeholder; pages that payload instead of a record.",
        },
        payload_chars: {
          type: "integer",
          minimum: 1,
          description: "With payload: characters per page (default 4000).",
        },
      },
      additionalProperties: false,
    },
    handler: toolBrainSessionExpand,
  },
]);
