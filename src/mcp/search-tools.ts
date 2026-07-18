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
  EMBEDDING_QUOTA_MESSAGE,
  evaluateSurfacingGate,
  expandHit,
  indexStatus,
  resolveSearchConfig,
  search,
  SearchError,
  serializeEvidencePack,
  serializeSearchCard,
  serializeIndexStatus,
} from "../core/search/index.ts";
import { normalizeSessionFocus, parseStructuredRecallQueryDocument } from "../core/search/index.ts";
import type { BrainSearchResult, SearchOutcome } from "../core/search/index.ts";
import { searchAcrossVaults } from "../core/search/cross-vault.ts";
import { RECALL_PROFILE_NAMES } from "../core/search/profiles.ts";
import { fileContextRecall } from "../core/brain/file-recall.ts";
import { withTimeout } from "../core/search/with-timeout.ts";
import {
  defaultConfigPath,
  resolveRecallAdequacyThresholds,
  resolveRecallGateTelemetry,
} from "../core/config.ts";
import { assessRecallAdequacy } from "../core/brain/recall-adequacy.ts";
import { INTERNAL_ERROR, INVALID_PARAMS, MCPError } from "./protocol.ts";
import type { ServerContext, ToolDefinition } from "./tool-contract.ts";
import { coerceBoolOptional, coerceStr, coerceStringOptional } from "./coerce.ts";
import { MCP_PREVIEW_BUDGET } from "./preview-budget.ts";
import { deriveRecallHint } from "../core/search/recall-hint.ts";
import { projectScoreBreakdown } from "../core/search/enrich.ts";
import { recordReinforce } from "../core/search/reinforce.ts";
import { parseRecallBenchmarkDataset, runRecallBenchmark } from "../core/search/benchmark.ts";
import { emitRecallTelemetry } from "../core/brain/recall-telemetry.ts";
import { emitGateTelemetry } from "../core/brain/gate-telemetry.ts";
import { emitGatedTelemetry } from "../core/brain/continuity/emit.ts";
import { recordQueryDemand } from "../core/brain/query-demand.ts";

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
    disclosure: {
      type: "string",
      enum: ["full", "cards"],
      description:
        "Result depth: 'full' (default) returns full chunk content; 'cards' returns token-cheap layer-1 cards — drill a hit with brain_search_expand.",
    },
    profile: {
      type: "string",
      enum: [...RECALL_PROFILE_NAMES],
      description:
        "Named recall profile (fast|balanced|thorough): a fixed knob preset, preferred over persisted self-tuning. Absent leaves ranking unchanged.",
    },
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
    agent_scope: {
      type: "string",
      description:
        "Optional agent-ownership scope; shared (ownerless) pages always match, owner-tagged pages only their owner. Absent = no ownership filtering.",
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
          // Titles are nullable for markdown files without frontmatter/title.
          // The lightweight contract validator has no union types, so leave
          // this field unconstrained while keeping it required in the shape.
          title: {},
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
    cards: {
      type: "array",
      items: {
        type: "object",
        required: [
          "path",
          "title",
          "score",
          "snippet",
          "pointer",
          "reasons",
          "document_id",
          "chunk_id",
        ],
        properties: {
          path: { type: "string" },
          // Nullable, same as full search result titles above.
          title: {},
          score: { type: "number" },
          snippet: { type: "string" },
          pointer: { type: "string" },
          reasons: { type: "array", items: { type: "string" } },
          document_id: { type: "integer" },
          chunk_id: { type: "integer" },
          origin: { type: "string" },
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
    scores: {
      type: "array",
      maxItems: 200,
      items: { type: "number" },
      description:
        "Optional top-k recall relevance scores. When given, the gate adds an adequacy verdict: sufficient/proceed, weak/re_recall, or insufficient/abstain.",
    },
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
    adequacy: {
      type: "object",
      required: [
        "level",
        "action",
        "escalate",
        "result_count",
        "top_score",
        "mean_score",
        "reason",
      ],
      properties: {
        level: { type: "string", enum: ["sufficient", "weak", "insufficient"] },
        action: { type: "string", enum: ["proceed", "re_recall", "abstain"] },
        escalate: { type: "boolean" },
        result_count: { type: "integer" },
        top_score: { type: "number" },
        mean_score: { type: "number" },
        reason: { type: "string" },
      },
    },
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

export function searchErrorToMcp(e: SearchError): MCPError {
  if (e.code === "INVALID_INPUT") return new MCPError(INVALID_PARAMS, e.message);
  if (e.code === "EMBEDDING_QUOTA_EXHAUSTED") {
    return new MCPError(INTERNAL_ERROR, EMBEDDING_QUOTA_MESSAGE);
  }
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
  const disclosure = coerceStringOptional(args, "disclosure", 16);
  if (disclosure !== undefined && disclosure !== "full" && disclosure !== "cards") {
    throw new MCPError(INVALID_PARAMS, "argument 'disclosure' must be 'full' or 'cards'");
  }
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
  const profile = coerceStringOptional(args, "profile", 32);
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
  const agentScope = coerceStringOptional(args, "agent_scope", 128);
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
    ...(profile !== undefined ? { profile } : {}),
    ...(disclosure === "cards" ? { disclosure: "cards" as const } : {}),
    ...(properties !== undefined ? { properties } : {}),
    ...(visibility !== undefined ? { visibility } : {}),
    ...(agentScope !== undefined ? { agentScope } : {}),
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
  // Under disclosure:'cards' the surfaced rows live on `cards`, not
  // `results`; both shapes carry documentId/chunkId/path/score, so the
  // telemetry count/status/top-artifacts stay honest either way.
  const surfaced = outcome.cards ?? outcome.results;
  const telemetryRecord = emitGatedTelemetry(telemetry || undefined, () =>
    emitRecallTelemetry(ctx.vault, {
      host: telemetryHost,
      ...(telemetrySessionId !== undefined ? { sessionId: telemetrySessionId } : {}),
      ...(telemetryTurnId !== undefined ? { turnId: telemetryTurnId } : {}),
      mode: "search",
      status: surfaced.length > 0 ? "ok" : "empty",
      durationMs: Date.now() - startedAtMs,
      resultCount: surfaced.length,
      topArtifacts: surfaced.slice(0, 10).map((result) => ({
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
  // Cross-query demand log (t_97091fff): persist the normalized query
  // terms, result count, and (when the evidence pack computed it) the
  // IDF-weighted coverage so recurring poorly-answered queries can be
  // surfaced as unmet-demand knowledge gaps. Gated behind the same
  // telemetry opt-in and fail-open — a log write never breaks search.
  emitGatedTelemetry(telemetry || undefined, () =>
    recordQueryDemand(ctx.vault, {
      query,
      resultCount: surfaced.length,
      coverage: outcome.evidencePack?.idfWeightedCoverage ?? null,
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
    ...(outcome.cards ? { cards: outcome.cards.map(serializeSearchCard) } : {}),
    warnings: outcome.warnings,
    total: outcome.total,
    ...(outcome.evidencePack ? { evidence_pack: serializeEvidencePack(outcome.evidencePack) } : {}),
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
  // Adequacy verdict (t_b8f66fec): thin verdict + action layer over the
  // relevance scores of a recall attempt. Only computed when the caller
  // passes `scores`, keeping the pure structural-gate contract otherwise.
  const scores = parseRecallScores(args["scores"]);
  if (scores === undefined) return { ...decision };
  const thresholds = resolveRecallAdequacyThresholds(ctx.configPath ?? undefined);
  const verdict = assessRecallAdequacy(scores, thresholds);
  return {
    ...decision,
    adequacy: {
      level: verdict.level,
      action: verdict.action,
      escalate: verdict.escalate,
      result_count: verdict.resultCount,
      top_score: verdict.topScore,
      mean_score: verdict.meanScore,
      reason: verdict.reason,
    },
  };
}

/**
 * Parse the optional `scores` argument for the recall gate. Returns
 * `undefined` when absent (verdict skipped) and throws INVALID_PARAMS on
 * a malformed shape so callers get a clear error rather than a silently
 * dropped verdict. An empty array is a valid "no results" signal.
 */
function parseRecallScores(raw: unknown): ReadonlyArray<number> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new MCPError(INVALID_PARAMS, "argument 'scores' must be an array of numbers");
  }
  if (raw.length > 200) {
    throw new MCPError(INVALID_PARAMS, "argument 'scores' must not exceed 200 items");
  }
  for (const item of raw) {
    if (typeof item !== "number") {
      throw new MCPError(INVALID_PARAMS, "argument 'scores' must contain only numbers");
    }
  }
  return raw as ReadonlyArray<number>;
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
              k: { type: "integer", minimum: 1, maximum: MCP_LIMIT_MAX },
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
  // Bound per-query rank depth at the untrusted MCP boundary. The library
  // accepts any positive `k`, but an over-MCP caller must not bypass the
  // top-level `k <= MCP_LIMIT_MAX` guard with a deep per-query override and
  // trigger expensive searches.
  for (const q of dataset.queries) {
    if (q.k !== undefined && q.k > MCP_LIMIT_MAX) {
      throw new MCPError(INVALID_PARAMS, `query '${q.id}' k must not exceed ${MCP_LIMIT_MAX}`);
    }
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

const FILE_CONTEXT_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    file_path: { type: "string", minLength: 1, maxLength: 1024 },
    limit: { type: "integer", minimum: 1, maximum: MCP_LIMIT_MAX },
    min_bytes: { type: "integer", minimum: 0, maximum: 10_000_000 },
  },
  required: ["file_path"],
  additionalProperties: false,
};

const FILE_CONTEXT_OUTPUT_SCHEMA: NonNullable<ToolDefinition["outputSchema"]> = {
  type: "object",
  properties: {
    file_path: { type: "string" },
    skipped: { type: "boolean" },
    // reason and title are string-or-null; the contract type is a single
    // value, so the type check is omitted (both nullable shapes pass).
    reason: {},
    query: { type: "string" },
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          title: {},
          score: { type: "number" },
        },
      },
    },
  },
  required: ["file_path", "skipped", "reason", "query", "results"],
};

async function toolBrainFileContext(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const filePath = coerceStr(args, "file_path");
  if (filePath === null || filePath.length > 1024) {
    throw new MCPError(
      INVALID_PARAMS,
      "argument 'file_path' must be a non-empty string up to 1024 characters",
    );
  }
  const limit = coerceIntInRange(args, "limit", 1, MCP_LIMIT_MAX);
  const minBytes = coerceIntInRange(args, "min_bytes", 0, 10_000_000);

  const config = resolveSearchConfig({
    vault: ctx.vault,
    configPath: ctx.configPath ?? undefined,
  });

  try {
    const outcome = await fileContextRecall(config, {
      filePath,
      ...(limit !== undefined ? { limit } : {}),
      ...(minBytes !== undefined ? { minBytes } : {}),
    });
    return {
      file_path: outcome.filePath,
      skipped: outcome.skipped,
      reason: outcome.reason,
      query: outcome.query,
      results: outcome.results.map((r) => ({
        path: r.path,
        title: r.title,
        score: r.score,
      })),
    };
  } catch (e) {
    if (e instanceof SearchError) throw searchErrorToMcp(e);
    if (e instanceof MCPError) throw e;
    throw new MCPError(INTERNAL_ERROR, e instanceof Error ? e.message : String(e));
  }
}

function coerceIntInRange(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  if (!(key in args) || args[key] === undefined || args[key] === null) return undefined;
  const raw = args[key];
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min || raw > max) {
    throw new MCPError(
      INVALID_PARAMS,
      `argument '${key}' must be an integer between ${min} and ${max}`,
    );
  }
  return raw;
}

const SEARCH_EXPAND_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    chunk_id: {
      type: "integer",
      minimum: 1,
      description: "The chunk_id of a layer-1 card (from brain_search disclosure:'cards').",
    },
    raw_limit: {
      type: "integer",
      minimum: 1,
      maximum: MCP_LIMIT_MAX,
      description: "Layer-3 raw-chunk page size (default 10).",
    },
    cursor: {
      type: "string",
      maxLength: 32,
      description: "Pagination cursor returned as next_cursor by a prior expand call.",
    },
  },
  required: ["chunk_id"],
  additionalProperties: false,
};

const SEARCH_EXPAND_OUTPUT_SCHEMA: NonNullable<ToolDefinition["outputSchema"]> = {
  type: "object",
  required: ["chunk_id", "note", "raw_content", "next_cursor"],
  properties: {
    chunk_id: { type: "integer" },
    note: {
      type: "object",
      required: ["document_id", "path", "title", "line_start", "line_end", "pointer", "content"],
      properties: {
        document_id: { type: "integer" },
        path: { type: "string" },
        // Nullable for title-less notes; the local schema validator does not
        // support union types, so keep the field present but unconstrained.
        title: {},
        line_start: { type: "integer" },
        line_end: { type: "integer" },
        pointer: { type: "string" },
        content: { type: "string" },
      },
    },
    raw_content: {
      type: "array",
      items: {
        type: "object",
        required: ["chunk_id", "chunk_index", "start_line", "end_line", "pointer", "content"],
        properties: {
          chunk_id: { type: "integer" },
          chunk_index: { type: "integer" },
          start_line: { type: "integer" },
          end_line: { type: "integer" },
          pointer: { type: "string" },
          content: { type: "string" },
        },
      },
    },
    // String cursor or null when the raw transcript is exhausted.
    next_cursor: {},
  },
};

/**
 * `brain_search_expand` (progressive disclosure layers 2 + 3): drill a
 * layer-1 card into the fuller note and the paginated raw chunk
 * transcript. Read-only; reuses the existing store read, never rebuilds
 * the index.
 */
async function toolBrainSearchExpand(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const rawChunk = args["chunk_id"];
  if (typeof rawChunk !== "number" || !Number.isInteger(rawChunk) || rawChunk < 1) {
    throw new MCPError(INVALID_PARAMS, "argument 'chunk_id' must be a positive integer");
  }
  const rawLimit = coerceIntInRange(args, "raw_limit", 1, MCP_LIMIT_MAX);
  const cursor = coerceStringOptional(args, "cursor", 32);
  const config = resolveSearchConfig({
    vault: ctx.vault,
    configPath: ctx.configPath ?? undefined,
  });
  let result;
  try {
    result = await withTimeout(
      expandHit(config, {
        chunkId: rawChunk,
        ...(rawLimit !== undefined ? { rawLimit } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
      }),
      SEARCH_TIMEOUT_MS,
      searchTimeoutError,
    );
  } catch (e) {
    if (e instanceof SearchError) throw searchErrorToMcp(e);
    if (e instanceof MCPError) throw e;
    throw new MCPError(INTERNAL_ERROR, e instanceof Error ? e.message : String(e));
  }
  return {
    chunk_id: result.chunkId,
    note: {
      document_id: result.note.documentId,
      path: result.note.path,
      title: result.note.title,
      line_start: result.note.lineStart,
      line_end: result.note.lineEnd,
      pointer: result.note.pointer,
      // Drill-down tool: return the full note (layer 2) and raw chunks
      // (layer 3), not a snippet. The preview budget caps the envelope
      // and hands back an artifact_id when the payload is large.
      content: result.note.content,
    },
    raw_content: result.raw_content.map((c) => ({
      chunk_id: c.chunkId,
      chunk_index: c.chunkIndex,
      start_line: c.startLine,
      end_line: c.endLine,
      pointer: c.pointer,
      content: c.content,
    })),
    next_cursor: result.next_cursor,
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
      "Classify whether an automatic recall/surfacing attempt should run. Diagnostics only; does not search. Pass `scores` (a recall attempt's top-k relevance scores) to also get an adequacy verdict — sufficient (proceed) / weak (re_recall) / insufficient (abstain + escalate).",
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
    name: "brain_search_expand",
    description:
      "Progressive disclosure layers 2 + 3: drill a brain_search card (by chunk_id) into the fuller note and the paginated raw chunk transcript. Read-only; reuses the existing index.",
    inputSchema: SEARCH_EXPAND_INPUT_SCHEMA,
    outputSchema: SEARCH_EXPAND_OUTPUT_SCHEMA,
    previewBudget: MCP_PREVIEW_BUDGET,
    handler: toolBrainSearchExpand,
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
  {
    name: "brain_file_context",
    description:
      "Given a file path, surface prior vault work that mentions it (decisions, bug notes, refactor history) by querying the index with terms derived from the path. A size gate skips trivial files. Read-only; no LLM.",
    inputSchema: FILE_CONTEXT_INPUT_SCHEMA,
    outputSchema: FILE_CONTEXT_OUTPUT_SCHEMA,
    previewBudget: MCP_PREVIEW_BUDGET,
    handler: toolBrainFileContext,
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
    // Token-budget conscious: pick the MCP subset out of the shared
    // serializer's full field set rather than re-declaring the mapping.
    const {
      embedding_signature: _embeddingSignature,
      estimated_refresh_cost_usd: _estimatedRefreshCostUsd,
      warnings: _warnings,
      ...rest
    } = serializeIndexStatus(snap);
    return rest;
  } catch (e) {
    return { exists: false, error: e instanceof Error ? e.message : String(e) };
  }
}
