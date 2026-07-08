/**
 * Read-only lookups: preference/topic/log queries, per-agent views, backlinks, audit trail, sources dashboard, and unlinked mentions.
 *
 * Extracted from the former brain-tools.ts monolith; registration
 * happens through the aggregator, which preserves the public
 * BRAIN_TOOLS surface.
 */

import { buildBacklinkIndex } from "../../core/brain/backlinks.ts";
import { readPrefAudit } from "../../core/brain/pref-audit.ts";
import { aggregateSources } from "../../core/brain/portability/sources.ts";
import { findUnlinkedMentions } from "../../core/brain/link-graph/unlinked-mentions.ts";
import { normaliseWikilinkTarget } from "../../core/brain/wikilink.ts";
import {
  BrainNotFoundError,
  queryByLogSince,
  queryByPreference,
  queryByTopic,
} from "../../core/brain/query.ts";
import { diffAgentSources, type AgentSourceDiffMode } from "../../core/brain/agent-source/diff.ts";
import { queryAgentSources } from "../../core/brain/agent-source/query.ts";
import type { AgentSourceContributionKind } from "../../core/brain/agent-source/types.ts";
import {
  type BrainPreference,
  type BrainRetired,
  type BrainSignal,
} from "../../core/brain/types.ts";
import type { BrainLogEntry } from "../../core/brain/log.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import type { ServerContext, ToolDefinition } from "../tools.ts";
import { MCP_PREVIEW_BUDGET } from "../preview-budget.ts";
import {
  coerceStr,
  coerceStrList,
  coerceBoolOptional,
  coerceIsoDate,
  coerceFormat,
  coerceInt,
  coerceStringOptional,
} from "../coerce.ts";
import { emitGatedTelemetry } from "../../core/brain/continuity/emit.ts";
import { emitRecallTelemetry } from "../../core/brain/recall-telemetry.ts";
import { loadGuardrailsConfigSafe } from "../../core/brain/policy.ts";
import { normalizeAgentScope } from "../../core/graph/agent-scope.ts";
import { isPreferenceVisible } from "../../core/brain/owner-scoped-facts.ts";

async function toolBrainQuery(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const preference = coerceStr(args, "preference", false);
  const topic = coerceStr(args, "topic", false);
  const since = coerceIsoDate(args, "since");
  // `format` is accepted for forward-compat (design doc §9.2 names it),
  // but the structured response shape is identical regardless — the
  // caller serialises however they want. We validate the value to catch
  // typos early.
  coerceFormat(args);

  const supplied = [preference, topic, since].filter((v) => v !== null).length;
  if (supplied === 0) {
    throw new MCPError(
      INVALID_PARAMS,
      "brain_query requires exactly one of: preference, topic, since",
    );
  }
  if (supplied > 1) {
    throw new MCPError(
      INVALID_PARAMS,
      "brain_query accepts at most one of: preference, topic, since",
    );
  }

  // Recall telemetry (t_405b8053): per-call opt-in mirroring
  // brain_search. The payload carries the query KIND only - never the
  // supplied preference id / topic slug / timestamp value.
  const telemetry = coerceBoolOptional(args, "telemetry") ?? false;
  const telemetryHost = coerceStringOptional(args, "telemetry_host", 200) ?? "mcp";
  const telemetrySessionId = coerceStringOptional(args, "session_id", 512);
  const telemetryTurnId = coerceStringOptional(args, "turn_id", 512);
  const queryKind = preference !== null ? "preference" : topic !== null ? "topic" : "since";

  // Owner-scoped fact recall (Knowledge Provenance suite, v1.7). Off by
  // default: when the guardrail flag is off (or no scope is requested) the
  // scope is null and every fact is visible exactly as before.
  const requestedScope = coerceStr(args, "agent_scope", false);
  const ownerScope = loadGuardrailsConfigSafe(ctx.vault).owner_scoped_facts
    ? normalizeAgentScope(requestedScope ?? undefined)
    : null;

  const startedAtMs = Date.now();
  const emitQueryTelemetry = (status: "ok" | "empty" | "error", resultCount: number): void => {
    // Lazy emit kernel (t_5d7aa7c5): gate off = thunk never runs; a
    // throwing continuity write can never fail the query itself.
    emitGatedTelemetry(telemetry || undefined, () =>
      emitRecallTelemetry(ctx.vault, {
        host: telemetryHost,
        ...(telemetrySessionId !== undefined ? { sessionId: telemetrySessionId } : {}),
        ...(telemetryTurnId !== undefined ? { turnId: telemetryTurnId } : {}),
        mode: "query",
        status,
        durationMs: Date.now() - startedAtMs,
        resultCount,
        gaps:
          status === "error" ? ["query_error"] : status === "empty" ? ["no_matching_context"] : [],
        metadata: { query_kind: queryKind },
      }),
    );
  };

  try {
    if (preference !== null) {
      try {
        const res = queryByPreference(ctx.vault, preference);
        // Fail closed: an owner-private fact outside the requested scope is
        // indistinguishable from absent, so it cannot leak across owners.
        // Only active preferences carry an owner; a retired record is shared.
        const prefOwner =
          res.preference.kind === "brain-preference" ? res.preference.owner : undefined;
        if (ownerScope !== null && !isPreferenceVisible({ owner: prefOwner }, ownerScope)) {
          throw new BrainNotFoundError(`preference not found: ${preference}`);
        }
        emitQueryTelemetry(res.evidence.length > 0 ? "ok" : "empty", res.evidence.length);
        return {
          mode: "preference",
          preference: serializePreference(res.preference),
          evidence: res.evidence.map(serializeLogEntry),
        };
      } catch (exc) {
        if (exc instanceof BrainNotFoundError) {
          throw new Error(exc.message, { cause: exc });
        }
        throw exc;
      }
    }

    if (topic !== null) {
      // Expiration opt-in (C5): default drops memories past their
      // expiration_date; show_expired re-includes them for audit.
      const showExpired = coerceBoolOptional(args, "show_expired") ?? false;
      const res = queryByTopic(ctx.vault, topic, { showExpired });
      const resultCount = res.signals.length + res.all_log_events.length;
      emitQueryTelemetry(resultCount > 0 ? "ok" : "empty", resultCount);
      const topicPrefOwner =
        res.preference && res.preference.kind === "brain-preference"
          ? res.preference.owner
          : undefined;
      const topicPrefVisible =
        res.preference !== null &&
        res.preference !== undefined &&
        (ownerScope === null || isPreferenceVisible({ owner: topicPrefOwner }, ownerScope));
      return {
        mode: "topic",
        topic,
        signals: res.signals.map(serializeSignal),
        preference: topicPrefVisible ? serializePreference(res.preference!) : null,
        all_log_events: res.all_log_events.map(serializeLogEntry),
      };
    }

    // since
    const res = queryByLogSince(ctx.vault, since!);
    emitQueryTelemetry(res.length > 0 ? "ok" : "empty", res.length);
    return {
      mode: "since",
      since: since!.toISOString(),
      events: res.map(serializeLogEntry),
    };
  } catch (exc) {
    emitQueryTelemetry("error", 0);
    throw exc;
  }
}

// ----- brain_agent_query / brain_agent_diff --------------------------------

async function toolBrainAgentQuery(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const topic = coerceStr(args, "topic", false);
  const query = coerceStr(args, "query", false);
  const kind = coerceAgentContributionKind(args, "kind");
  return queryAgentSources(ctx.vault, {
    agents: coerceStrList(args, "agents"),
    ...(topic !== null ? { topic } : {}),
    ...(query !== null ? { query } : {}),
    ...(kind !== null ? { kind } : {}),
    limit: coerceInt(args, "limit", 50, 1, 500),
  }) as unknown as Record<string, unknown>;
}

async function toolBrainAgentDiff(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const mode = coerceAgentDiffMode(args, "mode");
  const topic = coerceStr(args, "topic", false);
  const query = coerceStr(args, "query", false);
  const kind = coerceAgentContributionKind(args, "kind");
  return diffAgentSources(ctx.vault, {
    ...(mode !== null ? { mode } : {}),
    agents: coerceStrList(args, "agents"),
    ...(topic !== null ? { topic } : {}),
    ...(query !== null ? { query } : {}),
    ...(kind !== null ? { kind } : {}),
    limit: coerceInt(args, "limit", 50, 1, 500),
  }) as unknown as Record<string, unknown>;
}

function coerceAgentContributionKind(
  args: Record<string, unknown>,
  key: string,
): AgentSourceContributionKind | null {
  const raw = coerceStr(args, key, false);
  if (raw === null) return null;
  if (raw !== "signal" && raw !== "preference" && raw !== "log") {
    throw new MCPError(
      INVALID_PARAMS,
      `argument '${key}' must be 'signal', 'preference', or 'log'`,
    );
  }
  return raw;
}

function coerceAgentDiffMode(
  args: Record<string, unknown>,
  key: string,
): AgentSourceDiffMode | null {
  const raw = coerceStr(args, key, false);
  if (raw === null) return null;
  if (raw !== "browse" && raw !== "search" && raw !== "diff" && raw !== "map") {
    throw new MCPError(
      INVALID_PARAMS,
      `argument '${key}' must be 'browse', 'search', 'diff', or 'map'`,
    );
  }
  return raw;
}

// ----- brain_backlinks -----------------------------------------------------

async function toolBrainBacklinks(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const id = coerceStr(args, "id", true)!;
  // The index is keyed by normalised wikilink targets. Run callers'
  // input through the same normaliser so `pref-foo`, `[[pref-foo]]`,
  // `[[pref-foo|Alias]]`, and `Brain/preferences/pref-foo.md` all
  // resolve to the same lookup.
  const target = normaliseWikilinkTarget(id);
  const index = buildBacklinkIndex(ctx.vault);
  const refs = index.get(target) ?? [];
  return {
    id: target,
    count: refs.length,
    refs: refs.map((r) => ({
      source: r.source,
      source_kind: r.sourceKind,
      field: r.field,
      ...(r.timestamp !== undefined ? { timestamp: r.timestamp } : {}),
    })),
  };
}

async function toolBrainAudit(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const raw = coerceStr(args, "pref_id", true)!;
  // The trail is keyed by the original `pref-<slug>` id. Run the input
  // through the shared wikilink normaliser first (handles `[[id]]`,
  // `[[id|Alias]]`, and `Brain/.../id.md` forms), then strip the
  // pref-/ret- prefix so every reference resolves to one trail.
  const slug = normaliseWikilinkTarget(raw)
    .replace(/^(?:pref-|ret-)/, "")
    .trim();
  if (slug.length === 0) {
    throw new Error(`brain_audit: empty preference slug after normalising '${raw}'`);
  }
  const prefId = `pref-${slug}`;
  const { records, warnings } = readPrefAudit(ctx.vault, prefId);
  return {
    pref_id: prefId,
    count: records.length,
    records,
    warnings: warnings.map((w) => w.message),
  };
}

async function toolBrainSources(
  ctx: ServerContext,
  _args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  void _args;
  const report = aggregateSources(ctx.vault);
  return {
    sources: report.sources,
    total_active: report.total_active,
    total_processed: report.total_processed,
  };
}

/**
 * Raw-text mentions of a target's title / aliases that are NOT
 * already inside `[[...]]` wikilinks. Read-only walker over
 * `Brain/preferences/` and `Brain/retired/`. Match boundary is
 * Unicode-aware (`\p{L}`, `\p{N}`), language-agnostic.
 */
async function toolBrainUnlinkedMentions(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const idRaw = args["id"];
  if (typeof idRaw !== "string" || idRaw.trim().length === 0) {
    throw new MCPError(INVALID_PARAMS, "brain_unlinked_mentions: id must be a non-empty string");
  }
  const targetId = normaliseWikilinkTarget(idRaw);
  // Limit coercion mirrors the v0.10.16 `brain_operator_summary`
  // precedent: accept either a number or a strict integer-literal
  // string (`"5"` ok; `"abc"`, `"3abc"`, `"2.5"` rejected). This
  // keeps the MCP boundary uniform across new tools.
  const limitRaw = args["limit"];
  let limit: number | undefined;
  if (limitRaw !== undefined && limitRaw !== null) {
    if (typeof limitRaw === "number") {
      if (!Number.isInteger(limitRaw) || limitRaw < 1) {
        throw new MCPError(
          INVALID_PARAMS,
          "brain_unlinked_mentions: limit must be a positive integer",
        );
      }
      limit = limitRaw;
    } else if (typeof limitRaw === "string") {
      const trimmed = limitRaw.trim();
      if (trimmed === "" || !/^[0-9]+$/.test(trimmed)) {
        throw new MCPError(
          INVALID_PARAMS,
          "brain_unlinked_mentions: limit must be a positive integer",
        );
      }
      const parsed = Number.parseInt(trimmed, 10);
      if (parsed < 1) {
        throw new MCPError(
          INVALID_PARAMS,
          "brain_unlinked_mentions: limit must be a positive integer",
        );
      }
      limit = parsed;
    } else {
      throw new MCPError(
        INVALID_PARAMS,
        "brain_unlinked_mentions: limit must be a positive integer",
      );
    }
  }
  const mentions = findUnlinkedMentions(ctx.vault, targetId, limit !== undefined ? { limit } : {});
  return {
    vault_path: ctx.vault,
    target_id: targetId,
    mentions: mentions.map((m) => ({
      source: m.source,
      line: m.line,
      term: m.term,
      context: m.contextSnippet,
    })),
  };
}

// ----- brain_foresight (t_08a79c81) -----------------------------------------

function serializeSignal(s: BrainSignal): Record<string, unknown> {
  return {
    kind: s.kind,
    id: s.id,
    created_at: s.created_at,
    topic: s.topic,
    signal: s.signal,
    agent: s.agent,
    principle: s.principle,
    tags: [...s.tags],
    ...(s.scope !== undefined ? { scope: s.scope } : {}),
    ...(s.source !== undefined ? { source: [...s.source] } : {}),
    ...(s.raw !== undefined ? { raw: s.raw } : {}),
    ...(s.expiration_date !== undefined ? { expiration_date: s.expiration_date } : {}),
  };
}

function serializePreference(p: BrainPreference | BrainRetired): Record<string, unknown> {
  if (p.kind === "brain-retired") {
    return {
      kind: p.kind,
      id: p.id,
      status: p.status,
      retired_at: p.retired_at,
      retired_reason: p.retired_reason,
      retired_by: p.retired_by,
      ...(p.superseded_by !== undefined ? { superseded_by: p.superseded_by } : {}),
      created_at: p.created_at,
      topic: p.topic,
      ...(p.scope !== undefined ? { scope: p.scope } : {}),
      principle: p.principle,
      evidenced_by: [...p.evidenced_by],
      applied_count: p.applied_count,
      violated_count: p.violated_count,
      last_evidence_at: p.last_evidence_at,
      confidence: p.confidence,
      confidence_value: p.confidence_value,
      pinned: p.pinned,
      tags: [...p.tags],
      ...(p.aliases !== undefined ? { aliases: [...p.aliases] } : {}),
    };
  }
  return {
    kind: p.kind,
    id: p.id,
    created_at: p.created_at,
    confirmed_at: p.confirmed_at,
    unconfirmed_until: p.unconfirmed_until,
    topic: p.topic,
    ...(p.scope !== undefined ? { scope: p.scope } : {}),
    status: p.status,
    principle: p.principle,
    evidenced_by: [...p.evidenced_by],
    applied_count: p.applied_count,
    violated_count: p.violated_count,
    last_evidence_at: p.last_evidence_at,
    confidence: p.confidence,
    confidence_value: p.confidence_value,
    pinned: p.pinned,
    tags: [...p.tags],
    ...(p.supersedes !== undefined ? { supersedes: p.supersedes } : {}),
    ...(p.aliases !== undefined ? { aliases: [...p.aliases] } : {}),
    ...(p.expiration_date !== undefined ? { expiration_date: p.expiration_date } : {}),
  };
}

function serializeLogEntry(e: BrainLogEntry): Record<string, unknown> {
  // Preserve the structured payload verbatim (array values stay arrays).
  // JSON.stringify handles `ReadonlyArray<string>` and string values
  // identically. `Object.entries` widens the value type to `unknown` for
  // generic-keyed records under `verbatimModuleSyntax`; narrow explicitly.
  const body: Record<string, string | ReadonlyArray<string>> = {};
  for (const [k, v] of Object.entries(e.body) as ReadonlyArray<
    readonly [string, string | ReadonlyArray<string>]
  >) {
    body[k] = Array.isArray(v) ? [...v] : v;
  }
  return {
    timestamp: e.timestamp,
    event_type: e.eventType,
    body,
  };
}

// ----- Misc ----------------------------------------------------------------

const BRAIN_QUERY_OUTPUT_SCHEMA: NonNullable<ToolDefinition["outputSchema"]> = {
  type: "object",
  required: ["mode"],
  properties: {
    mode: { type: "string", enum: ["preference", "topic", "since"] },
  },
};

// ----- brain_operator_summary (v0.10.16) -----------------------------------

export const QUERY_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: "brain_query",
    previewBudget: MCP_PREVIEW_BUDGET,
    description:
      "Read-only lookup: one preference + its evidence trail, all artifacts under a topic, or every log event after a timestamp. Exactly one of `preference`, `topic`, `since` must be supplied.",
    inputSchema: {
      type: "object",
      properties: {
        preference: {
          type: "string",
          description:
            "Preference id (`pref-...` or `ret-...`) to look up with its evidence trail.",
        },
        topic: {
          type: "string",
          description: "Topic slug to aggregate signals + active/retired preference + log events.",
        },
        show_expired: {
          type: "boolean",
          description:
            "Topic mode only: include memories past their `expiration_date`. Default false (expired memories are silently dropped from the result).",
        },
        since: {
          type: "string",
          description: "ISO-8601 timestamp; returns every Brain log event with timestamp >= since.",
        },
        format: {
          type: "string",
          enum: ["markdown", "json"],
          description:
            "Reserved for forward-compat; the structured response is the same regardless.",
        },
        telemetry: {
          type: "boolean",
          description:
            "Opt-in recall telemetry: emit one continuity record (mode 'query', kind-only payload) for this call.",
        },
        telemetry_host: { type: "string", maxLength: 200 },
        session_id: { type: "string", maxLength: 512 },
        turn_id: { type: "string", maxLength: 512 },
        agent_scope: {
          type: "string",
          description:
            "Optional owner scope: with owner_scoped_facts on, an owner-tagged fact returns only to its own scope; ownerless facts always match. Absent = no filtering.",
        },
      },
      additionalProperties: false,
    },
    outputSchema: BRAIN_QUERY_OUTPUT_SCHEMA,
    handler: toolBrainQuery,
  },
  {
    name: "brain_agent_query",
    previewBudget: MCP_PREVIEW_BUDGET,
    description:
      "Read-only source-agent retrieval over Brain provenance. Filters by agents, topic, free-text query, contribution kind, and limit; returns deterministic matched contributions plus a summary.",
    inputSchema: {
      type: "object",
      properties: {
        agents: {
          type: "array",
          items: { type: "string" },
          description: "Agent ids to query. Omit or pass [] to query all known agents.",
        },
        topic: {
          type: "string",
          description: "Exact Brain topic filter.",
        },
        query: {
          type: "string",
          description:
            "Case-insensitive substring matched against deterministic contribution text.",
        },
        kind: {
          type: "string",
          enum: ["signal", "preference", "log"],
          description: "Contribution kind filter.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          description: "Maximum contributions returned. Defaults to 50.",
        },
      },
      additionalProperties: false,
    },
    handler: toolBrainAgentQuery,
  },
  {
    name: "brain_agent_diff",
    description:
      "Read-only comparison between source agents using the same provenance foundation as brain_agent_query. Supports browse, search, diff, and map modes.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["browse", "search", "diff", "map"],
          description:
            "Comparison mode. Defaults to search when query is supplied, otherwise browse.",
        },
        agents: {
          type: "array",
          items: { type: "string" },
          description: "Agent ids to compare. Omit or pass [] to compare all known agents.",
        },
        topic: {
          type: "string",
          description: "Exact Brain topic filter.",
        },
        query: {
          type: "string",
          description:
            "Case-insensitive substring matched against deterministic contribution text.",
        },
        kind: {
          type: "string",
          enum: ["signal", "preference", "log"],
          description: "Contribution kind filter.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          description: "Maximum contributions returned before comparison. Defaults to 50.",
        },
      },
      additionalProperties: false,
    },
    handler: toolBrainAgentDiff,
  },
  {
    name: "brain_backlinks",
    previewBudget: MCP_PREVIEW_BUDGET,
    description:
      "List inbound references to a Brain artifact id (preference, retired, or signal). Returns every source that points at the id via wikilink, in any preference/retired frontmatter field, body prose, signal source, or log payload. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "Target id (e.g. `pref-foo`, `ret-bar`, `sig-2026-05-14-baz`). Wikilink decoration is stripped if present.",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: toolBrainBacklinks,
  },
  {
    name: "brain_audit",
    previewBudget: MCP_PREVIEW_BUDGET,
    description:
      "Return a preference's full mutation audit trail (create / promote / update / retire / merge), oldest first, with agent, reason, and revisions. Accepts pref-/ret-/bare/wikilink ids. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        pref_id: {
          type: "string",
          description:
            "Preference id (e.g. `pref-foo`). `ret-foo`, bare `foo`, and `[[pref-foo]]` all resolve to the same trail.",
        },
      },
      required: ["pref_id"],
      additionalProperties: false,
    },
    handler: toolBrainAudit,
  },
  {
    name: "brain_sources",
    description:
      "Read-only dashboard of the brain's signals grouped by (agent, source_type) with active/processed and distinct-topic counts plus totals.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: toolBrainSources,
  },
  {
    name: "brain_unlinked_mentions",
    previewBudget: MCP_PREVIEW_BUDGET,
    description:
      "Raw-text mentions of a target's title / aliases that are NOT already inside `[[...]]`. Walks Brain/preferences and Brain/retired; match boundary is Unicode-aware (codepoint class), language-agnostic. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "Target id (e.g. `pref-foo`, `ret-bar`). Wikilink decoration is stripped if present.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          description:
            "Maximum number of mentions to return. Defaults to 100; the scanner stops as soon as the cap is hit.",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: toolBrainUnlinkedMentions,
  },
]);
