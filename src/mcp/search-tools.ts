/**
 * MCP tool registry slice for Brain Search.
 *
 * Exposes `brain_search` (read-only, agent-facing) and the
 * `search.*` enrichment used by `second_brain_status`. Index management
 * verbs (`index`, `reindex`, `check`) are intentionally NOT exposed
 * over MCP — they are operator business, never agent business
 * (design doc §3, principle 5).
 *
 * Anchored in docs/plans/2026-05-16-brain-search-design.md §9.
 */

import {
  captureRecallFeedback,
  evaluateSurfacingGate,
  indexStatus,
  resolveSearchConfig,
  search,
  SearchError,
} from "../core/search/index.ts";
import { normalizeSessionFocus, parseStructuredRecallQueryDocument } from "../core/search/index.ts";
import type { BrainSearchResult, SearchOutcome } from "../core/search/index.ts";
import { withTimeout } from "../core/search/with-timeout.ts";
import { INTERNAL_ERROR, INVALID_PARAMS, MCPError } from "./protocol.ts";
import type { ServerContext, ToolDefinition } from "./tools.ts";
import { coerceBoolOptional, coerceStr, coerceStringOptional } from "./coerce.ts";
import { MCP_PREVIEW_BUDGET } from "./preview-budget.ts";
import { deriveRecallHint } from "../core/search/recall-hint.ts";
import { emitRecallTelemetry } from "../core/brain/recall-telemetry.ts";

const MCP_LIMIT_MAX = 50;
const MCP_CONTENT_MAX = 600;
const SEARCH_TIMEOUT_MS = 10_000;

const SEARCH_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    query: { type: "string", minLength: 1, maxLength: 2000 },
    query_document: { type: "string", minLength: 1, maxLength: 4000 },
    focus_query: { type: "string", minLength: 1, maxLength: 1000 },
    focus_path_prefix: { type: "string", minLength: 1, maxLength: 256 },
    evidence_pack: { type: "boolean" },
    include_superseded: {
      type: "boolean",
      description:
        "History mode for relation polarity: keep matched superseded predecessors undemoted and skip successor pull-in. Default false.",
    },
    since: {
      type: "string",
      maxLength: 64,
      description:
        "Time-aware recall: only documents modified at/after this point. ISO date/datetime, 'today', 'yesterday', 'last week', 'last month', or <n>h/<n>d/<n>w.",
    },
    until: {
      type: "string",
      maxLength: 64,
      description:
        "Time-aware recall: only documents modified at/before this point. Same forms as 'since'.",
    },
    limit: { type: "integer", minimum: 1, maximum: MCP_LIMIT_MAX },
    semantic: { type: "boolean" },
    keyword_only: { type: "boolean" },
    path_prefix: { type: "string", maxLength: 256 },
    telemetry: { type: "boolean" },
    telemetry_host: { type: "string", maxLength: 200 },
    session_id: { type: "string", maxLength: 512 },
    turn_id: { type: "string", maxLength: 512 },
    properties: {
      type: "object",
      description:
        "Optional frontmatter property filter (v0.10.17). Each key maps to one or more accepted scalar values; multi-value within a key is OR, multiple keys is AND.",
      additionalProperties: {
        type: "array",
        items: { type: "string" },
      },
    },
    visibility: {
      type: "array",
      description:
        "Optional content-visibility scope (v3). Pages with no `visibility:` frontmatter are always returned; a page that declares visibility values is returned only when this scope includes one of them. Absent = default scope (untagged pages only).",
      items: { type: "string" },
    },
  },
  required: ["query"],
  additionalProperties: false,
};

const SEARCH_OUTPUT_SCHEMA: NonNullable<ToolDefinition["outputSchema"]> = {
  type: "object",
  required: ["results", "warnings", "total"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        required: [
          "path",
          "title",
          "content",
          "score",
          "startLine",
          "endLine",
          "searchType",
          "reasons",
        ],
        properties: {
          path: { type: "string" },
          title: { type: "string" },
          content: { type: "string" },
          score: { type: "number" },
          startLine: { type: "integer" },
          endLine: { type: "integer" },
          searchType: { type: "string" },
          reasons: { type: "array", items: { type: "string" } },
          why_retrieved: { type: "array", items: { type: "string" } },
          relations: {
            type: "array",
            items: {
              type: "object",
              required: ["relation", "target"],
              properties: {
                relation: { type: "string" },
                target: { type: "string" },
              },
            },
          },
        },
      },
    },
    warnings: { type: "array", items: { type: "string" } },
    total: { type: "integer" },
    recall_hint: { type: "string" },
    evidence_pack: { type: "object" },
    telemetry_id: { type: "string" },
  },
};

const RECALL_GATE_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    prompt: { type: "string", minLength: 1, maxLength: 4000 },
    previous_prompt: { type: "string", maxLength: 4000 },
    explicit: { type: "boolean" },
  },
  required: ["prompt"],
  additionalProperties: false,
};

const RECALL_GATE_OUTPUT_SCHEMA: NonNullable<ToolDefinition["outputSchema"]> = {
  type: "object",
  required: ["retrieve", "reason"],
  properties: {
    retrieve: { type: "boolean" },
    reason: { type: "string" },
  },
};

function searchTimeoutError(ms: number): MCPError {
  return new MCPError(INTERNAL_ERROR, `search timeout after ${ms}ms`);
}

/**
 * Validate + normalise the `properties` argument shape. Returns
 * `undefined` when the argument is absent. Throws INVALID_PARAMS
 * on a malformed shape so callers get a clear error rather than a
 * silently-ignored filter.
 */
function parsePropertiesArgument(
  raw: unknown,
): ReadonlyMap<string, ReadonlyArray<string>> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new MCPError(
      INVALID_PARAMS,
      "argument 'properties' must be an object mapping key → array of strings",
    );
  }
  const map = new Map<string, ReadonlyArray<string>>();
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(v)) {
      throw new MCPError(INVALID_PARAMS, `argument 'properties.${k}' must be an array of strings`);
    }
    const accepted: string[] = [];
    for (const item of v) {
      if (typeof item !== "string") {
        throw new MCPError(INVALID_PARAMS, `argument 'properties.${k}' must contain only strings`);
      }
      accepted.push(item);
    }
    if (accepted.length === 0) {
      throw new MCPError(INVALID_PARAMS, `argument 'properties.${k}' must not be empty`);
    }
    map.set(k, Object.freeze(accepted));
  }
  return map;
}

function parseVisibilityArgument(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new MCPError(INVALID_PARAMS, "argument 'visibility' must be an array of strings");
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      throw new MCPError(INVALID_PARAMS, "argument 'visibility' must contain only strings");
    }
    if (item.length > 0) out.push(item);
  }
  return out;
}

function truncateContent(c: string, max: number): string {
  if (c.length <= max) return c;
  return c.slice(0, max - 1) + "…";
}

function searchErrorToMcp(e: SearchError): MCPError {
  if (e.code === "INVALID_INPUT") return new MCPError(INVALID_PARAMS, e.message);
  if (e.code === "INDEX_MISSING") {
    return new MCPError(INTERNAL_ERROR, "search index not initialised. Run: o2b search index");
  }
  if (e.code === "INDEX_UNREADABLE") {
    return new MCPError(INTERNAL_ERROR, `search index unreadable: ${e.message}`);
  }
  if (e.code === "VEC_EXTENSION_UNAVAILABLE") {
    return new MCPError(
      INTERNAL_ERROR,
      "semantic search unavailable: sqlite-vec extension not loaded",
    );
  }
  if (e.code === "EMBEDDING_KEY_MISSING") {
    return new MCPError(INTERNAL_ERROR, "embedding key not configured");
  }
  if (e.code === "EMBEDDING_PROVIDER_HTTP" || e.code === "EMBEDDING_PROVIDER_TIMEOUT") {
    return new MCPError(INTERNAL_ERROR, `embedding provider unavailable: ${e.message}`);
  }
  return new MCPError(INTERNAL_ERROR, `${e.message} [${e.code}]`);
}

async function toolBrainSearch(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const query = args["query"];
  if (typeof query !== "string" || query.trim() === "") {
    throw new MCPError(INVALID_PARAMS, "missing required argument: query");
  }
  if (query.length > 2000) {
    throw new MCPError(INVALID_PARAMS, "argument 'query' exceeds 2000 characters");
  }

  let limit = 10;
  if ("limit" in args && args["limit"] !== undefined && args["limit"] !== null) {
    const raw = args["limit"];
    if (typeof raw !== "number" || !Number.isInteger(raw)) {
      throw new MCPError(INVALID_PARAMS, "argument 'limit' must be an integer");
    }
    if (raw < 1 || raw > MCP_LIMIT_MAX) {
      throw new MCPError(INVALID_PARAMS, `argument 'limit' must be between 1 and ${MCP_LIMIT_MAX}`);
    }
    limit = raw;
  }

  const semantic = coerceBoolOptional(args, "semantic");
  const keywordOnly = coerceBoolOptional(args, "keyword_only") ?? false;
  const pathPrefix = coerceStringOptional(args, "path_prefix", 256);
  const evidencePack = coerceBoolOptional(args, "evidence_pack") ?? false;
  const includeSuperseded = coerceBoolOptional(args, "include_superseded") ?? false;
  const since = coerceStringOptional(args, "since", 64);
  const until = coerceStringOptional(args, "until", 64);
  const telemetry = coerceBoolOptional(args, "telemetry") ?? false;
  const telemetryHost = coerceStringOptional(args, "telemetry_host", 200) ?? "mcp";
  const telemetrySessionId = coerceStringOptional(args, "session_id", 512);
  const telemetryTurnId = coerceStringOptional(args, "turn_id", 512);
  const rawQueryDocument = coerceStringOptional(args, "query_document", 4000);
  const structuredQuery =
    rawQueryDocument !== undefined
      ? parseStructuredRecallQueryDocument(rawQueryDocument)
      : undefined;
  const focusQuery = coerceStringOptional(args, "focus_query", 1000);
  const focusPathPrefix = coerceStringOptional(args, "focus_path_prefix", 256);
  const sessionFocus =
    focusQuery !== undefined || focusPathPrefix !== undefined
      ? normalizeSessionFocus({
          query: focusQuery ?? null,
          pathPrefix: focusPathPrefix ?? null,
        })
      : undefined;
  const properties = parsePropertiesArgument(args["properties"]);
  const visibility = parseVisibilityArgument(args["visibility"]);

  const config = resolveSearchConfig({
    vault: ctx.vault,
    configPath: ctx.configPath ?? undefined,
  });

  let outcome: SearchOutcome;
  const startedAtMs = Date.now();
  try {
    outcome = await withTimeout(
      search(config, {
        query,
        limit,
        semantic: semantic ?? null,
        keywordOnly,
        pathPrefix,
        ...(properties !== undefined ? { properties } : {}),
        ...(visibility !== undefined ? { visibility } : {}),
        ...(structuredQuery !== undefined ? { structuredQuery } : {}),
        ...(sessionFocus !== undefined ? { sessionFocus } : {}),
        ...(evidencePack ? { evidencePack: true } : {}),
        ...(includeSuperseded ? { includeSuperseded: true } : {}),
        ...(since !== undefined ? { since } : {}),
        ...(until !== undefined ? { until } : {}),
      }),
      SEARCH_TIMEOUT_MS,
      searchTimeoutError,
    );
  } catch (e) {
    if (telemetry) {
      emitRecallTelemetry(ctx.vault, {
        host: telemetryHost,
        ...(telemetrySessionId !== undefined ? { sessionId: telemetrySessionId } : {}),
        ...(telemetryTurnId !== undefined ? { turnId: telemetryTurnId } : {}),
        mode: "search",
        status: e instanceof MCPError && e.message.includes("timeout") ? "timeout" : "error",
        durationMs: Date.now() - startedAtMs,
        resultCount: 0,
        gaps: [
          e instanceof MCPError && e.message.includes("timeout")
            ? "search_timeout"
            : "search_error",
        ],
        metadata: {
          limit,
          keyword_only: keywordOnly,
          semantic: semantic ?? null,
        },
      });
    }
    if (e instanceof SearchError) throw searchErrorToMcp(e);
    if (e instanceof MCPError) throw e;
    throw new MCPError(INTERNAL_ERROR, e instanceof Error ? e.message : String(e));
  }

  const recallHint = deriveRecallHint(outcome.results, outcome.total);
  const telemetryRecord = telemetry
    ? emitRecallTelemetry(ctx.vault, {
        host: telemetryHost,
        ...(telemetrySessionId !== undefined ? { sessionId: telemetrySessionId } : {}),
        ...(telemetryTurnId !== undefined ? { turnId: telemetryTurnId } : {}),
        mode: "search",
        status: outcome.results.length > 0 ? "ok" : "empty",
        durationMs: Date.now() - startedAtMs,
        resultCount: outcome.results.length,
        topArtifacts: outcome.results.slice(0, 10).map((result) => ({
          id: `${result.documentId}:${result.chunkId}`,
          path: result.path,
          score: result.score,
        })),
        gaps: searchTelemetryGaps(outcome),
        metadata: {
          limit,
          total: outcome.total,
          keyword_only: keywordOnly,
          semantic: semantic ?? null,
          evidence_pack: evidencePack,
          warnings_count: outcome.warnings.length,
          ...(pathPrefix !== undefined ? { path_prefix: pathPrefix } : {}),
        },
      })
    : null;
  return {
    results: outcome.results.map((r: BrainSearchResult) => ({
      path: r.path,
      title: r.title,
      content: truncateContent(r.content, MCP_CONTENT_MAX),
      score: r.score,
      startLine: r.startLine,
      endLine: r.endLine,
      searchType: r.searchType,
      reasons: r.reasons,
      ...(outcome.evidencePack ? { why_retrieved: r.reasons } : {}),
      ...(r.relations && r.relations.length > 0 ? { relations: r.relations } : {}),
    })),
    warnings: outcome.warnings,
    total: outcome.total,
    ...(outcome.evidencePack ? { evidence_pack: mcpEvidencePack(outcome.evidencePack) } : {}),
    ...(recallHint !== null ? { recall_hint: recallHint } : {}),
    ...(telemetryRecord ? { telemetry_id: telemetryRecord.id } : {}),
  };
}

function searchTelemetryGaps(outcome: SearchOutcome): ReadonlyArray<string> {
  const gaps = new Set<string>();
  if (outcome.total === 0) gaps.add("no_matching_context");
  for (const term of outcome.evidencePack?.missingTerms ?? []) {
    gaps.add(`missing_term:${term}`);
  }
  return [...gaps];
}

function mcpEvidencePack(
  pack: NonNullable<SearchOutcome["evidencePack"]>,
): Record<string, unknown> {
  return {
    significant_terms: pack.significantTerms,
    matched_terms: pack.matchedTerms,
    missing_terms: pack.missingTerms,
    support_coverage: pack.supportCoverage,
    records: pack.records.map((record) => ({
      path: record.path,
      document_id: record.documentId,
      chunk_id: record.chunkId,
      matched_terms: record.matchedTerms,
      missing_terms: record.missingTerms,
      support_coverage: record.supportCoverage,
      terminal_state: record.terminalState,
      why_retrieved: record.whyRetrieved,
      dropped_candidate_reasons: record.droppedCandidateReasons,
    })),
    dropped_candidates: pack.droppedCandidates,
    abstention: pack.abstention,
    ...(pack.idfWeightedCoverage !== undefined
      ? { idf_weighted_coverage: pack.idfWeightedCoverage }
      : {}),
    ...(pack.rareTerms !== undefined ? { rare_terms: pack.rareTerms } : {}),
    ...(pack.uncoveredRareTerms !== undefined
      ? { uncovered_rare_terms: pack.uncoveredRareTerms }
      : {}),
    ...(pack.unionRecords !== undefined
      ? {
          union_records: pack.unionRecords.map((r) => ({
            term: r.term,
            path: r.path,
            document_id: r.documentId,
            chunk_id: r.chunkId,
          })),
        }
      : {}),
  };
}

async function toolBrainRecallGate(
  _ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const prompt = args["prompt"];
  if (typeof prompt !== "string" || prompt.trim() === "") {
    throw new MCPError(INVALID_PARAMS, "missing required argument: prompt");
  }
  if (prompt.length > 4000) {
    throw new MCPError(INVALID_PARAMS, "argument 'prompt' exceeds 4000 characters");
  }
  const previousPrompt = coerceStringOptional(args, "previous_prompt", 4000);
  const explicit = coerceBoolOptional(args, "explicit") ?? false;
  return {
    ...evaluateSurfacingGate({
      prompt,
      previousPrompt: previousPrompt ?? null,
      explicit,
    }),
  };
}

const RECALL_FEEDBACK_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    query: { type: "string", minLength: 1, maxLength: 2000 },
    result_path: { type: "string", minLength: 1, maxLength: 512 },
    verdict: { type: "string", enum: ["up", "down"] },
  },
  required: ["query", "result_path", "verdict"],
  additionalProperties: false,
};

const RECALL_FEEDBACK_OUTPUT_SCHEMA: NonNullable<ToolDefinition["outputSchema"]> = {
  type: "object",
  properties: {
    recorded: { type: "boolean" },
    result_found: { type: "boolean" },
    learned: { type: "object" },
  },
  required: ["recorded", "result_found", "learned"],
};

/**
 * `brain_recall_feedback` (recall-trust-suite): record one explicit
 * per-result recall feedback event. The judged result's per-layer
 * contributions are captured by re-running the query; the learned
 * weights refresh deterministically from the full event set.
 */
async function toolBrainRecallFeedback(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<unknown> {
  const query = coerceStr(args, "query")!;
  const resultPath = coerceStr(args, "result_path")!;
  const verdict = coerceStr(args, "verdict")!;
  if (verdict !== "up" && verdict !== "down") {
    throw new MCPError(INVALID_PARAMS, "argument 'verdict' must be 'up' or 'down'");
  }
  const config = resolveSearchConfig({
    vault: ctx.vault,
    configPath: ctx.configPath ?? undefined,
  });
  const outcome = await captureRecallFeedback(config, { query, resultPath, verdict });
  return {
    recorded: true,
    result_found: outcome.resultFound,
    learned: outcome.learned,
  };
}

export const SEARCH_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: "brain_recall_feedback",
    description:
      "Record explicit recall feedback (up/down) for one search result. Feeds the deterministic learned-weight fold; events land under Brain/search/feedback/.",
    inputSchema: RECALL_FEEDBACK_INPUT_SCHEMA,
    outputSchema: RECALL_FEEDBACK_OUTPUT_SCHEMA,
    handler: toolBrainRecallFeedback,
  },
  {
    name: "brain_recall_gate",
    description:
      "Classify whether an automatic recall/surfacing attempt should run. Diagnostics only; does not search.",
    inputSchema: RECALL_GATE_INPUT_SCHEMA,
    outputSchema: RECALL_GATE_OUTPUT_SCHEMA,
    handler: toolBrainRecallGate,
  },
  {
    name: "brain_search",
    description:
      "Full-text search across the vault. Optional semantic layer when configured. Read-only.",
    inputSchema: SEARCH_INPUT_SCHEMA,
    outputSchema: SEARCH_OUTPUT_SCHEMA,
    previewBudget: MCP_PREVIEW_BUDGET,
    handler: toolBrainSearch,
  },
]);

/**
 * `search.*` block for `second_brain_status`. Mirrors design §9
 * exactly. Never throws — returns `{ exists: false, hint }` if the
 * index does not exist; surfaces errors as `error: "<message>"`.
 */
export async function buildSearchStatusBlock(ctx: ServerContext): Promise<Record<string, unknown>> {
  try {
    const config = resolveSearchConfig({
      vault: ctx.vault,
      configPath: ctx.configPath ?? undefined,
    });
    const snap = await indexStatus(config);
    if (!snap.exists) {
      return { exists: false, hint: "run: o2b search index" };
    }
    return {
      index_path: snap.indexPath,
      exists: true,
      schema_version: snap.schemaVersion,
      documents: snap.documents,
      chunks: snap.chunks,
      embeddings: snap.embeddings,
      stale_embeddings: snap.staleEmbeddings,
      embedding_model: snap.embeddingModel,
      embedding_dimension: snap.embeddingDimension,
      vec_extension: snap.vecExtension,
      semantic_enabled: snap.semanticEnabled,
      embedding_key_present: snap.embeddingKeyPresent,
      last_indexed_at: snap.lastIndexedAt,
      last_full_index_at: snap.lastFullIndexAt,
    };
  } catch (e) {
    return { exists: false, error: e instanceof Error ? e.message : String(e) };
  }
}
