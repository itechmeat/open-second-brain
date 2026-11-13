/**
 * Read-only lookups: preference/topic/log queries, per-agent views, backlinks, audit trail, sources dashboard, and unlinked mentions.
 *
 * Extracted from the former brain-tools.ts monolith; registration
 * happens through the aggregator, which preserves the public
 * BRAIN_TOOLS surface.
 */

import {
  BrainNotFoundError,
  queryByLogSince,
  queryByPreference,
  queryByTopic,
} from "../../core/brain/query.ts";
import { parseIsoUtc } from "../../core/brain/health/iso-time.ts";
import { queryAgentSources } from "../../core/brain/agent-source/query.ts";
import { NOTE_WRITE_OPS } from "../../core/brain/notes/write-record.ts";
import { AGENT_SOURCE_CONTRIBUTION_KINDS } from "../../core/brain/agent-source/types.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import { contextReach } from "../tool-contract.ts";
import type { ServerContext, ToolDefinition } from "../tool-contract.ts";
import { MCP_PREVIEW_BUDGET } from "../preview-budget.ts";
import {
  coerceAgentScope,
  coerceStr,
  coerceStrList,
  coerceBoolOptional,
  coerceIsoDate,
  coerceFormat,
  coerceInt,
  coerceStringOptional,
} from "../coerce.ts";
import { emitGatedTelemetry } from "../../core/brain/continuity/emit.ts";
import {
  emitRecallTelemetry,
  RECALL_CHANNEL,
  recallTelemetryEnvelope,
} from "../../core/brain/recall-telemetry.ts";
import { loadGuardrailsConfigSafe } from "../../core/brain/policy.ts";
import { normalizeAgentScope } from "../../core/graph/agent-scope.ts";
import { isPreferenceVisible } from "../../core/brain/owner-scoped-facts.ts";
import { reachView } from "../../core/brain/reach-view.ts";
import { logEntriesAtReach, recordRefs } from "../../core/brain/log-events-at-reach.ts";
import { pageSlice } from "../../core/brain/offset-cursor.ts";
import { deliveryView } from "./reach-events.ts";
import { cursorOffsetArg, CURSOR_SCHEMA } from "./pagination.ts";
import {
  serializeLogEntry,
  shapeContribution,
  shapePreferencePayload,
  shapeSignalPayload,
} from "./query-serialize.ts";
import {
  coerceAgentContributionKind,
  toolBrainAgentDiff,
  toolBrainAudit,
  toolBrainBacklinks,
  toolBrainSources,
} from "./query-agent-tools.ts";
import {
  BRAIN_WRITES_ACTIONS,
  toolBrainWriteDestinations,
  toolBrainWrites,
} from "./query-writes-tools.ts";
import { toolBrainUnlinkedMentions } from "./query-unlinked-tools.ts";

// ----- delivery shaping (delivery-trust, lane A) ----------------------------
//
// The report-shaped reads share one binding per request
// (`deliveryView`, beside `requestRefView` in reach-events.ts): local
// reach is a byte-identical no-op, remote reach probes the named page's
// provenance through the binding's shared cache and fences through the
// K1 shaper. These helpers only decide WHICH vault-relative page a
// payload's provenance is probed from.

/** Accepted `at` forms, named in every refusal so the exit is actionable. */
const AS_OF_FORMS = "an ISO-8601 instant or YYYY-MM-DD date";

/**
 * The as-of instant the expiration filter is evaluated against.
 *
 * `queryByTopic` has taken a `now` option since C5 and this handler
 * dropped it, so an agent could ask to SEE lapsed memories
 * (`show_expired`) but never to ask what the brain held at an instant.
 * Only topic mode runs that filter, so an `at` supplied beside
 * `preference` / `since` is refused rather than quietly ignored, and an
 * unparseable one is refused rather than coerced to the wall clock -
 * which would answer a different question without saying so.
 */
const EXPIRY_ARG_SCOPE = "only applies to topic mode (the expiration filter runs there)";

/**
 * `show_expired` shares `at`'s scope: both steer the one expiration
 * filter, and that filter runs in topic mode alone. Its schema already
 * said so while the handler read it in topic mode and ignored it
 * everywhere else, so a caller asking to see lapsed memories beside
 * `preference` got the documented answer's opposite in silence. Two
 * arguments with one scope now refuse on the same terms.
 */
function assertExpiryArgScope(args: Record<string, unknown>, topicMode: boolean): void {
  if (topicMode) return;
  if (coerceBoolOptional(args, "show_expired") === undefined) return;
  throw new MCPError(INVALID_PARAMS, `brain_query: 'show_expired' ${EXPIRY_ARG_SCOPE}`);
}

function coerceAsOf(args: Record<string, unknown>, topicMode: boolean): Date | null {
  const raw = coerceStr(args, "at", false);
  if (raw === null) return null;
  if (!topicMode) {
    throw new MCPError(INVALID_PARAMS, `brain_query: 'at' ${EXPIRY_ARG_SCOPE}`);
  }
  const atMs = parseIsoUtc(raw);
  if (!Number.isFinite(atMs)) {
    throw new MCPError(INVALID_PARAMS, `brain_query: 'at' must be ${AS_OF_FORMS}; got ${raw}`);
  }
  return new Date(atMs);
}

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

  assertExpiryArgScope(args, topic !== null);
  const asOf = coerceAsOf(args, topic !== null);

  // Recall telemetry (t_405b8053): per-call opt-in mirroring
  // brain_search. The payload carries the query KIND only - never the
  // supplied preference id / topic slug / timestamp value.
  const telemetry = coerceBoolOptional(args, "telemetry") ?? false;
  const telemetrySessionId = coerceStringOptional(args, "session_id", 512);
  const telemetryTurnId = coerceStringOptional(args, "turn_id", 512);
  const telemetryEnvelope = recallTelemetryEnvelope({
    host: coerceStringOptional(args, "telemetry_host", 200) ?? RECALL_CHANNEL.mcp,
    channel: RECALL_CHANNEL.mcp,
    ...(telemetrySessionId !== undefined ? { sessionId: telemetrySessionId } : {}),
    ...(telemetryTurnId !== undefined ? { turnId: telemetryTurnId } : {}),
  });
  const queryKind = preference !== null ? "preference" : topic !== null ? "topic" : "since";

  // Owner-scoped fact recall (Knowledge Provenance suite, v1.7). Off by
  // default: when the guardrail flag is off (or no scope is requested) the
  // scope is null and every fact is visible exactly as before.
  const requestedScope = coerceAgentScope(ctx, args, false);
  const ownerScope = loadGuardrailsConfigSafe(ctx.vault).owner_scoped_facts
    ? normalizeAgentScope(requestedScope)
    : null;

  // Root C's rule over the reference-shaped rows this tool returns:
  // a signal, a log event and a preference each NAME an artifact, and a
  // row naming one the caller may not see discloses it by naming it.
  const queryView = reachView(ctx.vault, contextReach(ctx));
  // The delivery binding (delivery-trust, lane A): one reach resolution
  // and one frontmatter cache for every payload body this tool returns.
  const delivery = deliveryView(ctx);

  const startedAtMs = Date.now();
  const emitQueryTelemetry = (status: "ok" | "empty" | "error", resultCount: number): void => {
    // Lazy emit kernel (t_5d7aa7c5): gate off = thunk never runs; a
    // throwing continuity write can never fail the query itself.
    emitGatedTelemetry(telemetry || undefined, () =>
      emitRecallTelemetry(ctx.vault, {
        ...telemetryEnvelope,
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
        // Asked before the page is parsed: a withheld page that fails to
        // parse would otherwise answer with the parser's error, which
        // names the page an absent id never could.
        if (!queryView.row(...recordRefs(preference))) {
          throw new BrainNotFoundError(preference);
        }
        const res = queryByPreference(ctx.vault, preference);
        // Fail closed: an owner-private fact outside the requested scope is
        // indistinguishable from absent, so it cannot leak across owners.
        // Retirement KEEPS ownership (context-integrity-gates, A7), so a
        // retired record is read through the same predicate as an active
        // one - retiring a memory must not publish it.
        const prefOwner = res.preference.owner;
        // Both refusals carry the CALLER'S OWN ARGUMENT, which is what
        // `queryByPreference` throws for a preference that does not
        // exist. `BrainNotFoundError` formats the sentence itself, so
        // passing a sentence to it produced "...found for id 'preference
        // not found: pref-x'" against the absent form's "...for id
        // 'pref-x'" - two messages, over a `pref-<slug>` key space a
        // caller can enumerate, which is exactly the existence oracle the
        // comment claimed was closed.
        if (ownerScope !== null && !isPreferenceVisible({ owner: prefOwner }, ownerScope)) {
          throw new BrainNotFoundError(preference);
        }
        if (!queryView.visible(res.preference.id)) {
          throw new BrainNotFoundError(preference);
        }
        const evidence = logEntriesAtReach(queryView, res.evidence);
        emitQueryTelemetry(evidence.length > 0 ? "ok" : "empty", evidence.length);
        return {
          mode: "preference",
          preference: shapePreferencePayload(delivery, res.preference),
          evidence: evidence.map(serializeLogEntry),
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
      // expiration_date; show_expired re-includes them for audit, and
      // `at` moves the clock that filter compares against.
      const showExpired = coerceBoolOptional(args, "show_expired") ?? false;
      const res = queryByTopic(ctx.vault, topic, {
        showExpired,
        transportReach: contextReach(ctx),
        ...(asOf !== null ? { now: asOf } : {}),
      });
      // Filter BEFORE the count, as the `since` branch below does. The
      // count is written to the vault's recall-telemetry log and handed
      // back verbatim by `brain_recall_telemetry`, so a pre-filter number
      // tells the caller how many rows it was not shown - a count oracle
      // reached through a second tool rather than this one.
      const signals = queryView.keep(res.signals, (sig) => [sig.id]);
      const logEvents = logEntriesAtReach(queryView, res.all_log_events);
      const resultCount = signals.length + logEvents.length;
      emitQueryTelemetry(resultCount > 0 ? "ok" : "empty", resultCount);
      const topicPrefOwner = res.preference?.owner;
      const topicPrefVisible =
        res.preference !== null &&
        res.preference !== undefined &&
        (ownerScope === null || isPreferenceVisible({ owner: topicPrefOwner }, ownerScope));
      return {
        mode: "topic",
        topic,
        signals: signals.map((s) => shapeSignalPayload(delivery, ctx.vault, s)),
        preference: topicPrefVisible ? shapePreferencePayload(delivery, res.preference!) : null,
        all_log_events: logEvents.map(serializeLogEntry),
      };
    }

    // since
    const res = queryByLogSince(ctx.vault, since!);
    const events = logEntriesAtReach(queryView, res);
    emitQueryTelemetry(events.length > 0 ? "ok" : "empty", events.length);
    return {
      mode: "since",
      since: since!.toISOString(),
      events: events.map(serializeLogEntry),
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
  // Owner-scope isolation (context-integrity-gates, Unit A): the
  // provenance view reads the same preference and retired pages the
  // delivery surfaces do, so it honours the same ownership rule.
  const ownerScope = coerceAgentScope(ctx, args, false);
  const limit = coerceInt(args, "limit", 50, 1, 500);
  const offset = cursorOffsetArg("brain_agent_query", args);
  // Cursor paging is cut at this layer: the core query slices from the
  // first match, so the full matched set is fetched (the collection pass
  // already reads every page) and one offset window is taken here.
  const full = queryAgentSources(ctx.vault, {
    agents: coerceStrList(args, "agents"),
    ...(topic !== null ? { topic } : {}),
    ...(query !== null ? { query } : {}),
    ...(kind !== null ? { kind } : {}),
    ...(ownerScope !== undefined ? { ownerScope } : {}),
    // A note contribution echoes the write event's body, which carries
    // the page's digest and size: a page the caller may not read at its
    // reach is withheld exactly as an absent one.
    view: reachView(ctx.vault, contextReach(ctx)),
    limit: Number.MAX_SAFE_INTEGER,
  });
  const page = pageSlice(full.contributions, offset, limit);
  // Delivery shaping (delivery-trust, lane A): the note-write bodies and
  // the principle echoes ride the request's one binding; log rows pass
  // through untouched.
  const delivery = deliveryView(ctx);
  return {
    mode: full.mode,
    // `filters.limit` echoes the PAGE size the caller asked for, not the
    // internal fetch-all width the core query ran at.
    filters: { ...full.filters, limit },
    available_agents: full.available_agents,
    unknown_agents: full.unknown_agents,
    total_matched: full.total_matched,
    returned: page.items.length,
    contributions: page.items.map((c) => shapeContribution(delivery, ctx.vault, c)),
    // The core already computed the summary over the WHOLE matched set
    // (the fetch-all above), so it does not move between pages - the
    // same whole-set semantics the sibling `brain_agent_diff` keeps.
    summary: full.summary,
    next_cursor: page.next_cursor,
  };
}

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
    kind: "read",
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
        at: {
          type: "string",
          description:
            "Topic mode only: evaluate `expiration_date` as of this instant, so a memory that lapsed after it comes back. ISO-8601 instant or YYYY-MM-DD. Default now.",
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
    kind: "read",
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
          enum: [...AGENT_SOURCE_CONTRIBUTION_KINDS],
          description: "Contribution kind filter.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          description: "Maximum contributions returned. Defaults to 50.",
        },
        cursor: CURSOR_SCHEMA,
        agent_scope: {
          type: "string",
          description:
            "Optional owner scope: a contribution whose page declares an `owner:` returns only to its own scope; ownerless ones always match. Absent = no filtering.",
        },
      },
      additionalProperties: false,
    },
    handler: toolBrainAgentQuery,
  },
  {
    name: "brain_writes",
    kind: "read",
    previewBudget: MCP_PREVIEW_BUDGET,
    description:
      "List recorded note writes (create, update, append, revert), newest first, with the agent, the device the log shard names, the target path and the content digest on each side. Filters by agent, device, path, op and time window. plan_revert returns the sealed plan for undoing them. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [...BRAIN_WRITES_ACTIONS],
          description:
            "list returns recorded writes. plan_revert returns the sealed undo plan; applying it is CLI-only.",
        },
        agent: {
          type: "string",
          description: "Exact agent identity that recorded the write.",
        },
        device: {
          type: "string",
          description: "Exact device id; the empty string is the legacy un-sharded log.",
        },
        path: {
          type: "string",
          description: "Exact vault-relative target path of the note.",
        },
        since: {
          type: "string",
          description: "Inclusive lower bound: YYYY-MM-DD or an ISO-8601 UTC timestamp.",
        },
        until: {
          type: "string",
          description: "Inclusive upper bound, same two spellings; a bare date covers its day.",
        },
        op: {
          type: "string",
          enum: [...NOTE_WRITE_OPS],
          description: "Operation filter.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          description: "Maximum writes returned. Defaults to 50.",
        },
        cursor: CURSOR_SCHEMA,
      },
      additionalProperties: false,
    },
    handler: toolBrainWrites,
  },
  {
    name: "brain_write_destinations",
    kind: "read",
    description:
      "One row per vault-relative destination the note-write and write-session events " +
      "name, with per-kind counts, contributing agents and devices, newest touch, and a " +
      "kinds coverage field (derived write sites emit neither kind). Filters: agent, " +
      "device, path, since/until; default 7-day window. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        agent: {
          type: "string",
          description: "Exact agent identity that recorded the write.",
        },
        device: {
          type: "string",
          description: "Exact device id; the empty string is the legacy un-sharded log.",
        },
        path: {
          type: "string",
          description: "Exact vault-relative target path of the note.",
        },
        since: {
          type: "string",
          description:
            "Inclusive lower bound: YYYY-MM-DD or an ISO-8601 UTC timestamp. Default window is the last 7 days.",
        },
        until: {
          type: "string",
          description: "Inclusive upper bound, same two spellings; a bare date covers its day.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          description: "Maximum destination rows returned. Defaults to 50.",
        },
        cursor: CURSOR_SCHEMA,
      },
      additionalProperties: false,
    },
    handler: toolBrainWriteDestinations,
  },
  {
    name: "brain_agent_diff",
    kind: "read",
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
          enum: [...AGENT_SOURCE_CONTRIBUTION_KINDS],
          description: "Contribution kind filter.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          description:
            "Maximum contributions returned per page; the per-agent and topic aggregates always cover the whole matched set, not just this page. Defaults to 50.",
        },
        cursor: CURSOR_SCHEMA,
      },
      additionalProperties: false,
    },
    handler: toolBrainAgentDiff,
  },
  {
    name: "brain_backlinks",
    kind: "read",
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
    kind: "read",
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
    kind: "read",
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
    kind: "read",
    previewBudget: MCP_PREVIEW_BUDGET,
    description:
      "Raw-text mentions of a target's title / aliases not already inside `[[...]]`; walks the active and retired preferences. Boundaries are Unicode-aware and language-agnostic. `total` is exact once the walk exhausts; mid-walk it reports the page's scan bound, never a silent cap. Read-only.",
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
            "Maximum mentions on one page. Defaults to 100; walk further with the returned `next_cursor`.",
        },
        cursor: CURSOR_SCHEMA,
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: toolBrainUnlinkedMentions,
  },
]);
