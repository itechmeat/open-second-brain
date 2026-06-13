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
import { searchAcrossVaults } from "../core/search/cross-vault.ts";
import { withTimeout } from "../core/search/with-timeout.ts";
import { defaultConfigPath, resolveRecallGateTelemetry } from "../core/config.ts";
import { INTERNAL_ERROR, INVALID_PARAMS, MCPError } from "./protocol.ts";
import type { ServerContext, ToolDefinition } from "./tools.ts";
import { coerceBoolOptional, coerceStr, coerceStringOptional } from "./coerce.ts";
import { MCP_PREVIEW_BUDGET } from "./preview-budget.ts";
import { deriveRecallHint } from "../core/search/recall-hint.ts";
import { projectScoreBreakdown } from "../core/search/enrich.ts";
import { recordReinforce } from "../core/search/reinforce.ts";
import { parseRecallBenchmarkDataset, runRecallBenchmark } from "../core/search/benchmark.ts";
import { emitRecallTelemetry } from "../core/brain/recall-telemetry.ts";
import { emitGateTelemetry } from "../core/brain/gate-telemetry.ts";
import { emitGatedTelemetry } from "../core/brain/continuity/emit.ts";

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
    focus_session: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      description: "Session id whose bound focus applies (falls back to the global focus).",
    },
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
    explain: {
      type: "boolean",
      description:
        "Include a structured score_breakdown (per-layer numeric components) on each result. Default false.",
    },
    trust: {
      type: "boolean",
      description:
        "Stamp each result with inline trust metadata (age_days, superseded, conflict), computed at read time. Default false.",
    },
    threshold: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description:
        "Relevance floor in [0,1] on the final score; drops weaker hits so an irrelevant query returns no match. Default 0 (disabled).",
    },
    rerank: {
      type: "boolean",
      description:
        "Re-order the threshold-qualified results by core textual relevance (keyword + semantic). Default false.",
    },
    reinforce: {
      type: "array",
      maxItems: 50,
      items: { type: "string", minLength: 1, maxLength: 512 },
      description:
        "Paths proven useful: recorded to the reinforce ledger and lifted (bounded) before the top_k cut. Default absent.",
    },
    record_access: {
      type: "boolean",
      description:
        "Record the surfaced paths as one activation access event (feeds the usage-aware ranking layer). Default true; never recorded for global searches.",
    },
    global: {
      type: "boolean",
      description:
        "Cross-vault union: search profile vaults and read-only recall sources too, merging results with origin labels. Default false (active vault only).",
    },
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
        "Optional content-visibility scope; untagged pages always match, tagged pages only when this scope includes one of their values.",
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
          score_breakdown: {
            type: "object",
            properties: {
              keyword: { type: "number" },
              semantic: { type: "number" },
              rrf: { type: "number" },
              entity: { type: "number" },
              activation: { type: "number" },
              coAccess: { type: "number" },
              link: { type: "number" },
              recency: { type: "number" },
              tier: { type: "number" },
              trend: { type: "number" },
              sessionFocus: { type: "number" },
            },
          },
          origin: { type: "string" },
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
          trust: {
            type: "object",
            properties: {
              age_days: { type: "integer" },
              superseded: { type: "boolean" },
              conflict: { type: "boolean" },
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
    telemetry_host: { type: "string", maxLength: 200 },
    session_id: { type: "string", maxLength: 512 },
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

function parseReinforceArgument(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new MCPError(INVALID_PARAMS, "argument 'reinforce' must be an array of strings");
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      throw new MCPError(INVALID_PARAMS, "argument 'reinforce' must contain only strings");
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
  const explain = coerceBoolOptional(args, "explain") ?? false;
  const trust = coerceBoolOptional(args, "trust") ?? false;
  const rerank = coerceBoolOptional(args, "rerank") ?? false;
  let threshold: number | undefined;
  if ("threshold" in args && args["threshold"] !== undefined && args["threshold"] !== null) {
    const raw = args["threshold"];
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 1) {
      throw new MCPError(INVALID_PARAMS, "argument 'threshold' must be a number between 0 and 1");
    }
    threshold = raw;
  }
  const globalSearch = coerceBoolOptional(args, "global") ?? false;
  const pathPrefix = coerceStringOptional(args, "path_prefix", 256);
  const evidencePack = coerceBoolOptional(args, "evidence_pack") ?? false;
  const includeSuperseded = coerceBoolOptional(args, "include_superseded") ?? false;
  const since = coerceStringOptional(args, "since", 64);
  const until = coerceStringOptional(args, "until", 64);
  const recordAccess = coerceBoolOptional(args, "record_access") ?? true;
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
  const focusSession = coerceStringOptional(args, "focus_session", 128);
  const properties = parsePropertiesArgument(args["properties"]);
  const visibility = parseVisibilityArgument(args["visibility"]);
  const reinforce = parseReinforceArgument(args["reinforce"]);

  const config = resolveSearchConfig({
    vault: ctx.vault,
    configPath: ctx.configPath ?? undefined,
  });

  // Self-tuning reinforce (Search & Recall Quality Suite): the ledger
  // write is the surface's side effect, recorded BEFORE the query so the
  // just-named paths participate in this query's bounded boost. The pure
  // re-rank lives in core. Best-effort: a failed write never breaks the
  // search.
  if (reinforce !== undefined && reinforce.length > 0) {
    try {
      recordReinforce(ctx.vault, reinforce);
    } catch {
      // Ledger persistence is best-effort.
    }
  }

  let outcome: SearchOutcome;
  const startedAtMs = Date.now();
  const searchOpts = {
    query,
    limit,
    semantic: semantic ?? null,
    keywordOnly,
    pathPrefix,
    ...(properties !== undefined ? { properties } : {}),
    ...(visibility !== undefined ? { visibility } : {}),
    ...(structuredQuery !== undefined ? { structuredQuery } : {}),
    ...(sessionFocus !== undefined ? { sessionFocus } : {}),
    ...(focusSession !== undefined ? { focusSession } : {}),
    ...(evidencePack ? { evidencePack: true } : {}),
    ...(includeSuperseded ? { includeSuperseded: true } : {}),
    ...(trust ? { trust: true } : {}),
    ...(threshold !== undefined ? { threshold } : {}),
    ...(rerank ? { rerank: true } : {}),
    ...(reinforce !== undefined ? { reinforce } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
    // Access recording (Time-Aware Recall & Activation Suite): the MCP
    // surface opts in by default; record_access=false suppresses it,
    // and cross-vault union never records (results span foreign vaults).
    ...(recordAccess && !globalSearch ? { recordAccess: true } : {}),
  };
  try {
    // Cross-vault union (t_72a22658): explicit per-call opt-in.
    outcome = await withTimeout(
      globalSearch
        ? searchAcrossVaults(ctx.configPath ?? defaultConfigPath(), ctx.vault, searchOpts, config)
        : search(config, searchOpts),
      SEARCH_TIMEOUT_MS,
      searchTimeoutError,
    );
  } catch (e) {
    // Lazy emit kernel (t_5d7aa7c5): a throwing telemetry write inside
    // this catch can no longer mask the original search error.
    emitGatedTelemetry(telemetry || undefined, () =>
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
      }),
    );
    if (e instanceof SearchError) throw searchErrorToMcp(e);
    if (e instanceof MCPError) throw e;
    throw new MCPError(INTERNAL_ERROR, e instanceof Error ? e.message : String(e));
  }

  const recallHint = deriveRecallHint(outcome.results, outcome.total);
  const telemetryRecord = emitGatedTelemetry(telemetry || undefined, () =>
    emitRecallTelemetry(ctx.vault, {
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
    }),
  );
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
      ...(explain ? { score_breakdown: projectScoreBreakdown(r) } : {}),
      ...(r.trust !== undefined ? { trust: r.trust } : {}),
      ...(r.origin !== undefined ? { origin: r.origin } : {}),
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
    ...(pack.completeness !== undefined
      ? {
          completeness: {
            verdict: pack.completeness.verdict,
            idf_weighted_coverage: pack.completeness.idfWeightedCoverage,
            covered_terms: pack.completeness.coveredTerms,
            uncovered_terms: pack.completeness.uncoveredTerms,
            uncovered_but_present_in_corpus: pack.completeness.uncoveredButPresentInCorpus,
          },
        }
      : {}),
  };
}

async function toolBrainRecallGate(
  ctx: ServerContext,
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
  const decision = evaluateSurfacingGate({
    prompt,
    previousPrompt: previousPrompt ?? null,
    explicit,
  });
  // Gate telemetry (t_65036e02): default off. Routed through the lazy
  // emit kernel (t_5d7aa7c5) - the payload thunk never runs with the
  // config off, and a broken continuity store never breaks the gate's
  // pure-diagnostic contract (fail-open).
  emitGatedTelemetry(resolveRecallGateTelemetry(ctx.configPath ?? undefined), () => {
    const host = coerceStringOptional(args, "telemetry_host", 200) ?? "mcp";
    const sessionId = coerceStringOptional(args, "session_id", 512);
    return emitGateTelemetry(ctx.vault, {
      host,
      prompt,
      retrieve: decision.retrieve,
      reason: decision.reason,
      ...(sessionId !== undefined ? { sessionId } : {}),
    });
  });
  return { ...decision };
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

const EVAL_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    dataset: {
      type: "object",
      description:
        "Eval dataset: { queries: [{ id, query, expected[], k?, answer? }] }. Scored against the active vault.",
      properties: {
        queries: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["id", "query", "expected"],
            properties: {
              id: { type: "string", minLength: 1 },
              query: { type: "string", minLength: 1 },
              expected: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
              k: { type: "integer", minimum: 1 },
              answer: { type: "string", minLength: 1 },
            },
          },
        },
      },
      required: ["queries"],
    },
    k: { type: "integer", minimum: 1, maximum: MCP_LIMIT_MAX },
    expand: { type: "boolean" },
  },
  required: ["dataset"],
  additionalProperties: false,
};

const EVAL_OUTPUT_SCHEMA: NonNullable<ToolDefinition["outputSchema"]> = {
  type: "object",
  required: [
    "total",
    "k",
    "hit_at_k",
    "mrr",
    "answer_queries",
    "answer_containment_at_k",
    "source_utilization_at_k",
    "citation_depth",
    "source_warnings",
  ],
  properties: {
    total: { type: "integer" },
    k: { type: "integer" },
    expand: { type: "boolean" },
    hit_at_k: { type: "number" },
    mrr: { type: "number" },
    answer_queries: { type: "integer" },
    answer_containment_at_k: { type: "number" },
    source_utilization_at_k: { type: "number" },
    citation_depth: { type: "number" },
    source_warnings: { type: "integer" },
    per_query: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          hit: { type: "boolean" },
          rank: { type: "integer" },
          answer_contained: { type: "boolean" },
        },
      },
    },
  },
};

const EVAL_TIMEOUT_MS = 60_000;

/**
 * `brain_eval` (Search & Recall Quality Suite): run the recall benchmark
 * over a caller-supplied dataset against the active vault and return the
 * quality metrics - hit@k, MRR, answer-containment@k, source-utilization,
 * citation-depth, and the source-warnings count a CI gate can cap.
 * Read-only; the fast path needs no embedding key.
 */
async function toolBrainEval(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let dataset;
  try {
    dataset = parseRecallBenchmarkDataset(args["dataset"]);
  } catch (e) {
    if (e instanceof SearchError) throw searchErrorToMcp(e);
    throw new MCPError(INVALID_PARAMS, e instanceof Error ? e.message : String(e));
  }
  let k: number | undefined;
  if ("k" in args && args["k"] !== undefined && args["k"] !== null) {
    const raw = args["k"];
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > MCP_LIMIT_MAX) {
      throw new MCPError(
        INVALID_PARAMS,
        `argument 'k' must be an integer between 1 and ${MCP_LIMIT_MAX}`,
      );
    }
    k = raw;
  }
  const expand = coerceBoolOptional(args, "expand") ?? false;
  const config = resolveSearchConfig({
    vault: ctx.vault,
    configPath: ctx.configPath ?? undefined,
  });
  let report;
  try {
    report = await withTimeout(
      runRecallBenchmark(config, dataset, { ...(k !== undefined ? { k } : {}), expand }),
      EVAL_TIMEOUT_MS,
      searchTimeoutError,
    );
  } catch (e) {
    if (e instanceof SearchError) throw searchErrorToMcp(e);
    if (e instanceof MCPError) throw e;
    throw new MCPError(INTERNAL_ERROR, e instanceof Error ? e.message : String(e));
  }
  return {
    total: report.total,
    k: report.k,
    expand: report.expand,
    hit_at_k: report.hitAtK,
    mrr: report.mrr,
    answer_queries: report.answerQueries,
    answer_containment_at_k: report.answerContainmentAtK,
    source_utilization_at_k: report.sourceUtilizationAtK,
    citation_depth: report.citationDepth,
    source_warnings: report.sourceWarnings,
    per_query: report.perQuery.map((q) => ({
      id: q.id,
      hit: q.hit,
      ...(q.rank !== null ? { rank: q.rank } : {}),
      ...(q.answerContained !== null ? { answer_contained: q.answerContained } : {}),
    })),
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
  {
    name: "brain_eval",
    description:
      "Score retrieval quality over a dataset against the active vault: hit@k, MRR, answer-containment@k, source-utilization, citation-depth, source warnings. Read-only.",
    inputSchema: EVAL_INPUT_SCHEMA,
    outputSchema: EVAL_OUTPUT_SCHEMA,
    previewBudget: MCP_PREVIEW_BUDGET,
    handler: toolBrainEval,
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
