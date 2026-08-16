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
import { parseDegreePredicate, type DegreePredicate } from "../core/search/property-filter.ts";
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
import {
  NEGATIVE_RECALL_STATE,
  NEGATIVE_RECALL_UNKNOWN_REASONS,
  type NegativeRecallState,
  type NegativeRecallVerdict,
} from "../core/brain/negative-recall.ts";
import {
  RETRIEVAL_DEGRADATION_CODES,
  RETRIEVAL_TRAIL_KEY,
  retrievalTrailEnvelope,
} from "../core/search/retrieval-trail.ts";
import { probeRetrievalCorpus } from "../core/search/pipeline/outcome.ts";
import { INTERNAL_ERROR, INVALID_PARAMS, MCPError } from "./protocol.ts";
import type { ServerContext, ToolDefinition } from "./tool-contract.ts";
import {
  AGENT_SCOPE_SCHEMA,
  MATCH_QUALITY_ARG_NAME,
  matchQualitySchema,
  RECALL_SCORES_SCHEMA,
  coerceAgentScope,
  coerceBoolOptional,
  coerceRecallAdequacyInput,
  coerceStr,
  coerceStringOptional,
  recallAdequacyPairing,
} from "./coerce.ts";
import { MCP_PREVIEW_BUDGET } from "./preview-budget.ts";
import { explainEnvelope } from "../core/search/explain-envelope.ts";
import { deriveRecallHint } from "../core/search/recall-hint.ts";
import {
  ELLIPSIS,
  HEAD_WINDOW_START,
  alignToCodePointStart,
  markWindow,
  matchOffset,
  windowStartWithin,
} from "../core/search/snippet-window.ts";
import { projectScoreBreakdown } from "../core/search/enrich.ts";
import { recordReinforce } from "../core/search/reinforce.ts";
import { parseRecallBenchmarkDataset, runRecallBenchmark } from "../core/search/benchmark.ts";
import {
  deriveRecallSignals,
  emitRecallTelemetry,
  RECALL_CHANNEL,
  RECALL_SIGNALS_UNMEASURED_CARDS,
  recallTelemetryEnvelope,
  type RecallQualitySignals,
  type RecallSignalsUnmeasured,
} from "../core/brain/recall-telemetry.ts";
import { emitGateTelemetry, emitNegativeRecallTelemetry } from "../core/brain/gate-telemetry.ts";
import { emitGatedTelemetry } from "../core/brain/continuity/emit.ts";
import { recordQueryDemand, recordRecallAdequacyDemand } from "../core/brain/query-demand.ts";

const MCP_LIMIT_MAX = 50;
const MCP_CONTENT_MAX = 600;
const SEARCH_TIMEOUT_MS = 10_000;
/** Surfaced rows named as source refs on one recall-telemetry record. */
const TELEMETRY_TOP_ARTIFACTS_MAX = 10;

const SEARCH_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    query: {
      type: "string",
      minLength: 1,
      maxLength: 2000,
      description:
        "What to recall from the vault. Matched against the index by keyword, semantics, or both.",
    },
    query_document: {
      type: "string",
      minLength: 1,
      maxLength: 4000,
      description:
        "Line-oriented query program with intent:, lex:, vec: and hyde: lanes, steering each retrieval layer separately. Absent means 'query' drives every lane.",
    },
    focus_query: {
      type: "string",
      minLength: 1,
      maxLength: 1000,
      description:
        "Steer this one call towards a working-set topic without persisting a session focus.",
    },
    focus_path_prefix: {
      type: "string",
      minLength: 1,
      maxLength: 256,
      description:
        "Steer this one call towards a vault subtree, paired with focus_query as a transient focus.",
    },
    focus_session: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      description: "Session id whose bound focus applies (falls back to the global focus).",
    },
    evidence_pack: {
      type: "boolean",
      description:
        "Return the evidence pack: matched/missing terms, coverage, abstention text and the false-absence guard. Default false.",
    },
    include_superseded: {
      type: "boolean",
      description:
        "History mode for relation polarity: keep matched superseded predecessors undemoted and skip successor pull-in. Default false.",
    },
    since: {
      type: "string",
      maxLength: 64,
      description:
        "Hard filter on event time (validity, body anchor, mtime last): at/after this point. ISO date/datetime, today, yesterday, last week, last month, <n>h/<n>d/<n>w.",
    },
    until: {
      type: "string",
      maxLength: 64,
      description:
        "Hard filter on event time (validity, body anchor, mtime last): at/before this point. Same forms as 'since'.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: MCP_LIMIT_MAX,
      description: "How many ranked results to return. Default 10.",
    },
    semantic: {
      type: "boolean",
      description:
        "Force the semantic lane on or off. Absent lets the configured hybrid strategy decide.",
    },
    keyword_only: {
      type: "boolean",
      description: "Skip the semantic lane entirely, so no embedding is needed. Default false.",
    },
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
        "Add a per-result score_breakdown plus the retrieval_decision_trace and memory_trust_assessment receipts. Default false.",
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
    path_prefix: {
      type: "string",
      maxLength: 256,
      description: "Restrict results to this vault subtree. Absent searches the whole vault.",
    },
    telemetry: {
      type: "boolean",
      description: "Emit one recall-telemetry continuity record for this call. Default false.",
    },
    telemetry_host: {
      type: "string",
      maxLength: 200,
      description: "Optional host/client label recorded on the telemetry record.",
    },
    session_id: {
      type: "string",
      maxLength: 512,
      description: "Optional session correlation id recorded on the telemetry record.",
    },
    turn_id: {
      type: "string",
      maxLength: 512,
      description: "Optional turn correlation id recorded on the telemetry record.",
    },
    properties: {
      type: "object",
      description:
        "Optional frontmatter property filter (v0.10.17). Each key maps to one or more accepted scalar values; multi-value within a key is OR, multiple keys is AND.",
      additionalProperties: {
        type: "array",
        items: { type: "string" },
      },
    },
    degree: {
      type: "array",
      description:
        "Graph-degree predicates over backlink/outlink counts, e.g. 'backlinks=0' (orphans) or 'outlinks>=5' (hubs); ANDed. Absent = no filter.",
      items: { type: "string" },
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
    session_scope: {
      type: "string",
      description:
        "Optional session-scope filter; pages with no session always match, session-tagged pages only this session. Absent = no session filtering.",
    },
    project_scope: {
      type: "string",
      description:
        "Optional project-scope filter; pages with no project always match, project-tagged pages only this project. Absent = no project filtering.",
    },
  },
  required: ["query"],
  additionalProperties: false,
};

/**
 * The negative-recall states a zero-result `brain_search` can report.
 *
 * The same two-of-three narrowing {@link RECALL_GATE_NEGATIVE_STATES}
 * makes, for the same reason: the probe behind the trail supplies neither
 * retraction evidence nor an assertion of non-occurrence, so
 * `did_not_happen` is not a claim this surface has grounds for. Declaring
 * it would leave a client unable to tell "this surface cannot say that"
 * from "it did not happen".
 */
export const SEARCH_NEGATIVE_STATES: ReadonlyArray<NegativeRecallState> = Object.freeze([
  NEGATIVE_RECALL_STATE.notFound,
  NEGATIVE_RECALL_STATE.unknown,
]);

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
          authoredAt: { type: "integer" },
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
          // Exact-duplicate merge: locations folded into this row.
          // Declared deliberately — this output schema does not set
          // `additionalProperties: false`, so an undeclared field would
          // pass validation silently and be invisible to a caller
          // reading the contract.
          duplicates: {
            type: "array",
            items: {
              type: "object",
              required: ["documentId", "chunkId", "path", "title", "startLine", "endLine"],
              properties: {
                documentId: { type: "integer" },
                chunkId: { type: "integer" },
                path: { type: "string" },
                // Nullable, same as the result title above.
                title: {},
                startLine: { type: "integer" },
                endLine: { type: "integer" },
              },
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
          // Exact-duplicate merge: the `path:Lstart-Lend` pointers this
          // card was folded from. Declared deliberately for the same
          // reason `duplicates` is on the full row above - this output
          // schema does not set `additionalProperties: false`, so an
          // undeclared field would validate silently and stay invisible
          // to a caller reading the contract.
          duplicate_pointers: { type: "array", items: { type: "string" } },
        },
      },
    },
    warnings: { type: "array", items: { type: "string" } },
    // The ranked pool the `limit` sliced these rows from (task F) - how
    // many candidates were ranked, not how many came back. The descriptor
    // grammar carries no prose, so the meaning is documented here, in
    // SearchOutcome.total, and in docs/mcp.md.
    total: { type: "integer" },
    recall_hint: { type: "string" },
    evidence_pack: { type: "object" },
    // Retrieval receipts under `explain` (what-the-index-already-knew,
    // task F). Declared deliberately: this output schema does not set
    // `additionalProperties: false`, so an undeclared key would pass
    // validation silently and stay invisible to a caller reading the
    // contract.
    retrieval_decision_trace: {
      type: "object",
      required: ["evaluated", "surfaced", "excluded", "exclusions"],
      properties: {
        evaluated: { type: "integer" },
        surfaced: { type: "integer" },
        excluded: { type: "integer" },
        exclusions: {
          type: "array",
          items: {
            type: "object",
            required: ["document_id", "chunk_id", "path", "reasons"],
            properties: {
              document_id: { type: "integer" },
              chunk_id: { type: "integer" },
              path: { type: "string" },
              reasons: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    },
    memory_trust_assessment: {
      type: "object",
      required: ["evaluated", "surfaced", "quarantined", "reason_counts"],
      properties: {
        evaluated: { type: "integer" },
        surfaced: { type: "integer" },
        quarantined: { type: "integer" },
        // Open-keyed histogram: one integer per namespaced exclusion reason.
        reason_counts: { type: "object" },
      },
    },
    retrieval_trace_unavailable: { type: "string" },
    // Retrieval trail (evidence-at-the-boundary, C2). Declared for the
    // same reason the receipts above are: this schema does not set
    // `additionalProperties: false`, so an undeclared key would validate
    // silently. The `code` enum is the enforcement - the server validates
    // every response against this schema, so emitting a code that is not
    // in `RETRIEVAL_DEGRADATION` fails the contract loudly instead of
    // handing a client a value it cannot interpret. Same rule as
    // {@link RECALL_GATE_NEGATIVE_STATES}.
    [RETRIEVAL_TRAIL_KEY]: {
      type: "object",
      required: ["retrieved", "pool", "degraded"],
      properties: {
        // Rows handed back, which `total` does not state: that is the
        // ranked pool the window was cut from.
        retrieved: { type: "integer" },
        pool: { type: "integer" },
        degraded: {
          type: "array",
          items: {
            type: "object",
            required: ["code"],
            properties: {
              code: { type: "string", enum: [...RETRIEVAL_DEGRADATION_CODES] },
              // Identifiers and integers only, by the vocabulary's own
              // rule; open-keyed because each code names its own fields.
              detail: { type: "object" },
            },
          },
        },
        empty: {
          type: "object",
          required: ["state", "reason"],
          properties: {
            state: { type: "string", enum: [...SEARCH_NEGATIVE_STATES] },
            reason: { type: "string" },
            unknown_reason: { type: "string", enum: [...NEGATIVE_RECALL_UNKNOWN_REASONS] },
          },
        },
      },
    },
    telemetry_id: { type: "string" },
  },
};

/**
 * The argument name the scores are paired with, as the schema spells it.
 *
 * One constant for the property key, the `dependentRequired` entry, and the
 * handler's read, so this tool's declaration and its enforcement cannot
 * drift onto different names.
 */
const RECALL_SCORES_ARG_NAME = "scores";

const RECALL_GATE_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    prompt: {
      type: "string",
      minLength: 1,
      maxLength: 4000,
      description: "The turn's prompt, scored to decide whether recall is worth running at all.",
    },
    previous_prompt: {
      type: "string",
      maxLength: 4000,
      description:
        "The preceding turn's prompt, so a follow-up is judged in context rather than on its own.",
    },
    explicit: {
      type: "boolean",
      description:
        "The user asked for memory in so many words; the gate then retrieves regardless of score. Default false.",
    },
    telemetry_host: {
      type: "string",
      maxLength: 200,
      description: "Optional host/client label recorded on the telemetry record.",
    },
    session_id: {
      type: "string",
      maxLength: 512,
      description: "Optional session correlation id recorded on the telemetry record.",
    },
    [RECALL_SCORES_ARG_NAME]: RECALL_SCORES_SCHEMA,
    [MATCH_QUALITY_ARG_NAME]: matchQualitySchema(RECALL_SCORES_ARG_NAME),
  },
  required: ["prompt"],
  // Both or neither, stated declaratively so a schema-driven client can
  // discover the pairing instead of learning it from an INVALID_PARAMS at
  // call time. Built beside the enforcement; see `recallAdequacyPairing`.
  dependentRequired: recallAdequacyPairing(RECALL_SCORES_ARG_NAME),
  additionalProperties: false,
};

/**
 * The negative-recall states `brain_recall_gate` can actually produce.
 *
 * The vocabulary is three states wide (`NEGATIVE_RECALL_STATES` in
 * `core/brain/negative-recall.ts`); this surface reaches two of them. `did_not_happen` is missing because
 * {@link assessNegativeRecall} supplies neither of the two things that
 * state requires - stored retraction evidence and the caller's assertion
 * of non-occurrence - and it reads no claim graph to find any. Declaring
 * the full vocabulary here would leave a client unable to tell "this
 * surface cannot say that" from "it did not happen this time", which is
 * the same conflation between an unanswerable check and a passing one
 * that the negative-recall unit exists to remove.
 *
 * Enforced, not documentary: the server validates every response against
 * this schema, so wiring an evidence read into the gate without widening
 * this list fails the contract loudly instead of emitting an undeclared
 * value. Order follows the vocabulary's weakest-to-strongest ordering.
 */
export const RECALL_GATE_NEGATIVE_STATES: ReadonlyArray<NegativeRecallState> = Object.freeze([
  NEGATIVE_RECALL_STATE.notFound,
  NEGATIVE_RECALL_STATE.unknown,
]);

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
        // Required, not optional: the block used to return the two scores
        // that decide NOTHING and withhold the one that decides the level,
        // so a caller could not check the verdict against its own input or
        // tell which threshold band it landed beside.
        MATCH_QUALITY_ARG_NAME,
        "reason",
      ],
      properties: {
        level: { type: "string", enum: ["sufficient", "weak", "insufficient"] },
        action: { type: "string", enum: ["proceed", "re_recall", "abstain"] },
        escalate: { type: "boolean" },
        result_count: { type: "integer" },
        top_score: { type: "number" },
        mean_score: { type: "number" },
        [MATCH_QUALITY_ARG_NAME]: { type: "number" },
        reason: { type: "string" },
      },
    },
    // Typed negative recall (silence-is-not-an-answer, U2). Present only
    // when the caller reported no usable result, mirroring `adequacy`
    // above: absent - never null - when it does not apply.
    negative: {
      type: "object",
      required: ["state", "complete", "reason"],
      properties: {
        state: { type: "string", enum: [...RECALL_GATE_NEGATIVE_STATES] },
        complete: { type: "boolean" },
        reason: { type: "string" },
        unknown_reason: { type: "string", enum: [...NEGATIVE_RECALL_UNKNOWN_REASONS] },
        coverage: {
          type: "object",
          required: ["digest", "documents", "chunks", "embeddings", "scope", "unindexed_roots"],
          properties: {
            digest: { type: "string" },
            documents: { type: "integer" },
            chunks: { type: "integer" },
            // Declared beside `chunks` because the pair is the claim: a
            // count below the chunk count is an index a semantic query
            // could not read out in full.
            embeddings: { type: "integer" },
            index_path: { type: "string" },
            // Three fields whose value is an integer/string OR null.
            // The output-schema vocabulary declares one type per node
            // and has no union, so they are declared untyped rather
            // than declared wrongly: a `string` here would make the
            // never-indexed case fail its own contract.
            schema_version: {},
            embedding_signature: {},
            last_indexed_at: {},
            scope: { type: "array", items: { type: "string" } },
            unindexed_roots: { type: "array", items: { type: "string" } },
          },
        },
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

/**
 * Validate the `degree` argument (array of `<field><op><count>` strings)
 * into a predicate list. A malformed shape or predicate throws
 * INVALID_PARAMS rather than silently dropping the filter.
 */
function parseDegreeArgument(raw: unknown): DegreePredicate[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new MCPError(INVALID_PARAMS, "argument 'degree' must be an array of strings");
  }
  const out: DegreePredicate[] = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      throw new MCPError(INVALID_PARAMS, "argument 'degree' must contain only strings");
    }
    try {
      out.push(parseDegreePredicate(item));
    } catch (e) {
      if (e instanceof SearchError) throw searchErrorToMcp(e);
      throw e;
    }
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

/**
 * The `content` window for one MCP result: at most `max` characters
 * INCLUDING its continuation markers, centred on the first significant
 * query term the chunk contains (task E).
 *
 * With no occurrence the window is the head of the chunk and the bytes
 * are exactly what the pre-anchoring head truncation produced: content
 * at or under the cap passes through untouched, and content over it is
 * cut one character short to make room for the trailing marker.
 *
 * Content at or under the cap is a case of the general rule rather than an
 * early return of its own: {@link windowStartWithin} opens it at the head,
 * the budget is the whole cap, `hasMore` is false, and the slice is the
 * string itself. Stating it once means the "never truncate text the cap
 * had room for" invariant cannot drift between this surface and the two
 * that measure their caps in other units.
 *
 * The start is aligned to a code-point boundary because this surface
 * slices UTF-16 units: an anchored start can land on the low half of a
 * surrogate pair, and a body opening with a lone surrogate becomes U+FFFD
 * as soon as the JSON-RPC frame is encoded as UTF-8. The TRAILING cut is
 * deliberately left as it is - it has always cut on a raw offset, its
 * bytes are the pre-anchoring contract this wave must not move, and
 * unlike the head it is not a hazard anchoring introduced.
 */
function windowContent(c: string, query: string, max: number): string {
  const start = alignToCodePointStart(c, windowStartWithin(matchOffset(c, query), max, c.length));
  const budget = max - (start > HEAD_WINDOW_START ? ELLIPSIS.length : 0);
  const hasMore = start + budget < c.length;
  const body = c.slice(start, start + budget - (hasMore ? ELLIPSIS.length : 0));
  return markWindow(body, start, hasMore, ELLIPSIS);
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
  const telemetrySessionId = coerceStringOptional(args, "session_id", 512);
  const telemetryTurnId = coerceStringOptional(args, "turn_id", 512);
  // One envelope for both emit sites below: the correlation fields are
  // copied once, and `channel` is a fact about this handler rather than
  // about the caller-supplied `telemetry_host` string.
  const telemetryEnvelope = recallTelemetryEnvelope({
    host: coerceStringOptional(args, "telemetry_host", 200) ?? RECALL_CHANNEL.mcp,
    channel: RECALL_CHANNEL.mcp,
    ...(telemetrySessionId !== undefined ? { sessionId: telemetrySessionId } : {}),
    ...(telemetryTurnId !== undefined ? { turnId: telemetryTurnId } : {}),
  });
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
  const degreeFilters = parseDegreeArgument(args["degree"]);
  const visibility = parseVisibilityArgument(args["visibility"]);
  const agentScope = coerceAgentScope(ctx, args, false);
  const sessionScope = coerceStringOptional(args, "session_scope", 128);
  const projectScope = coerceStringOptional(args, "project_scope", 128);
  const scope =
    sessionScope !== undefined || projectScope !== undefined
      ? {
          ...(sessionScope !== undefined ? { session: sessionScope } : {}),
          ...(projectScope !== undefined ? { project: projectScope } : {}),
        }
      : undefined;
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
    ...(degreeFilters !== undefined ? { degreeFilters } : {}),
    ...(visibility !== undefined ? { visibility } : {}),
    ...(agentScope !== undefined ? { agentScope } : {}),
    ...(scope !== undefined ? { scope } : {}),
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
        ...telemetryEnvelope,
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
  const telemetryRecord = emitGatedTelemetry(telemetry || undefined, () => {
    // Recall signals (what-the-index-already-knew, task G): derived
    // INSIDE the gated thunk, so with the gate off - the default - not a
    // single comparison runs. `search()` has already returned and its
    // outcome and rows are frozen, so this lane can only read them.
    const signals = searchRecallSignals(outcome);
    return emitRecallTelemetry(ctx.vault, {
      ...telemetryEnvelope,
      mode: "search",
      status: surfaced.length > 0 ? "ok" : "empty",
      durationMs: Date.now() - startedAtMs,
      resultCount: surfaced.length,
      topArtifacts: surfaced.slice(0, TELEMETRY_TOP_ARTIFACTS_MAX).map((result) => ({
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
      ...(signals !== null ? { signals } : {}),
    });
  });
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
      content: windowContent(r.content, query, MCP_CONTENT_MAX),
      score: r.score,
      startLine: r.startLine,
      endLine: r.endLine,
      searchType: r.searchType,
      reasons: r.reasons,
      // Conversation chronology (S1): present only for a note carrying an
      // authored_at instant, so the shape stays byte-identical otherwise.
      ...(r.authoredAt !== undefined ? { authoredAt: r.authoredAt } : {}),
      ...(explain ? { score_breakdown: projectScoreBreakdown(r) } : {}),
      ...(r.trust !== undefined ? { trust: r.trust } : {}),
      ...(r.origin !== undefined ? { origin: r.origin } : {}),
      ...(outcome.evidencePack ? { why_retrieved: r.reasons } : {}),
      ...(r.relations && r.relations.length > 0 ? { relations: r.relations } : {}),
      // Exact-duplicate merge (task D): the locations this row was folded
      // from. Absent, never null, when nothing was merged.
      ...(r.duplicates && r.duplicates.length > 0 ? { duplicates: r.duplicates } : {}),
    })),
    ...(outcome.cards ? { cards: outcome.cards.map(serializeSearchCard) } : {}),
    warnings: outcome.warnings,
    total: outcome.total,
    ...(outcome.evidencePack ? { evidence_pack: serializeEvidencePack(outcome.evidencePack) } : {}),
    ...(recallHint !== null ? { recall_hint: recallHint } : {}),
    // Summary-search router (t_7b96f242): advisory routing hint, present
    // only when the query was structurally routed to the summary surface.
    // Absent on the generic path, so the default response stays
    // byte-identical.
    ...(outcome.surface !== undefined ? { surface: outcome.surface } : {}),
    // Retrieval trail (evidence-at-the-boundary, C2): why this answer
    // narrowed and why it is empty when it is, through the same seam the
    // CLI payload uses so both surfaces name one key with one body.
    // Absent - never null - on a healthy non-empty answer.
    ...retrievalTrailEnvelope(outcome),
    // Retrieval receipts (what-the-index-already-knew, task F): the
    // decision trace and the trust assessment every gated search already
    // built and no surface serialized. Under `explain` only, absent -
    // never null - otherwise; when the gate is off, one line naming the
    // switch that produces them rather than an unexplained silence.
    ...explainEnvelope(outcome, {
      explain,
      crossVault: globalSearch,
      trustGateEnabled: config.recall.retrievalTrustGateEnabled,
    }),
    ...(telemetryRecord ? { telemetry_id: telemetryRecord.id } : {}),
  };
}

/**
 * The recall signals for one query, or `null` when the window is empty
 * and there is nothing to measure - `result_count: 0` already says that.
 *
 * Under `disclosure: "cards"` the pipeline returns projected cards and an
 * EMPTY `results` array, so none of the per-row values the signals are
 * derived from exist; that path records the named unmeasured marker
 * rather than an all-zero block that would read as a measurement.
 */
function searchRecallSignals(
  outcome: SearchOutcome,
): RecallQualitySignals | RecallSignalsUnmeasured | null {
  if (outcome.cards !== undefined) return RECALL_SIGNALS_UNMEASURED_CARDS;
  return deriveRecallSignals(outcome.results);
}

/**
 * The recall-telemetry gaps for one search.
 *
 * `no_matching_context` is the shared gap every producer in this tree
 * emits for an empty answer (`context-pack`, `pre-compress-pack`,
 * `brain_query`), so it stays. What used to be missing is WHY: this
 * function answered the same question as the retrieval trail from the same
 * outcome and invented its own free strings to do it. It now emits the
 * trail's codes, so a gap histogram and a search response name one
 * vocabulary rather than two.
 */
function searchTelemetryGaps(outcome: SearchOutcome): ReadonlyArray<string> {
  const gaps = new Set<string>();
  const trail = outcome.retrievalTrail;
  if (outcome.total === 0) gaps.add("no_matching_context");
  for (const degradation of trail?.degraded ?? []) gaps.add(degradation.code);
  // The corpus statement's `unknown` half is a gap in its own right: it
  // says the index could not answer, not that the vault holds nothing.
  if (trail?.empty?.unknownReason !== undefined) gaps.add(trail.empty.unknownReason);
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
  // Adequacy verdict (t_b8f66fec): thin verdict + action layer over one
  // recall attempt. Only computed when the caller passes the pair,
  // keeping the pure structural-gate contract otherwise.
  const attempt = coerceRecallAdequacyInput("brain_recall_gate", args, RECALL_SCORES_ARG_NAME);
  if (attempt === undefined) return { ...decision };
  const thresholds = resolveRecallAdequacyThresholds(ctx.configPath ?? undefined);
  const verdict = assessRecallAdequacy(attempt, thresholds);
  // signals-that-survive, unit 6: an unmet verdict is stamped onto the
  // cross-query demand log under the bucket key normalizeQueryTerms already
  // computes, so the knowledge-gap loop can aggregate recurrence without a
  // second identity concept. Gated behind the same telemetry opt-in as the
  // gate record above and fail-open — a log write never breaks the gate.
  //
  // `recall_gate_telemetry` is the SINGLE opt-in for this log wherever it
  // is written: `brain_context_pack` writes the same records under the
  // same key (see `brain/pack-tools.ts`), so one config decision governs
  // the whole feature rather than one per surface.
  emitGatedTelemetry(resolveRecallGateTelemetry(ctx.configPath ?? undefined), () =>
    recordRecallAdequacyDemand(ctx.vault, { query: prompt, verdict }),
  );
  // Typed negative recall (silence-is-not-an-answer, U2). The adequacy
  // verdict above judges the HITS; this judges the CORPUS they were drawn
  // from, and only a zero-usable-result attempt has a corpus statement to
  // make. Persisted behind the same `recall_gate_telemetry` opt-in and the
  // same fail-open kernel as everything else this handler writes.
  const negative = verdict.resultCount === 0 ? await assessNegativeRecall(ctx) : null;
  if (negative !== null) {
    emitGatedTelemetry(resolveRecallGateTelemetry(ctx.configPath ?? undefined), () => {
      const sessionId = coerceStringOptional(args, "session_id", 512);
      return emitNegativeRecallTelemetry(ctx.vault, {
        prompt,
        verdict: negative,
        ...(sessionId !== undefined ? { sessionId } : {}),
      });
    });
  }
  return {
    ...decision,
    adequacy: {
      level: verdict.level,
      action: verdict.action,
      escalate: verdict.escalate,
      result_count: verdict.resultCount,
      top_score: verdict.topScore,
      mean_score: verdict.meanScore,
      // The quantity the level was decided by. Returning only the two
      // descriptive scores left the caller unable to reconstruct the
      // verdict from its own inputs.
      [MATCH_QUALITY_ARG_NAME]: verdict.matchQuality,
      reason: verdict.reason,
    },
    // Absent, never null, when the attempt had usable results - the
    // convention the `explain` trace and the `adequacy` block above set.
    ...(negative !== null ? { negative } : {}),
  };
}

/**
 * The corpus statement behind a zero-result recall attempt.
 *
 * The gathering itself lives in `core/search/pipeline/outcome.ts` since
 * evidence-at-the-boundary C2, because the search pipeline owes the same
 * answer on its own zero-result path and two copies of it would drift.
 * This gate keeps its own wiring - a vault plus a config path, resolved
 * inside the probe's guard so a resolution failure is reported as
 * `coverage-unavailable` like every other unreadable input.
 *
 * It supplies no retraction evidence and asserts nothing, which is why
 * this surface declares only {@link RECALL_GATE_NEGATIVE_STATES}: a gate
 * that reads no claim graph has no grounds for `did_not_happen`.
 */
async function assessNegativeRecall(ctx: ServerContext): Promise<NegativeRecallVerdict> {
  return probeRetrievalCorpus(() =>
    resolveSearchConfig({ vault: ctx.vault, configPath: ctx.configPath ?? undefined }),
  );
}

const RECALL_FEEDBACK_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    query: {
      type: "string",
      minLength: 1,
      maxLength: 2000,
      description: "The query that produced the judged result; re-run to recover its layer scores.",
    },
    result_path: {
      type: "string",
      minLength: 1,
      maxLength: 512,
      description: "Vault path of the single result being judged.",
    },
    verdict: {
      type: "string",
      enum: ["up", "down"],
      description: "'up' when the result was useful, 'down' when it was not.",
    },
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
          description: "The benchmark cases, one per scored query. Non-empty.",
          items: {
            type: "object",
            required: ["id", "query", "expected"],
            properties: {
              id: {
                type: "string",
                minLength: 1,
                description: "Stable case id, reported back in per_query.",
              },
              query: { type: "string", minLength: 1, description: "The query text to run." },
              expected: {
                type: "array",
                minItems: 1,
                items: { type: "string", minLength: 1 },
                description: "Vault paths a correct answer must surface. Non-empty.",
              },
              k: {
                type: "integer",
                minimum: 1,
                maximum: MCP_LIMIT_MAX,
                description: "Per-case cutoff, overriding the run-wide k.",
              },
              answer: {
                type: "string",
                minLength: 1,
                description:
                  "Reference answer text; enables answer-containment scoring for this case.",
              },
            },
          },
        },
      },
      required: ["queries"],
    },
    k: {
      type: "integer",
      minimum: 1,
      maximum: MCP_LIMIT_MAX,
      description: "Run-wide rank depth for hit@k and the containment metrics. Default 5.",
    },
    expand: {
      type: "boolean",
      description:
        "Route every query through deterministic expansion before scoring. Default false.",
    },
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
    file_path: {
      type: "string",
      minLength: 1,
      maxLength: 1024,
      description:
        "Path of the file about to be read; its basename, stem and parent directory become the query terms.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: MCP_LIMIT_MAX,
      description: "How many prior-work hits to return. Default 5.",
    },
    min_bytes: {
      type: "integer",
      minimum: 0,
      maximum: 10_000_000,
      description:
        "Skip files smaller than this, reporting the reason instead of an empty hit. Default 1500.",
    },
    agent_scope: AGENT_SCOPE_SCHEMA,
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
    const agentScope = coerceAgentScope(ctx, args, false);
    const outcome = await fileContextRecall(config, {
      ...(agentScope !== undefined ? { agentScope } : {}),
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
    agent_scope: AGENT_SCOPE_SCHEMA,
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
  const expandScope = coerceAgentScope(ctx, args, false);
  const config = resolveSearchConfig({
    vault: ctx.vault,
    configPath: ctx.configPath ?? undefined,
  });
  let result;
  try {
    result = await withTimeout(
      expandHit(config, {
        chunkId: rawChunk,
        ...(expandScope !== undefined ? { agentScope: expandScope } : {}),
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
      "Classify whether an automatic recall attempt should run. Diagnostics only; does not search. Pass `scores` AND `match_quality` TOGETHER for an adequacy verdict — sufficient/proceed, weak/re_recall, insufficient/abstain; either alone is INVALID_PARAMS (see `dependentRequired`).",
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
    //
    // `warnings` used to be dropped with the rest, which is how an
    // agent driving the vault entirely over MCP could not observe
    // embedding-ABI drift at any setting short of `fail`
    // (context-integrity-gates, Unit E): the drift line, the
    // instruction-prefix line and the "sqlite-vec unavailable" line all
    // died here. It is now spread back in only when non-empty, so a
    // healthy vault's block is byte-identical and the token cost lands
    // exactly on the vaults that have something to say. The structured
    // `embedding_abi` field rides through in `rest` on the same
    // condition, so an agent can branch instead of matching text.
    const {
      embedding_signature: _embeddingSignature,
      estimated_refresh_cost_usd: _estimatedRefreshCostUsd,
      warnings,
      ...rest
    } = serializeIndexStatus(snap);
    const reportable = Array.isArray(warnings) ? warnings : [];
    return reportable.length > 0 ? { ...rest, warnings: reportable } : rest;
  } catch (e) {
    return { exists: false, error: e instanceof Error ? e.message : String(e) };
  }
}
