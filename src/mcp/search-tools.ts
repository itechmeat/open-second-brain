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

import { indexStatus, resolveSearchConfig, search, SearchError } from "../core/search/index.ts";
import type { BrainSearchResult, SearchOutcome } from "../core/search/index.ts";
import { withTimeout } from "../core/search/with-timeout.ts";
import { INTERNAL_ERROR, INVALID_PARAMS, MCPError } from "./protocol.ts";
import type { ServerContext, ToolDefinition } from "./tools.ts";
import { coerceBoolOptional, coerceStringOptional } from "./coerce.ts";

const MCP_LIMIT_MAX = 50;
const MCP_CONTENT_MAX = 600;
const SEARCH_TIMEOUT_MS = 10_000;

const SEARCH_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    query: { type: "string", minLength: 1, maxLength: 2000 },
    limit: { type: "integer", minimum: 1, maximum: MCP_LIMIT_MAX },
    semantic: { type: "boolean" },
    keyword_only: { type: "boolean" },
    path_prefix: { type: "string", maxLength: 256 },
    properties: {
      type: "object",
      description:
        "Optional frontmatter property filter (v0.10.17). Each key maps to one or more accepted scalar values; multi-value within a key is OR, multiple keys is AND.",
      additionalProperties: {
        type: "array",
        items: { type: "string" },
      },
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
        },
      },
    },
    warnings: { type: "array", items: { type: "string" } },
    total: { type: "integer" },
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
  const properties = parsePropertiesArgument(args["properties"]);

  const config = resolveSearchConfig({
    vault: ctx.vault,
    configPath: ctx.configPath ?? undefined,
  });

  let outcome: SearchOutcome;
  try {
    outcome = await withTimeout(
      search(config, {
        query,
        limit,
        semantic: semantic ?? null,
        keywordOnly,
        pathPrefix,
        ...(properties !== undefined ? { properties } : {}),
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
    results: outcome.results.map((r: BrainSearchResult) => ({
      path: r.path,
      title: r.title,
      content: truncateContent(r.content, MCP_CONTENT_MAX),
      score: r.score,
      startLine: r.startLine,
      endLine: r.endLine,
      searchType: r.searchType,
      reasons: r.reasons,
    })),
    warnings: outcome.warnings,
    total: outcome.total,
  };
}

export const SEARCH_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: "brain_search",
    description:
      "Full-text search across the vault. Optional semantic layer when configured. Read-only.",
    inputSchema: SEARCH_INPUT_SCHEMA,
    outputSchema: SEARCH_OUTPUT_SCHEMA,
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
